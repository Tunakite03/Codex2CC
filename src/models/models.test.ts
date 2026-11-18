import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_TIER_MODELS, loadTierModels, resolveModel, routedModels, smallestContextWindow, tierModel } from "./models.js";

const SLUGS: ReadonlySet<string> = new Set(["gpt-6.2-astra", "gpt-6.1-terra", "gpt-6.2-sol", "gpt-6-luna"]);

test("resolveModel prefers an exact slug, then the Claude tier, then the default", () => {
  assert.deepEqual(resolveModel("gpt-6-luna", "gpt-6.1-terra", SLUGS, DEFAULT_TIER_MODELS), { slug: "gpt-6-luna", fellBack: false });
  assert.deepEqual(resolveModel("claude-fable-5-1", "gpt-6.1-terra", SLUGS, DEFAULT_TIER_MODELS), { slug: "gpt-6.2-astra", fellBack: false });
  assert.deepEqual(resolveModel("claude-opus-5-5", "gpt-6.1-terra", SLUGS, DEFAULT_TIER_MODELS), { slug: "gpt-6.2-sol", fellBack: false });
  assert.deepEqual(resolveModel("claude-sonnet-5-5", "gpt-6-luna", SLUGS, DEFAULT_TIER_MODELS), { slug: "gpt-6.1-terra", fellBack: false });
  assert.deepEqual(resolveModel("claude-haiku-5", "gpt-6.1-terra", SLUGS, DEFAULT_TIER_MODELS), { slug: "gpt-6-luna", fellBack: false });
  assert.deepEqual(resolveModel(undefined, "gpt-6.1-terra", SLUGS, DEFAULT_TIER_MODELS), { slug: "gpt-6.1-terra", fellBack: false });
});

test("resolveModel flags a fallback when the model and its tier are unavailable", () => {
  assert.deepEqual(resolveModel("something-else", "gpt-6.1-terra", SLUGS, DEFAULT_TIER_MODELS), { slug: "gpt-6.1-terra", fellBack: true });
  assert.deepEqual(resolveModel("claude-opus-5-5", "gpt-6.1-terra", new Set(["gpt-6.1-terra"]), DEFAULT_TIER_MODELS), { slug: "gpt-6.1-terra", fellBack: true });
});

test("tier models can be overridden from the environment and blank values keep the defaults", () => {
  const tiers = loadTierModels({ CODEX2CC_MODEL_FABLE: " my-fable ", CODEX2CC_MODEL_OPUS: " my-opus ", CODEX2CC_MODEL_SONNET: "  " });
  assert.deepEqual(tiers, { fable: "my-fable", opus: "my-opus", sonnet: DEFAULT_TIER_MODELS.sonnet, haiku: DEFAULT_TIER_MODELS.haiku });
  const available = new Set(["my-fable", "my-opus", "gpt-6.1-terra"]);
  assert.equal(resolveModel("claude-fable-5-1", "gpt-6.1-terra", available, tiers).slug, "my-fable");
  assert.equal(resolveModel("claude-opus-5-5", "gpt-6.1-terra", available, tiers).slug, "my-opus");
  assert.equal(tierModel(tiers, "opus", available, "gpt-6.1-terra"), "my-opus");
  assert.equal(tierModel(tiers, "haiku", available, "gpt-6.1-terra"), "gpt-6.1-terra");
});

test("smallestContextWindow takes the tightest known window among the routed models", () => {
  const catalog = [
    { slug: "gpt-6.1-terra", displayName: "Sol", contextWindow: 400_000 },
    { slug: "gpt-6-luna", displayName: "Luna", contextWindow: 272_000 },
    { slug: "gpt-6.2-astra", displayName: "Astra" },
    { slug: "gpt-unused", displayName: "Unused", contextWindow: 128_000 },
  ];
  assert.equal(smallestContextWindow(catalog, ["gpt-6.1-terra", "gpt-6-luna", "gpt-6.2-astra"]), 272_000);
  assert.equal(smallestContextWindow(catalog, ["gpt-6.2-astra", "not-in-catalog"]), undefined);
});

test("the context window covers the Fable route when it has the smallest window", () => {
  const catalog = [
    { slug: "gpt-6.1-terra", displayName: "Sol", contextWindow: 1_000_000 },
    { slug: "gpt-6.2-sol", displayName: "Sol 6.1", contextWindow: 1_000_000 },
    { slug: "gpt-6-luna", displayName: "Luna", contextWindow: 1_000_000 },
    { slug: "gpt-6.2-astra", displayName: "Astra", contextWindow: 128_000 },
  ];
  assert.deepEqual(routedModels(DEFAULT_TIER_MODELS, "gpt-6.1-terra"), ["gpt-6.1-terra", "gpt-6.2-astra", "gpt-6.2-sol", "gpt-6.1-terra", "gpt-6-luna"]);
  assert.equal(smallestContextWindow(catalog, routedModels(DEFAULT_TIER_MODELS, "gpt-6.1-terra")), 128_000);
});
