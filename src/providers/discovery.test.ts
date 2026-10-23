import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { BridgeError } from "../bridge/bridge.js";
import { MODEL_CATALOG_LIMIT, defaultApiProviderConfig, type ApiModel } from "./config.js";
import { discoverApiModels, mergeDiscoveredModels, modelsUrlFor, toDiscoveredModels } from "./discovery.js";

function chatModel(slug: string): ApiModel {
  return { slug, displayName: slug, protocol: "chat-completions", reasoning: "none" };
}

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
  ], "responses", []);
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

test("tool-capable free models rank first, then tool-capable paid models, then the rest", () => {
  const { models } = toDiscoveredModels([
    { id: "paid-new", created: 300, pricing: { prompt: "0.000001", completion: "0.000002" }, supported_parameters: ["tools"] },
    { id: "free-notools", created: 100, pricing: { prompt: "0", completion: "0" }, supported_parameters: ["max_tokens"] },
    { id: "vendor/model:free", created: 50 },
    { id: "free-tools-old", created: 10, pricing: { prompt: "0", completion: "0" }, supported_parameters: ["tools"] },
    { id: "paid-tools-old", created: 20, pricing: { prompt: "0.000001", completion: "0.000002" }, supported_parameters: ["tools"] },
    { id: "paid-plain", created: 500 },
  ], "chat-completions", []);
  assert.deepEqual(models.map((model) => model.slug), ["free-tools-old", "paid-new", "paid-tools-old", "free-notools", "vendor/model:free", "paid-plain"]);
});

test("models whose output is not text alone are never catalogued", () => {
  const { models, skipped } = toDiscoveredModels([
    { id: "google/lyria-fixture", pricing: { prompt: "0", completion: "0" }, architecture: { output_modalities: ["text", "audio"] } },
    { id: "text-only-fixture", architecture: { output_modalities: ["text"] } },
  ], "chat-completions", []);
  assert.deepEqual(models.map((model) => model.slug), ["text-only-fixture"]);
  assert.deepEqual(skipped, []);
});

test("catalog merge keeps existing entries, fills free slots in order and counts what it leaves out", () => {
  const merged = mergeDiscoveredModels([chatModel("a"), chatModel("b")], [chatModel("b"), chatModel("c"), chatModel("d"), chatModel("e")], 4);
  assert.deepEqual(merged.models.map((model) => model.slug), ["a", "b", "c", "d"]);
  assert.equal(merged.added, 2);
  assert.equal(merged.omitted, 1);
  const full = mergeDiscoveredModels([chatModel("a"), chatModel("b"), chatModel("c")], [chatModel("d")], 2);
  assert.deepEqual(full.models.map((model) => model.slug), ["a", "b", "c"]);
  assert.equal(full.added, 0);
  assert.equal(full.omitted, 1);
});

test("OpenRouter-sized listings are ranked and merged to the catalog limit with the newest paid models kept", async () => {
  const entries = Array.from({ length: 250 }, (_unused, index) => ({
    id: index === 7 ? `vendor-${index}/model-${index}:free` : `vendor-${index}/model-${index}`,
    created: index,
    pricing: { prompt: index === 5 ? "0" : "0.000001", completion: index === 5 ? "0" : "0.000002" },
    supported_parameters: ["tools"],
  }));
  entries[3] = { id: "anthropic/claude-sonnet-4.6", created: 3, pricing: { prompt: "0.000001", completion: "0.000002" }, supported_parameters: ["tools"] };
  await withUpstream((_url, response) => json(response, 200, { data: entries }), async (base, requests) => {
    const config = { ...defaultApiProviderConfig("openrouter"), endpoints: { "chat-completions": `${base}/api/v1/chat/completions` } };
    const discovered = await discoverApiModels("openrouter", config, { OPENROUTER_API_KEY: "fixture-key" }, signal);
    assert.equal(requests[0]!.url, "/api/v1/models");
    const merged = mergeDiscoveredModels(config.models, discovered, MODEL_CATALOG_LIMIT);
    assert.equal(merged.models.length, MODEL_CATALOG_LIMIT);
    assert.equal(merged.models[0]!.slug, "anthropic/claude-sonnet-4.6");
    assert.deepEqual(merged.models.slice(1, 3).map((model) => model.slug), ["vendor-7/model-7:free", "vendor-5/model-5"]);
    assert.equal(merged.models.some((model) => model.slug === "vendor-249/model-249"), true);
    assert.equal(merged.added, MODEL_CATALOG_LIMIT - 1);
    assert.equal(merged.omitted, 249 - (MODEL_CATALOG_LIMIT - 1));
  });
});

test("usage order puts tool-capable models first in rank order and ignores ids the provider does not list", () => {
  const { models } = toDiscoveredModels([
    { id: "free-tools-new", created: 999, pricing: { prompt: "0", completion: "0" }, supported_parameters: ["tools"] },
    { id: "ranked-second", created: 1, pricing: { prompt: "0.000001", completion: "0.000002" }, supported_parameters: ["tools"] },
    { id: "ranked-first", created: 2, pricing: { prompt: "0.000001", completion: "0.000002" }, supported_parameters: ["tools"] },
    { id: "ranked-no-tools", created: 3, pricing: { prompt: "0.000001", completion: "0.000002" } },
  ], "chat-completions", ["ranked-first", "ranked-no-tools", "ranked-second", "not-listed"]);
  assert.deepEqual(models.map((model) => model.slug), ["ranked-first", "ranked-second", "free-tools-new", "ranked-no-tools"]);
});

test("discovery promotes models from the built-in OpenRouter usage list above newer free models", async () => {
  const entries = [
    { id: "recursive/flint-v1.0:free", created: 1792622765, pricing: { prompt: "0", completion: "0" }, supported_parameters: ["tools"] },
    { id: "anthropic/claude-sonnet-5.5", created: 1, pricing: { prompt: "0.000003", completion: "0.000015" }, supported_parameters: ["tools"] },
    { id: "deepseek/deepseek-v4.1-flash", created: 2, pricing: { prompt: "0.00000015", completion: "0.0000006" }, supported_parameters: ["tools"] },
  ];
  await withUpstream((_url, response) => json(response, 200, { data: entries }), async (base) => {
    const config = { ...defaultApiProviderConfig("openrouter"), endpoints: { "chat-completions": `${base}/api/v1/chat/completions` } };
    const models = await discoverApiModels("openrouter", config, { OPENROUTER_API_KEY: "fixture-key" }, signal);
    assert.deepEqual(models.map((model) => model.slug), ["deepseek/deepseek-v4.1-flash", "anthropic/claude-sonnet-5.5", "recursive/flint-v1.0:free"]);
  });
});
