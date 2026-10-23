import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { BridgeError } from "../bridge/bridge.js";
import { defaultApiProviderConfig } from "./config.js";
import { discoverApiModels, modelsUrlFor, toDiscoveredModels } from "./discovery.js";

type Recorded = { readonly url: string; readonly headers: IncomingMessage["headers"] };

async function withUpstream(
  respond: (url: URL, response: ServerResponse) => void,
  run: (base: string, requests: Recorded[]) => Promise<void>,
): Promise<void> {
  const requests: Recorded[] = [];
  const server = createServer((request, response) => {
    requests.push({ url: request.url ?? "", headers: request.headers });
    respond(new URL(request.url ?? "/", "http://127.0.0.1"), response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`, requests);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
}

const signal = new AbortController().signal;

test("model list URL is derived from the configured resource endpoint", () => {
  assert.equal(modelsUrlFor("https://openrouter.ai/api/v1/chat/completions", "chat-completions").href, "https://openrouter.ai/api/v1/models");
  assert.equal(modelsUrlFor("https://api.openai.com/v1/responses", "responses").href, "https://api.openai.com/v1/models");
  assert.equal(modelsUrlFor("https://api.anthropic.com/v1/messages", "anthropic-messages").href, "https://api.anthropic.com/v1/models");
  assert.equal(modelsUrlFor("https://opencode.ai/inference/anthropic/v1/messages", "anthropic-messages").pathname, "/inference/anthropic/v1/models");
});

test("model list URL refuses endpoints that do not end with the protocol resource", () => {
  assert.throws(
    () => modelsUrlFor("https://example.com/v1/completions", "chat-completions"),
    (error: unknown) => error instanceof BridgeError && error.code === "model_discovery_unsupported",
  );
});

test("discovered models keep chat-capable slugs and report the ones the catalog cannot hold", () => {
  const { models, skipped } = toDiscoveredModels([
    { id: "gpt-x", display_name: "GPT X", context_length: 128000 },
    { id: "text-embedding-3-small" },
    { id: "gpt-4o-mini-tts" },
    { id: "gpt-image-1" },
    { id: "gpt-x" },
    { id: "bad slug" },
    { id: "plain", max_input_tokens: 200000 },
  ], "responses");
  assert.deepEqual(models.map((model) => model.slug), ["gpt-x", "plain"]);
  assert.deepEqual(models[0], { slug: "gpt-x", displayName: "GPT X", protocol: "responses", reasoning: "none", contextWindow: 128000 });
  assert.equal(models[1]!.displayName, "plain");
  assert.equal(models[1]!.contextWindow, 200000);
  assert.deepEqual(skipped, ["bad slug"]);
});

test("OpenAI-style discovery sends the configured Bearer key to the derived list URL", async () => {
  const body = { object: "list", data: [{ id: "gpt-5.5" }, { id: "text-embedding-3-large" }] };
  await withUpstream((_url, response) => json(response, 200, body), async (base, requests) => {
    const config = { ...defaultApiProviderConfig("openai"), endpoints: { responses: `${base}/v1/responses` } };
    const models = await discoverApiModels("openai", config, { OPENAI_API_KEY: "fixture-key" }, signal);
    assert.deepEqual(models.map((model) => [model.slug, model.protocol]), [["gpt-5.5", "responses"]]);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.url, "/v1/models");
    assert.equal(requests[0]!.headers.authorization, "Bearer fixture-key");
  });
});

test("Anthropic discovery follows the after_id cursor with the native key header", async () => {
  await withUpstream((url, response) => {
    if (url.searchParams.get("after_id") === null) json(response, 200, { data: [{ id: "claude-a", display_name: "Claude A" }], has_more: true, last_id: "claude-a" });
    else json(response, 200, { data: [{ id: "claude-b", display_name: "Claude B" }], has_more: false, last_id: "claude-b" });
  }, async (base, requests) => {
    const config = { ...defaultApiProviderConfig("anthropic"), endpoints: { "anthropic-messages": `${base}/v1/messages` } };
    const models = await discoverApiModels("anthropic", config, { ANTHROPIC_API_KEY: "fixture-key" }, signal);
    assert.deepEqual(models.map((model) => [model.displayName, model.protocol]), [["Claude A", "anthropic-messages"], ["Claude B", "anthropic-messages"]]);
    assert.equal(requests.length, 2);
    assert.equal(requests[0]!.url, "/v1/models?limit=1000");
    assert.equal(requests[1]!.url, "/v1/models?limit=1000&after_id=claude-a");
    assert.equal(requests[0]!.headers["x-api-key"], "fixture-key");
    assert.equal(requests[0]!.headers["anthropic-version"], "2023-06-01");
    assert.equal(requests[0]!.headers.authorization, undefined);
  });
});

test("provider rejections and malformed model lists fail with typed errors", async () => {
  const config = defaultApiProviderConfig("openai");
  await withUpstream((_url, response) => json(response, 401, { error: { message: "invalid key" } }), async (base) => {
    const endpoints = { responses: `${base}/v1/responses` };
    await assert.rejects(
      discoverApiModels("openai", { ...config, endpoints }, { OPENAI_API_KEY: "fixture-key" }, signal),
      (error: unknown) => error instanceof BridgeError && error.status === 401 && error.code === "model_discovery_failed",
    );
  });
  await withUpstream((_url, response) => json(response, 200, { models: [] }), async (base) => {
    const endpoints = { responses: `${base}/v1/responses` };
    await assert.rejects(
      discoverApiModels("openai", { ...config, endpoints }, { OPENAI_API_KEY: "fixture-key" }, signal),
      (error: unknown) => error instanceof BridgeError && error.code === "invalid_model_list",
    );
  });
});
