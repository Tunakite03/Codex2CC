import assert from "node:assert/strict";
import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect } from "node:net";
import test from "node:test";
import { createGatewayServer, listenOnLoopback, resolveModelSlug, type GatewayOptions } from "./gateway.js";

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
    session: { accessToken: async () => "upstream-token", accountId: () => "acct_1" },
    defaultModel: "gpt-6-sol",
    availableModels: [{ slug: "gpt-6-sol", displayName: "GPT-6 Sol" }, { slug: "gpt-6.1-sol", displayName: "GPT-6.1 Sol" }],
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

const CHAT_REQUEST = { model: "claude-sonnet-4", max_tokens: 64, messages: [{ role: "user", content: "hi" }] };

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

test("gateway lists the account models plus the Claude aliases", async () => {
  await withGateway(replyWithStream(HELLO_STREAM), async (gateway) => {
    const body = await (await fetch(`${gateway.base}/v1/models`, { headers: AUTH })).json() as { data: Array<{ id: string }>; first_id: string };
    const ids = body.data.map((model) => model.id);
    assert.deepEqual(ids.slice(0, 2), ["gpt-6-sol", "gpt-6.1-sol"]);
    assert.ok(ids.includes("claude-3-7-sonnet-20250219"));
    assert.equal(body.first_id, "gpt-6-sol");
  });
});

test("gateway streams an Anthropic response and forwards the mapped model with upstream credentials", async () => {
  await withGateway(replyWithStream(HELLO_STREAM), async (gateway, upstream) => {
    const response = await post(gateway, { ...CHAT_REQUEST, stream: true, system: "Be brief." });
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
    const body = JSON.parse(sent.body) as { model: string; stream: boolean; store: boolean; instructions: string };
    assert.deepEqual({ model: body.model, stream: body.stream, store: body.store, instructions: body.instructions }, {
      model: "gpt-6-sol",
      stream: true,
      store: false,
      instructions: "Be brief.",
    });
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

test("resolveModelSlug prefers an exact slug, maps Claude tiers, and falls back to the default", () => {
  const slugs = new Set(["gpt-6-sol", "gpt-6.1-sol", "gpt-5.6-sol"]);
  assert.equal(resolveModelSlug("gpt-5.6-sol", "gpt-6-sol", slugs), "gpt-5.6-sol");
  assert.equal(resolveModelSlug("claude-opus-4", "gpt-6-sol", slugs), "gpt-6.1-sol");
  assert.equal(resolveModelSlug("claude-sonnet-4", "gpt-5.6-sol", slugs), "gpt-6-sol");
  assert.equal(resolveModelSlug("claude-haiku-4", "gpt-6-sol", slugs), "gpt-5.6-sol");
  assert.equal(resolveModelSlug("something-else", "gpt-6-sol", slugs), "gpt-6-sol");
  assert.equal(resolveModelSlug(undefined, "gpt-6-sol", slugs), "gpt-6-sol");
  assert.equal(resolveModelSlug("claude-opus-4", "gpt-6-sol", new Set(["gpt-6-sol"])), "gpt-6-sol");
});
