import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BridgeError } from "../bridge/bridge.js";
import { DEFAULT_TIER_MODELS, ANTIGRAVITY_TIER_MODELS } from "../models/models.js";
import { TierModelStore, activeTierModels } from "../models/tier-store.js";
import { API_PROVIDERS, ApiProviderConfigSchema, defaultApiProviderConfig, hasApiKey, parseApiProviderConfig, requireApiKey } from "./config.js";

function temporaryStore(): { path: string; directory: string; store: TierModelStore } {
  const directory = mkdtempSync(join(tmpdir(), "codex2cc-provider-config-"));
  const path = join(directory, "settings.json");
  return { path, directory, store: TierModelStore.open(path, {}) };
}

test("all built-in API configurations validate and have independent mutable copies", () => {
  for (const provider of API_PROVIDERS) {
    const first = defaultApiProviderConfig(provider);
    assert.equal(ApiProviderConfigSchema.safeParse(first).success, true);
    first.models[0]!.displayName = "modified";
    assert.notEqual(defaultApiProviderConfig(provider).models[0]!.displayName, "modified");
  }
});

test("provider configuration strips extras and rejects invalid endpoints, catalog and key references", () => {
  const config = defaultApiProviderConfig("openai");
  const parsed = parseApiProviderConfig({ ...config, apiKey: "must-not-persist", models: config.models.map((model) => ({ ...model, extra: "strip" })) });
  assert.equal("apiKey" in parsed, false);
  assert.equal("extra" in parsed.models[0]!, false);
  for (const endpoint of ["not-a-url", "", "http://example.com/v1/responses", "https://user:secret@example.com/v1/responses", "https://example.com/v1/responses?key=secret", "https://example.com/v1/responses#secret", "file:///etc/passwd"]) {
    assert.throws(() => parseApiProviderConfig({ ...config, endpoints: { responses: endpoint } }), (error: unknown) => error instanceof BridgeError && error.code === "invalid_provider_config");
  }
  for (const update of [
    { defaultModel: "not-in-catalog" }, { models: [] }, { endpoints: {} }, { apiKeyEnv: "HOME" },
    { models: [config.models[0], config.models[0]] },
    { models: [{ ...config.models[0], contextWindow: -1 }] },
    { models: [{ ...config.models[0], protocol: "google" }] },
  ]) assert.throws(() => parseApiProviderConfig({ ...config, ...update }), BridgeError);
  assert.equal(parseApiProviderConfig({ ...config, endpoints: { responses: "http://127.0.0.1:8080/responses" } }).endpoints.responses, "http://127.0.0.1:8080/responses");
});

test("API credentials come only from the named environment variable", () => {
  const config = defaultApiProviderConfig("openai");
  assert.equal(requireApiKey(config, { OPENAI_API_KEY: " test-key " }), "test-key");
  assert.equal(hasApiKey(config, {}), false);
  assert.equal(hasApiKey(config, { OPENAI_API_KEY: "   " }), false);
  assert.equal(hasApiKey(config, { OPENAI_API_KEY: "bad\nkey" }), false);
  assert.throws(() => requireApiKey(config, { UNRELATED_API_KEY: "other-key" }), (error: unknown) => error instanceof BridgeError && error.status === 401 && error.message.includes("OPENAI_API_KEY"));
  assert.throws(() => requireApiKey(config, { OPENAI_API_KEY: "bad\nkey" }), (error: unknown) => error instanceof BridgeError && error.code === "invalid_provider_key" && !error.message.includes("bad"));
});

test("settings persist every provider independently and legacy tiers stay Codex-only", () => {
  const { path, directory, store } = temporaryStore();
  try {
    const codex = { ...DEFAULT_TIER_MODELS, sonnet: "custom-codex" };
    store.save(codex, "codex");
    store.save(ANTIGRAVITY_TIER_MODELS, "antigravity");
    for (const provider of API_PROVIDERS) {
      const base = defaultApiProviderConfig(provider);
      const slug = `${provider}-model`;
      const config = { ...base, defaultModel: slug, models: [{ ...base.models[0]!, slug }] };
      store.saveApiProviderConfig(provider, config);
      store.save({ fable: slug, opus: slug, sonnet: slug, haiku: slug }, provider);
      store.setProvider(provider);
    }
    const saved = JSON.parse(readFileSync(path, "utf8")) as { tiers: typeof codex };
    assert.deepEqual(saved.tiers, codex);
    const reloaded = TierModelStore.open(path, {});
    assert.equal(reloaded.getProvider(), "opencode");
    assert.deepEqual(activeTierModels({ tierStore: reloaded }), reloaded.current("opencode"));
    assert.deepEqual(reloaded.current("codex"), codex);
    assert.deepEqual(reloaded.current("antigravity"), ANTIGRAVITY_TIER_MODELS);
    for (const provider of API_PROVIDERS) {
      assert.equal(reloaded.current(provider).sonnet, `${provider}-model`);
      assert.equal(reloaded.getApiProviderConfig(provider).defaultModel, `${provider}-model`);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("an API-only settings file never becomes a Codex tier override after reload", () => {
  const { path, directory, store } = temporaryStore();
  try {
    store.setProvider("openai");
    store.save(store.defaults("openai"), "openai");
    const reloaded = TierModelStore.open(path, {});
    assert.deepEqual(reloaded.current("codex"), DEFAULT_TIER_MODELS);
    assert.equal(reloaded.isCustom("codex"), false);
    assert.equal("tiers" in JSON.parse(readFileSync(path, "utf8")), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("legacy version-one tiers and existing Antigravity settings remain readable", () => {
  const { path, directory } = temporaryStore();
  try {
    const tiers = { ...DEFAULT_TIER_MODELS, haiku: "legacy-haiku" };
    writeFileSync(path, JSON.stringify({ version: 1, tiers }));
    assert.deepEqual(TierModelStore.open(path, {}).current("codex"), tiers);
    writeFileSync(path, JSON.stringify({ version: 1, provider: "antigravity", mappings: { codex: tiers, antigravity: ANTIGRAVITY_TIER_MODELS } }));
    const loaded = TierModelStore.open(path, {});
    assert.equal(loaded.getProvider(), "antigravity");
    assert.deepEqual(loaded.current(), ANTIGRAVITY_TIER_MODELS);
    assert.deepEqual(loaded.current("codex"), tiers);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("removing models used by a saved mapping fails without changing configuration", () => {
  const { directory, store } = temporaryStore();
  try {
    store.save(store.defaults("openai"), "openai");
    const old = store.getApiProviderConfig("openai");
    assert.throws(() => store.saveApiProviderConfig("openai", { ...old, defaultModel: "other", models: [{ ...old.models[0]!, slug: "other" }] }), (error: unknown) => error instanceof BridgeError && error.code === "model_in_use");
    assert.deepEqual(store.getApiProviderConfig("openai"), old);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("failed persistence leaves active provider, mappings, effort and API config unchanged", () => {
  const { path, directory, store } = temporaryStore();
  try {
    store.save(DEFAULT_TIER_MODELS, "codex");
    // A regular file where the settings directory belongs causes a deterministic write failure.
    const blocked = join(directory, "blocked");
    writeFileSync(blocked, "not-a-directory");
    const broken = TierModelStore.open(join(blocked, "settings.json"), {});
    assert.throws(() => broken.setProvider("openai"));
    assert.equal(broken.getProvider(), "codex");
    assert.throws(() => broken.setEffort("high"));
    assert.equal(broken.getEffort(), undefined);
    assert.throws(() => broken.save({ ...DEFAULT_TIER_MODELS, sonnet: "changed" }, "codex"));
    assert.equal(broken.isCustom("codex"), false);
    const config = broken.getApiProviderConfig("openai");
    assert.throws(() => broken.saveApiProviderConfig("openai", { ...config, apiKeyEnv: "CUSTOM_API_KEY" }));
    assert.equal(broken.getApiProviderConfig("openai").apiKeyEnv, "OPENAI_API_KEY");
    assert.ok(readFileSync(path, "utf8").includes("codex"));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
