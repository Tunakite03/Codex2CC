import assert from "node:assert/strict";
import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect } from "node:net";
import test from "node:test";
import { createGatewayServer, listenOnLoopback, type GatewayOptions } from "./gateway.js";
import { getLogs } from "../telemetry/logger.js";
import { getTokenUsageStats, resetTokenUsage } from "../telemetry/usage.js";

const TOKEN = "test-token-0123456789";
const AUTH = { Authorization: `Bearer ${TOKEN}` };

type RecordedRequest = { headers: IncomingHttpHeaders; body: string };
type UpstreamHandler = (request: IncomingMessage, response: ServerResponse, attempt: number) => void;

type Upstream = { url: string; requests: RecordedRequest[]; close: () => Promise<void> };

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function startUpstream(handler: UpstreamHandler): Promise<Upstream> {
  const requests: RecordedRequest[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({ headers: request.headers, body: Buffer.concat(chunks).toString("utf8") });
      handler(request, response, requests.length);
    });
  });
  const port = await listenOnLoopback(server, 0);
  return { url: `http://127.0.0.1:${port}/responses`, requests, close: () => closeServer(server) };
}

function sse(...events: object[]): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

const HELLO_STREAM = sse(
  { type: "response.created", response: { id: "resp_1" } },
  { type: "response.output_text.delta", delta: "Hello" },
  { type: "response.output_text.done" },
  { type: "response.completed", response: { id: "resp_1", usage: { input_tokens: 3, output_tokens: 2 } } },
);

function replyWithStream(body: string): UpstreamHandler {
  return (_request, response) => {
    response.writeHead(200, { "Content-Type": "text/event-stream" }).end(body);
  };
}

type Gateway = { base: string; port: number; close: () => Promise<void> };

async function startGateway(upstreamUrl: string, overrides: Partial<GatewayOptions> = {}): Promise<Gateway> {
  const server = createGatewayServer({
    session: { accessToken: async () => "upstream-token", refreshAfterRejection: async () => "refreshed-token", accountId: () => "acct_1" },
    defaultModel: "gpt-6-sol",
    availableModels: [{ slug: "gpt-6-sol", displayName: "GPT-6 Sol", contextWindow: 1000000 }, { slug: "gpt-6.1-sol", displayName: "GPT-6.1 Sol", contextWindow: 1000000 }, { slug: "gpt-6-astra", displayName: "GPT-6 Astra", contextWindow: 1000000 }],
    policy: { mode: "token", token: TOKEN },
    upstreamUrl,
    ...overrides,
  });
  const port = await listenOnLoopback(server, 0);
  return { base: `http://127.0.0.1:${port}`, port, close: () => closeServer(server) };
}

async function withGateway(
  handler: UpstreamHandler,
  run: (gateway: Gateway, upstream: Upstream) => Promise<void>,
  overrides: Partial<GatewayOptions> = {},
): Promise<void> {
  const upstream = await startUpstream(handler);
  const gateway = await startGateway(upstream.url, overrides);
  try {
    await run(gateway, upstream);
  } finally {
    await gateway.close();
    await upstream.close();
  }
}

function post(gateway: Gateway, body: unknown, headers: Record<string, string> = AUTH): Promise<Response> {
  return fetch(`${gateway.base}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function rawRequest(port: number, options: { method: string; path: string; headers: Record<string, string> }): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: "127.0.0.1", port, ...options }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.once("error", reject);
    request.end();
  });
}

const CHAT_REQUEST = { model: "claude-sonnet-5-5", max_tokens: 64, messages: [{ role: "user", content: "hi" }] };

test("gateway enforces Host and credential checks and never reaches upstream when rejected", async () => {
  await withGateway(replyWithStream(HELLO_STREAM), async (gateway, upstream) => {
    assert.equal((await fetch(`${gateway.base}/v1/models`)).status, 401);
    assert.equal((await fetch(`${gateway.base}/v1/models`, { headers: { Authorization: "Bearer wrong-token" } })).status, 401);
    assert.equal((await fetch(`${gateway.base}/v1/models`, { headers: AUTH })).status, 200);
    assert.equal((await fetch(`${gateway.base}/v1/models`, { headers: { "x-api-key": TOKEN } })).status, 200);
    assert.equal(await rawRequest(gateway.port, { method: "GET", path: "/v1/models", headers: { Host: "evil.example", ...AUTH } }), 403);
    assert.equal(await rawRequest(gateway.port, { method: "HEAD", path: "/api/hello", headers: {} }), 200);
    assert.equal((await post(gateway, CHAT_REQUEST, {})).status, 401);
    assert.equal(upstream.requests.length, 0);
  });
});

test("gateway answers a malformed request target with 400 instead of crashing", async () => {
  await withGateway(replyWithStream(HELLO_STREAM), async (gateway) => {
    const raw = await new Promise<string>((resolve, reject) => {
      const socket = connect(gateway.port, "127.0.0.1", () => {
        socket.write("GET http://[ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
      });
      let data = "";
      socket.on("data", (chunk) => { data += chunk.toString(); });
      socket.once("close", () => resolve(data));
      socket.once("error", reject);
    });
    assert.match(raw, /^HTTP\/1\.1 400/);
    assert.equal((await fetch(`${gateway.base}/v1/models`, { headers: AUTH })).status, 200, "gateway still serving");
  });
});

test("gateway discovery lists only Claude-compatible routes", async () => {
  await withGateway(replyWithStream(HELLO_STREAM), async (gateway) => {
    const body = await (await fetch(`${gateway.base}/v1/models`, { headers: AUTH })).json() as { data: Array<{ id: string; display_name: string; max_input_tokens?: number }>; first_id: string; last_id: string };
    const ids = body.data.map((model) => model.id);
    assert.deepEqual(ids, ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5", "claude-fable-5-1"]);
    assert.deepEqual(body.data.map((model) => model.display_name), [
      "gpt-6-sol (ChatGPT via sonnet route)",
      "gpt-6.1-sol (ChatGPT via opus route)",
      "gpt-6-sol (ChatGPT via haiku route, fallback)",
      "gpt-6-astra (ChatGPT via fable route)",
    ]);
    assert.deepEqual(body.data.map((model) => model.max_input_tokens), [1000000, 1000000, 1000000, 1000000]);
    assert.equal(body.first_id, ids[0]);
    assert.equal(body.last_id, ids[3]);
  });
});

test("gateway streams an Anthropic response and forwards the mapped model with upstream credentials", async () => {
  await withGateway(replyWithStream(HELLO_STREAM), async (gateway, upstream) => {
    const response = await post(gateway, { ...CHAT_REQUEST, stream: true, system: "Be brief.", output_config: { effort: "max" } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    const events = await response.text();
    assert.match(events, /event: message_start/);
    assert.match(events, /"text_delta","text":"Hello"/);
    assert.match(events, /"stop_reason":"end_turn"/);
    assert.match(events, /event: message_stop/);

    assert.equal(upstream.requests.length, 1);
    const sent = upstream.requests[0]!;
    assert.equal(sent.headers.authorization, "Bearer upstream-token");
    assert.equal(sent.headers["chatgpt-account-id"], "acct_1");
    const body = JSON.parse(sent.body) as { model: string; stream: boolean; store: boolean; instructions: string; reasoning: { effort: string } };
    assert.deepEqual({ model: body.model, stream: body.stream, store: body.store, instructions: body.instructions, reasoning: body.reasoning }, {
      model: "gpt-6-sol",
      stream: true,
      store: false,
      instructions: "Be brief.",
      reasoning: { effort: "max" },
    });
  });
});

test("Haiku route forwards reasoning effort to GPT-6 Luna", async () => {
  await withGateway(replyWithStream(HELLO_STREAM), async (gateway, upstream) => {
    const response = await post(gateway, {
      ...CHAT_REQUEST,
      model: "claude-haiku-5",
      output_config: { effort: "xhigh" },
    });
    assert.equal(response.status, 200);
    await response.text();

    const sent = JSON.parse(upstream.requests[0]!.body) as { model: string; reasoning: { effort: string } };
    assert.equal(sent.model, "gpt-6-luna");
    assert.deepEqual(sent.reasoning, { effort: "xhigh" });
  }, {
    availableModels: [
      { slug: "gpt-6-sol", displayName: "GPT-6 Sol", contextWindow: 1000000 },
      { slug: "gpt-6.1-sol", displayName: "GPT-6.1 Sol", contextWindow: 1000000 },
      { slug: "gpt-6-astra", displayName: "GPT-6 Astra", contextWindow: 1000000 },
      { slug: "gpt-6-luna", displayName: "GPT-6 Luna", contextWindow: 1000000 },
    ],
  });
});

test("Haiku route defaults to max effort for GPT-6 Luna when the client omits effort", async () => {
  await withGateway(replyWithStream(HELLO_STREAM), async (gateway, upstream) => {
    const response = await post(gateway, { ...CHAT_REQUEST, model: "claude-haiku-5" });
    assert.equal(response.status, 200);
    await response.text();

    const sent = JSON.parse(upstream.requests[0]!.body) as { model: string; reasoning: { effort: string } };
    assert.equal(sent.model, "gpt-6-luna");
    assert.deepEqual(sent.reasoning, { effort: "max" });

    const sonnetResponse = await post(gateway, CHAT_REQUEST);
    assert.equal(sonnetResponse.status, 200);
    await sonnetResponse.text();

    const sonnetSent = JSON.parse(upstream.requests[1]!.body) as { model: string; reasoning?: { effort: string } };
    assert.equal(sonnetSent.model, "gpt-6-sol");
    assert.equal(sonnetSent.reasoning, undefined);
  }, {
    availableModels: [
      { slug: "gpt-6-sol", displayName: "GPT-6 Sol", contextWindow: 1000000 },
      { slug: "gpt-6.1-sol", displayName: "GPT-6.1 Sol", contextWindow: 1000000 },
      { slug: "gpt-6-astra", displayName: "GPT-6 Astra", contextWindow: 1000000 },
      { slug: "gpt-6-luna", displayName: "GPT-6 Luna", contextWindow: 1000000 },
    ],
  });
});

test("gateway logs requested effort for streamed and non-streamed messages", async () => {
  await withGateway(replyWithStream(HELLO_STREAM), async (gateway) => {
    const sinceId = getLogs().at(-1)?.id ?? 0;
    for (const request of [
      { ...CHAT_REQUEST, stream: true, output_config: { effort: "high" }, reasoning_effort: "low" },
      { ...CHAT_REQUEST, reasoning_effort: "max" },
      CHAT_REQUEST,
    ]) {
      const response = await post(gateway, request);
      assert.equal(response.status, 200);
      await response.text();
    }
    const logs = getLogs({ sinceId });
    assert.deepEqual(logs.filter((entry) => entry.operation === "inbound_request").map((entry) => entry.details?.effort), ["high", "max", "upstream_default"]);
    assert.deepEqual(logs.filter((entry) => entry.operation === "stream_complete" || entry.operation === "message_complete").map((entry) => [entry.operation, entry.details?.effort]), [
      ["stream_complete", "high"],
      ["message_complete", "max"],
      ["message_complete", "upstream_default"],
    ]);
  });
});

test("Fable route sends requests to GPT-6 Astra", async () => {
  await withGateway(replyWithStream(HELLO_STREAM), async (gateway, upstream) => {
    const response = await post(gateway, { ...CHAT_REQUEST, model: "claude-fable-5-1", stream: false });
    assert.equal(response.status, 200);
    assert.equal((JSON.parse(upstream.requests[0]!.body) as { model: string }).model, "gpt-6-astra");
  });
});

test("gateway returns a single JSON message when the client does not stream", async () => {
  await withGateway(replyWithStream(HELLO_STREAM), async (gateway) => {
    const response = await post(gateway, { ...CHAT_REQUEST, stream: false });
    assert.equal(response.status, 200);
    const message = await response.json() as { content: unknown; stop_reason: string; usage: unknown };
    assert.deepEqual(message.content, [{ type: "text", text: "Hello" }]);
    assert.equal(message.stop_reason, "end_turn");
    assert.deepEqual(message.usage, { input_tokens: 3, output_tokens: 2 });
  });
});

test("gateway rejects malformed JSON, invalid messages and oversized bodies with the right status", async () => {
  await withGateway(replyWithStream(HELLO_STREAM), async (gateway, upstream) => {
    const malformed = await post(gateway, "{not json");
    assert.equal(malformed.status, 400);
    assert.equal(((await malformed.json()) as { error: { type: string } }).error.type, "invalid_request_error");

    const invalid = await post(gateway, { model: "claude-sonnet-4" });
    assert.equal(invalid.status, 400);

    const oversized = await post(gateway, { ...CHAT_REQUEST, messages: [{ role: "user", content: "x".repeat(2_000) }] });
    assert.equal(oversized.status, 413);
    assert.equal(upstream.requests.length, 0);
  }, { maxBodyBytes: 500 });
});

test("gateway retries a transient 429 and then succeeds", async () => {
  await withGateway((_request, response, attempt) => {
    if (attempt === 1) {
      response.writeHead(429).end("slow down");
      return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" }).end(HELLO_STREAM);
  }, async (gateway, upstream) => {
    const response = await post(gateway, { ...CHAT_REQUEST, stream: false });
    assert.equal(response.status, 200);
    assert.equal(upstream.requests.length, 2);
  });
});

test("gateway gives up after bounded retries and reports rate limiting", async () => {
  await withGateway((_request, response) => {
    response.writeHead(429).end("slow down");
  }, async (gateway, upstream) => {
    const response = await post(gateway, { ...CHAT_REQUEST, stream: false });
    assert.equal(response.status, 429);
    assert.equal(((await response.json()) as { error: { type: string } }).error.type, "rate_limit_error");
    assert.equal(upstream.requests.length, 3);
  });
});

test("gateway refreshes the session once when upstream answers 401 and retries with the new token", async () => {
  await withGateway((_request, response, attempt) => {
    if (attempt === 1) {
      response.writeHead(401).end("expired");
      return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" }).end(HELLO_STREAM);
  }, async (gateway, upstream) => {
    const response = await post(gateway, { ...CHAT_REQUEST, stream: false });
    assert.equal(response.status, 200);
    assert.deepEqual(upstream.requests.map((sent) => sent.headers.authorization), ["Bearer upstream-token", "Bearer refreshed-token"]);
  });
});

test("gateway reports 401 as an authentication error after a single refresh attempt", async () => {
  await withGateway((_request, response) => {
    response.writeHead(401).end("revoked");
  }, async (gateway, upstream) => {
    const response = await post(gateway, { ...CHAT_REQUEST, stream: false });
    assert.equal(response.status, 401);
    assert.equal(((await response.json()) as { error: { type: string } }).error.type, "authentication_error");
    assert.equal(upstream.requests.length, 2);
  });
});

test("gateway passes an upstream 403 through as a permission error", async () => {
  await withGateway((_request, response) => {
    response.writeHead(403).end("blocked");
  }, async (gateway, upstream) => {
    const response = await post(gateway, { ...CHAT_REQUEST, stream: false });
    assert.equal(response.status, 403);
    assert.equal(((await response.json()) as { error: { type: string } }).error.type, "permission_error");
    assert.equal(upstream.requests.length, 1);
  });
});

test("gateway retries a transient 503 and substitutes the default model for an unknown one", async () => {
  await withGateway((_request, response, attempt) => {
    if (attempt === 1) {
      response.writeHead(503).end("busy");
      return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" }).end(HELLO_STREAM);
  }, async (gateway, upstream) => {
    const response = await post(gateway, { ...CHAT_REQUEST, model: "totally-unknown-model", stream: false });
    assert.equal(response.status, 200);
    assert.equal(upstream.requests.length, 2);
    assert.equal((JSON.parse(upstream.requests[1]!.body) as { model: string }).model, "gpt-6-sol");
  });
});

test("gateway maps an upstream server error to 502 without retrying", async () => {
  await withGateway((_request, response) => {
    response.writeHead(500).end("boom");
  }, async (gateway, upstream) => {
    const response = await post(gateway, { ...CHAT_REQUEST, stream: false });
    assert.equal(response.status, 502);
    const body = await response.json() as { error: { type: string; message: string } };
    assert.equal(body.error.type, "api_error");
    assert.match(body.error.message, /HTTP 500/);
    assert.equal(upstream.requests.length, 1);
  });
});

test("gateway reports a truncated upstream stream as an SSE error event", async () => {
  const truncated = sse({ type: "response.created", response: { id: "resp_1" } }, { type: "response.output_text.delta", delta: "Hel" });
  await withGateway(replyWithStream(truncated), async (gateway) => {
    const response = await post(gateway, { ...CHAT_REQUEST, stream: true });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /event: error\ndata: .*without response\.completed/);
  });
});

test("gateway aborts the upstream request when the client disconnects", async () => {
  let upstreamClosed: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => { upstreamClosed = resolve; });
  await withGateway((_request, response) => {
    response.on("close", upstreamClosed);
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write(sse({ type: "response.created", response: { id: "resp_1" } }));
  }, async (gateway) => {
    const controller = new AbortController();
    const response = await fetch(`${gateway.base}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH },
      body: JSON.stringify({ ...CHAT_REQUEST, stream: true }),
      signal: controller.signal,
    });
    const reader = response.body!.getReader();
    await reader.read();
    controller.abort();
    await reader.cancel().catch(() => undefined);
    const outcome = await Promise.race([
      closed.then(() => "closed"),
      new Promise<string>((resolve) => setTimeout(() => resolve("still open"), 3_000)),
    ]);
    assert.equal(outcome, "closed");
  });
});

test("gateway estimates token counts locally and requires credentials for it", async () => {
  await withGateway(replyWithStream(HELLO_STREAM), async (gateway, upstream) => {
    const body = { model: "claude-sonnet-4", system: "abcd", messages: [{ role: "user", content: "abcdefgh" }] };
    const unauthenticated = await fetch(`${gateway.base}/v1/messages/count_tokens`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    assert.equal(unauthenticated.status, 401);
    const counted = await fetch(`${gateway.base}/v1/messages/count_tokens`, {
      method: "POST", headers: { "Content-Type": "application/json", ...AUTH }, body: JSON.stringify(body),
    });
    assert.equal(counted.status, 200);
    assert.deepEqual(await counted.json(), { input_tokens: 3 });
    assert.equal(upstream.requests.length, 0);
  });
});

test("gateway reports real input and cached tokens in the stream and keeps going past unsupported blocks", async () => {
  const withUsage = sse(
    { type: "response.created", response: { id: "resp_1" } },
    { type: "response.output_text.delta", delta: "ok" },
    { type: "response.completed", response: { id: "resp_1", usage: { input_tokens: 100, output_tokens: 7, input_tokens_details: { cached_tokens: 40 } } } },
  );
  await withGateway(replyWithStream(withUsage), async (gateway, upstream) => {
    const response = await post(gateway, {
      ...CHAT_REQUEST,
      stream: true,
      messages: [{ role: "user", content: [{ type: "text", text: "read it" }, { type: "document", source: { type: "base64", data: "AAAA" } }] }],
    });
    assert.equal(response.status, 200);
    const events = await response.text();
    assert.match(events, /"usage":\{"input_tokens":60,"output_tokens":7,"cache_read_input_tokens":40\}/);
    assert.match(upstream.requests[0]!.body, /Unsupported content block \\"document\\" omitted/);
  });
});

test("gateway records token usage metrics for processed requests", async () => {
  resetTokenUsage();
  await withGateway(replyWithStream(HELLO_STREAM), async (gateway) => {
    const response = await post(gateway, { ...CHAT_REQUEST, stream: false });
    assert.equal(response.status, 200);
    const usage = getTokenUsageStats();
    assert.equal(usage.totalRequests, 1);
    assert.equal(usage.totalInputTokens, 3);
    assert.equal(usage.totalOutputTokens, 2);
    assert.equal(usage.grandTotalTokens, 5);
    assert.equal(usage.models[0]?.model, "gpt-6-sol");
  });
});

test("gateway discovery lists Google Antigravity routes when provider is antigravity", async () => {
  await withGateway(replyWithStream(HELLO_STREAM), async (gateway) => {
    const res = await fetch(`${gateway.base}/v1/models`, { headers: AUTH });
    assert.equal(res.status, 200);
    const body = await res.json() as { data: Array<{ id: string; display_name: string }> };
    assert.match(body.data[0]!.display_name, /Google Antigravity/);
    assert.match(body.data[0]!.display_name, /claude-sonnet-4-6/);
  }, { provider: "antigravity" });
});

test("gateway routes /v1/messages to antigravityRunner when provider is antigravity", async () => {
  let runnerInvoked = false;
  let receivedModel = "";
  const mockRunner = async (opts: { model: string }, onEvent: (ev: any) => void) => {
    runnerInvoked = true;
    receivedModel = opts.model;
    onEvent({
      event: "result",
      result: {
        status: "SUCCESS",
        response: "Response from Antigravity",
        usage: { input_tokens: 5, output_tokens: 4, thinking_tokens: 0, total_tokens: 9 },
      },
    });
  };

  await withGateway(replyWithStream(HELLO_STREAM), async (gateway, upstream) => {
    const response = await post(gateway, { ...CHAT_REQUEST, stream: false });
    assert.equal(response.status, 200);
    assert.equal(runnerInvoked, true);
    assert.equal(receivedModel, "claude-sonnet-4-6");
    assert.equal(upstream.requests.length, 0); // never reached ChatGPT upstream
    const data = await response.json() as { content: Array<{ text: string }> };
    assert.equal(data.content[0]?.text, "Response from Antigravity");
  }, { provider: "antigravity", antigravityRunner: mockRunner });
});

test("UI endpoint /api/ui/provider dynamically switches active provider", async () => {
  await withGateway(replyWithStream(HELLO_STREAM), async (gateway) => {
    // Check initial status
    const statusRes1 = await fetch(`${gateway.base}/api/ui/status`);
    const status1 = await statusRes1.json() as { provider: { active: string } };
    assert.equal(status1.provider.active, "codex");

    // Switch to antigravity
    const switchRes = await fetch(`${gateway.base}/api/ui/provider`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "antigravity" }),
    });
    assert.equal(switchRes.status, 200);
    const switchData = await switchRes.json() as { ok: boolean; provider: string };
    assert.equal(switchData.ok, true);
    assert.equal(switchData.provider, "antigravity");

    // Verify status updated
    const statusRes2 = await fetch(`${gateway.base}/api/ui/status`);
    const status2 = await statusRes2.json() as { provider: { active: string } };
    assert.equal(status2.provider.active, "antigravity");
  });
});

test("UI endpoint blocks cross-origin requests with 403", async () => {
  await withGateway(replyWithStream(HELLO_STREAM), async (gateway) => {
    const res = await fetch(`${gateway.base}/api/ui/provider`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://evil.example.com",
      },
      body: JSON.stringify({ provider: "antigravity" }),
    });
    assert.equal(res.status, 403);
    const body = await res.json() as { type: string; error: { type: string; message: string } };
    assert.equal(body.error.type, "permission_error");
  });
});

test("UI endpoint returns 404 for unknown UI routes", async () => {
  await withGateway(replyWithStream(HELLO_STREAM), async (gateway) => {
    const res = await fetch(`${gateway.base}/api/ui/nonexistent_route`);
    assert.equal(res.status, 404);
  });
});

test("UI endpoint rejects invalid provider with 400", async () => {
  await withGateway(replyWithStream(HELLO_STREAM), async (gateway) => {
    const res = await fetch(`${gateway.base}/api/ui/provider`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "invalid_provider" }),
    });
    assert.equal(res.status, 400);
    const body = await res.json() as { ok: boolean; error: string };
    assert.equal(body.ok, false);
  });
});


