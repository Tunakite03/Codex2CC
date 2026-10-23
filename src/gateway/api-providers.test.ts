import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createGatewayServer, listenOnLoopback, type GatewayOptions } from "./gateway.js";
import { TierModelStore } from "../models/tier-store.js";
import { API_PROVIDERS, defaultApiProviderConfig, type ApiProtocol, type ApiProvider } from "../providers/config.js";
import { getLogs } from "../telemetry/logger.js";

const API_KEY = "fixture-provider-secret-not-for-real-use";
const AUTH = { Authorization: "Bearer fixture-client-token-0123456789" };
const REQUEST = { model: "claude-sonnet-5-5", max_tokens: 64, messages: [{ role: "user", content: "hi" }] };
type Recorded = { readonly url: string; readonly headers: IncomingHttpHeaders; readonly body: string };
type Handler = (request: IncomingMessage, response: ServerResponse, attempt: number) => void;
type Fixture = { readonly base: string; readonly requests: Recorded[]; readonly store: TierModelStore; readonly options: GatewayOptions; readonly upstreamUrl: string };

function sse(events: readonly object[]): string { return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""); }
const RESPONSES = sse([
  { type: "response.created", response: { id: "public-response" } },
  { type: "response.output_text.delta", delta: "Hello API" },
  { type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 3, input_tokens_details: { cached_tokens: 2 } } } },
]);
const CHAT = sse([
  { id: "chat-response", choices: [{ index: 0, delta: { role: "assistant", content: "Hello API" }, finish_reason: null }] },
  { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  { choices: [], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13, prompt_tokens_details: { cached_tokens: 2 } } },
]) + "data: [DONE]\n\n";
const NATIVE = sse([
  { type: "message_start", message: { id: "native-response", usage: { input_tokens: 8, output_tokens: 0, cache_read_input_tokens: 2 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello API" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
  { type: "message_stop" },
]);
function reply(body: string): Handler { return (_request, response) => { response.writeHead(200, { "Content-Type": "text/event-stream" }).end(body); }; }
async function close(server: Server): Promise<void> { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }

async function withProvider(provider: ApiProvider, protocol: ApiProtocol, handler: Handler, run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const requests: Recorded[] = [];
  const upstream = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({ url: request.url ?? "", headers: request.headers, body: Buffer.concat(chunks).toString("utf8") });
      handler(request, response, requests.length);
    });
  });
  const port = await listenOnLoopback(upstream, 0);
  const upstreamUrl = `http://127.0.0.1:${port}`;
  const directory = mkdtempSync(join(tmpdir(), "codex2cc-api-gateway-"));
  const store = TierModelStore.open(join(directory, "settings.json"), {});
  const initial = defaultApiProviderConfig(provider);
  store.saveApiProviderConfig(provider, { ...initial, endpoints: { [protocol]: `${upstreamUrl}/inference` }, defaultModel: "api-model", models: [{ slug: "api-model", displayName: "API model", protocol, reasoning: "none", contextWindow: 32000 }] });
  store.setProvider(provider);
  const options: GatewayOptions = {
    session: { async accessToken() { assert.fail("API providers must not access ChatGPT session"); }, async refreshAfterRejection() { assert.fail("API provider 401 must not refresh ChatGPT session"); }, accountId() { assert.fail("API provider must not read ChatGPT account ID"); } },
    defaultModel: "codex-model", availableModels: [{ slug: "codex-model", displayName: "Codex model" }],
    policy: { mode: "token", token: "fixture-client-token-0123456789" }, tierStore: store,
    providerEnv: { [initial.apiKeyEnv]: API_KEY }, keepAliveMs: 20,
  };
  const gateway = createGatewayServer(options);
  try {
    const gatewayPort = await listenOnLoopback(gateway, 0);
    await run({ base: `http://127.0.0.1:${gatewayPort}`, requests, store, options, upstreamUrl });
  } finally {
    await close(gateway);
    await close(upstream);
    rmSync(directory, { recursive: true, force: true });
  }
}
function post(fixture: Fixture, body: object = REQUEST): Promise<Response> { return fetch(`${fixture.base}/v1/messages`, { method: "POST", headers: { ...AUTH, "Content-Type": "application/json" }, body: JSON.stringify(body) }); }

test("all API providers translate streaming and buffered responses without ChatGPT credentials", async () => {
  const streams: Readonly<Record<ApiProtocol, string>> = { "chat-completions": CHAT, responses: RESPONSES, "anthropic-messages": NATIVE };
  const cases: [ApiProvider, ApiProtocol, string][] = API_PROVIDERS.map((provider) => {
    const config = defaultApiProviderConfig(provider);
    const protocol = config.models.find((model) => model.slug === config.defaultModel)!.protocol;
    return [provider, protocol, streams[protocol]];
  });
  for (const provider of ["opencode", "custom"] as const) {
    for (const protocol of ["chat-completions", "responses", "anthropic-messages"] as const) {
      if (!cases.some(([candidate, adapter]) => candidate === provider && adapter === protocol)) cases.push([provider, protocol, streams[protocol]]);
    }
  }
  for (const [provider, protocol, upstream] of cases) await withProvider(provider, protocol, reply(upstream), async (fixture) => {
    const buffered = await post(fixture);
    assert.equal(buffered.status, 200, await buffered.clone().text());
    const message = await buffered.json() as { model: string; content: object[]; stop_reason: string; usage: object };
    assert.equal(message.model, "api-model");
    assert.deepEqual(message.content, [{ type: "text", text: "Hello API" }]);
    assert.equal(message.stop_reason, "end_turn");
    assert.deepEqual(message.usage, { input_tokens: 8, output_tokens: 3, cache_read_input_tokens: 2 });
    const streamed = await post(fixture, { ...REQUEST, stream: true });
    const text = await streamed.text();
    assert.equal(streamed.status, 200, text);
    assert.match(text, /event: message_start/);
    assert.match(text, /Hello API/);
    assert.match(text, /event: message_stop/);
    assert.equal(fixture.requests.length, 2);
    for (const sent of fixture.requests) {
      assert.equal(sent.headers["chatgpt-account-id"], undefined);
      if (protocol === "anthropic-messages") {
        assert.equal(sent.headers["x-api-key"], API_KEY);
        assert.equal(sent.headers["anthropic-version"], "2023-06-01");
      } else assert.equal(sent.headers.authorization, `Bearer ${API_KEY}`);
      const body = JSON.parse(sent.body) as { model: string; stream: boolean; max_tokens?: number; max_completion_tokens?: number; max_output_tokens?: number };
      assert.equal(body.model, "api-model");
      assert.equal(body.stream, true);
      assert.equal(protocol === "responses" ? body.max_output_tokens : body.max_completion_tokens ?? body.max_tokens, 64);
    }
  });
});

test("API model discovery, token counting and persisted provider selection use the configured catalog", async () => {
  await withProvider("openrouter", "chat-completions", reply(CHAT), async (fixture) => {
    const discovered = await (await fetch(`${fixture.base}/v1/models`, { headers: AUTH })).json() as { data: Array<{ display_name: string; max_input_tokens: number }> };
    assert.equal(discovered.data.length, 4);
    assert.ok(discovered.data.every((model) => model.display_name.includes("api-model (OpenRouter") && model.max_input_tokens === 32000));
    const count = await fetch(`${fixture.base}/v1/messages/count_tokens`, { method: "POST", headers: { ...AUTH, "Content-Type": "application/json" }, body: JSON.stringify(REQUEST) });
    assert.equal(count.status, 200);
    assert.ok((await count.json() as { input_tokens: number }).input_tokens > 0);
    assert.equal(fixture.requests.length, 0);
  });
});

test("missing or malformed API key is a local error and never calls upstream", async () => {
  await withProvider("openai", "responses", reply(RESPONSES), async (fixture) => {
    delete fixture.options.providerEnv!.OPENAI_API_KEY;
    const response = await post(fixture);
    assert.equal(response.status, 401);
    assert.match(await response.text(), /OPENAI_API_KEY/);
    assert.equal(fixture.requests.length, 0);
    fixture.options.providerEnv!.OPENAI_API_KEY = "bad\nkey";
    assert.equal((await post(fixture)).status, 400);
    assert.equal(fixture.requests.length, 0);
  });
});

test("provider 401 is not retried and errors never expose its API key", async () => {
  await withProvider("openai", "responses", (_request, response) => response.writeHead(401).end(JSON.stringify({ error: { code: "invalid_api_key", message: `Rejected ${API_KEY}` } })), async (fixture) => {
    const response = await post(fixture);
    assert.equal(response.status, 401);
    const body = await response.text();
    assert.match(body, /REDACTED/);
    assert.ok(!body.includes(API_KEY));
    assert.equal(fixture.requests.length, 1);
    assert.ok(!JSON.stringify(getLogs({})).includes(API_KEY));
  });
});

test("provider rate limits pass Retry-After through without gateway retries", async () => {
  await withProvider("openrouter", "chat-completions", (_request, response) => response.writeHead(429, { "Retry-After": "120" }).end(JSON.stringify({ error: { message: "quota exhausted", code: 429 } })), async (fixture) => {
    const response = await post(fixture);
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("retry-after"), "120");
    assert.equal(fixture.requests.length, 1);
  });
});

test("provider temporary failures retry a bounded number of times before reading the stream", async () => {
  await withProvider("openai", "responses", (_request, response, attempt) => {
    if (attempt < 3) response.writeHead(503).end("temporarily unavailable");
    else response.writeHead(200, { "Content-Type": "text/event-stream" }).end(RESPONSES);
  }, async (fixture) => {
    const response = await post(fixture);
    assert.equal(response.status, 200);
    await response.text();
    assert.equal(fixture.requests.length, 3);
  });
  await withProvider("openai", "responses", (_request, response) => response.writeHead(503).end("unavailable"), async (fixture) => {
    assert.equal((await post(fixture)).status, 502);
    assert.equal(fixture.requests.length, 3);
  });
});

test("redirects do not forward API credentials to another endpoint", async () => {
  await withProvider("openai", "responses", (_request, response) => response.writeHead(307, { Location: "/credential-sink" }).end(), async (fixture) => {
    assert.equal((await post(fixture)).status, 502);
    assert.ok(fixture.requests.every((request) => request.url === "/inference"));
    assert.equal(fixture.requests.length, 3);
  });
});

test("provider context overflow becomes the compaction error and output limits fail locally", async () => {
  await withProvider("openai", "responses", (_request, response) => response.writeHead(400).end(JSON.stringify({ error: { code: "context_length_exceeded", message: "maximum context length" } })), async (fixture) => {
    const response = await post(fixture);
    assert.equal(response.status, 400);
    assert.match(await response.text(), /prompt is too long/);
    const config = fixture.store.getApiProviderConfig("openai");
    fixture.store.saveApiProviderConfig("openai", { ...config, models: config.models.map((model) => ({ ...model, maxOutputTokens: 32 })) });
    const limited = await post(fixture);
    assert.equal(limited.status, 400);
    assert.match(await limited.text(), /output limit/);
    assert.equal(fixture.requests.length, 1);
  });
});

test("malformed, truncated and wrong-content-type provider streams fail instead of reporting success", async () => {
  for (const body of ['data: {"choices":"wrong"}\n\n', sse([{ choices: [{ index: 0, delta: { content: "unfinished" }, finish_reason: null }] }])]) {
    await withProvider("openrouter", "chat-completions", reply(body), async (fixture) => { assert.equal((await post(fixture)).status, 502); });
  }
  await withProvider("openai", "responses", (_request, response) => response.writeHead(200, { "Content-Type": "application/json" }).end('{}'), async (fixture) => { assert.equal((await post(fixture)).status, 502); });
});

test("client cancellation aborts an in-flight API stream", async () => {
  let closed = false;
  let resolveOpened: (() => void) | undefined;
  const opened = new Promise<void>((resolve) => { resolveOpened = resolve; });
  await withProvider("openai", "responses", (_request, response) => {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write(sse([{ type: "response.output_text.delta", delta: "working" }]));
    response.on("close", () => { closed = true; });
    resolveOpened?.();
  }, async (fixture) => {
    const controller = new AbortController();
    const response = await fetch(`${fixture.base}/v1/messages`, { method: "POST", headers: { ...AUTH, "Content-Type": "application/json" }, body: JSON.stringify({ ...REQUEST, stream: true }), signal: controller.signal });
    await opened;
    await response.body!.getReader().read();
    controller.abort();
    for (let attempt = 0; attempt < 30 && !closed; attempt++) await new Promise<void>((resolve) => setTimeout(resolve, 10));
    assert.equal(closed, true);
    assert.equal(fixture.requests.length, 1);
  });
});

test("API tool calls survive a complete HTTP tool-result round trip for every protocol", async () => {
  const responsesTool = sse([
    { type: "response.output_item.added", output_index: 0, item: { type: "function_call", call_id: "tool-1", name: "read" } },
    { type: "response.function_call_arguments.delta", output_index: 0, delta: '{"path":"test"}' },
    { type: "response.output_item.done", output_index: 0, item: { type: "function_call", call_id: "tool-1", name: "read", arguments: '{"path":"test"}' } },
    { type: "response.completed", response: { usage: { input_tokens: 4, output_tokens: 2 } } },
  ]);
  const chatTool = sse([
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "tool-1", type: "function", function: { name: "read", arguments: '{"path":"test"}' } }] }, finish_reason: "tool_calls" }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 4, completion_tokens: 2 } },
  ]) + "data: [DONE]\n\n";
  const nativeTool = sse([
    { type: "message_start", message: { id: "native-tool", usage: { input_tokens: 4, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tool-1", name: "read", input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":"test"}' } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 2 } },
    { type: "message_stop" },
  ]);
  const streams: Readonly<Record<ApiProtocol, readonly [string, string]>> = {
    responses: [responsesTool, RESPONSES], "chat-completions": [chatTool, CHAT], "anthropic-messages": [nativeTool, NATIVE],
  };
  const cases: [ApiProvider, ApiProtocol, string, string][] = API_PROVIDERS.map((provider) => {
    const config = defaultApiProviderConfig(provider);
    const protocol = config.models.find((model) => model.slug === config.defaultModel)!.protocol;
    return [provider, protocol, ...streams[protocol]];
  });
  for (const protocol of ["responses", "anthropic-messages"] as const) cases.push(["custom", protocol, ...streams[protocol]]);
  for (const [provider, protocol, first, second] of cases) await withProvider(provider, protocol, (_request, response, attempt) => {
    response.writeHead(200, { "Content-Type": "text/event-stream" }).end(attempt === 1 ? first : second);
  }, async (fixture) => {
    const tools = [{ name: "read", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }];
    const firstResponse = await post(fixture, { ...REQUEST, tools });
    assert.equal(firstResponse.status, 200, await firstResponse.clone().text());
    const firstMessage = await firstResponse.json() as { content: object[]; stop_reason: string };
    assert.equal(firstMessage.stop_reason, "tool_use");
    assert.deepEqual(firstMessage.content, [{ type: "tool_use", id: "tool-1", name: "read", input: { path: "test" } }]);
    const secondResponse = await post(fixture, { ...REQUEST, tools, messages: [...REQUEST.messages, { role: "assistant", content: firstMessage.content }, { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", content: "file contents" }] }] });
    assert.equal(secondResponse.status, 200);
    await secondResponse.text();
    const sent = fixture.requests[1]!.body;
    assert.match(sent, /tool-1/);
    assert.match(sent, /file contents/);
    assert.match(sent, protocol === "responses" ? /function_call_output/ : protocol === "chat-completions" ? /"role":"tool"/ : /tool_result/);
  });
});

test("midstream API failures send an error without a successful message_stop", async () => {
  const body = sse([
    { choices: [{ index: 0, delta: { content: "partial answer" }, finish_reason: null }] },
    { error: { code: 429, message: `quota failure for ${API_KEY}` } },
  ]);
  await withProvider("openrouter", "chat-completions", reply(body), async (fixture) => {
    const response = await post(fixture, { ...REQUEST, stream: true });
    const text = await response.text();
    assert.match(text, /partial answer/);
    assert.match(text, /event: error/);
    assert.match(text, /rate_limit_error/);
    assert.doesNotMatch(text, /event: message_stop/);
    assert.ok(!text.includes(API_KEY));
    assert.equal(fixture.requests.length, 1);
  });
});

test("a provider switch does not retarget a request already in flight", async () => {
  let release: (() => void) | undefined;
  let opened: (() => void) | undefined;
  const upstreamOpened = new Promise<void>((resolve) => { opened = resolve; });
  await withProvider("openai", "responses", (_request, response) => {
    release = () => { response.writeHead(200, { "Content-Type": "text/event-stream" }).end(RESPONSES); };
    opened?.();
  }, async (fixture) => {
    const pending = post(fixture);
    await upstreamOpened;
    fixture.options.provider = "openrouter";
    fixture.store.setProvider("openrouter");
    release?.();
    const response = await pending;
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { model: string }).model, "api-model");
    assert.equal(fixture.requests.length, 1);
    assert.equal(fixture.requests[0]?.headers.authorization, `Bearer ${API_KEY}`);
    const after = await (await fetch(`${fixture.base}/v1/models`, { headers: AUTH })).json() as { data: Array<{ display_name: string }> };
    assert.ok(after.data.every((model) => model.display_name.includes("OpenRouter")));
  });
});


test("Gemini thought signatures survive a buffered HTTP tool-result round trip", async () => {
  const first = sse([{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "signed-call", type: "function", function: { name: "read", arguments: "{}" }, extra_content: { google: { thought_signature: "opaque-provider-signature" } } }] }, finish_reason: "tool_calls" }] }]) + "data: [DONE]\n\n";
  await withProvider("gemini", "chat-completions", (_request, response, attempt) => {
    response.writeHead(200, { "Content-Type": "text/event-stream" }).end(attempt === 1 ? first : CHAT);
  }, async (fixture) => {
    const tools = [{ name: "read", input_schema: { type: "object", properties: {} } }];
    const initial = await post(fixture, { ...REQUEST, tools });
    assert.equal(initial.status, 200);
    const message = await initial.json() as { content: object[] };
    const continued = await post(fixture, { ...REQUEST, tools, messages: [...REQUEST.messages, { role: "assistant", content: message.content }, { role: "user", content: [{ type: "tool_result", tool_use_id: "signed-call", content: "file" }] }] });
    assert.equal(continued.status, 200);
    await continued.text();
    const sent = JSON.parse(fixture.requests[1]!.body) as { messages: Array<{ role: string; tool_calls?: Array<{ extra_content?: { google?: { thought_signature?: string } } }> }> };
    const assistant = sent.messages.find((message) => message.role === "assistant");
    assert.equal(assistant?.tool_calls?.[0]?.extra_content?.google?.thought_signature, "opaque-provider-signature");
  });
});
