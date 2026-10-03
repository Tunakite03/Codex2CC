import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_TIER_MODELS, loadTierModels, resolveModel, tierModel } from "./models.js";

const SLUGS: ReadonlySet<string> = new Set(["gpt-6-sol", "gpt-6.1-sol", "gpt-6-luna"]);

test("resolveModel prefers an exact slug, then the Claude tier, then the default", () => {
  assert.deepEqual(resolveModel("gpt-6-luna", "gpt-6-sol", SLUGS, DEFAULT_TIER_MODELS), { slug: "gpt-6-luna", fellBack: false });
  assert.deepEqual(resolveModel("claude-opus-4", "gpt-6-sol", SLUGS, DEFAULT_TIER_MODELS), { slug: "gpt-6.1-sol", fellBack: false });
  assert.deepEqual(resolveModel("claude-sonnet-4", "gpt-6-luna", SLUGS, DEFAULT_TIER_MODELS), { slug: "gpt-6-sol", fellBack: false });
  assert.deepEqual(resolveModel("claude-haiku-4", "gpt-6-sol", SLUGS, DEFAULT_TIER_MODELS), { slug: "gpt-6-luna", fellBack: false });
  assert.deepEqual(resolveModel(undefined, "gpt-6-sol", SLUGS, DEFAULT_TIER_MODELS), { slug: "gpt-6-sol", fellBack: false });
});

test("resolveModel flags a fallback when the model and its tier are unavailable", () => {
  assert.deepEqual(resolveModel("something-else", "gpt-6-sol", SLUGS, DEFAULT_TIER_MODELS), { slug: "gpt-6-sol", fellBack: true });
  assert.deepEqual(resolveModel("claude-opus-4", "gpt-6-sol", new Set(["gpt-6-sol"]), DEFAULT_TIER_MODELS), { slug: "gpt-6-sol", fellBack: true });
});

test("tier models can be overridden from the environment and blank values keep the defaults", () => {
  const tiers = loadTierModels({ CODEX2CC_MODEL_OPUS: " my-opus ", CODEX2CC_MODEL_SONNET: "  " });
  assert.deepEqual(tiers, { opus: "my-opus", sonnet: DEFAULT_TIER_MODELS.sonnet, haiku: DEFAULT_TIER_MODELS.haiku });
  const available = new Set(["my-opus", "gpt-6-sol"]);
  assert.equal(resolveModel("claude-opus-4", "gpt-6-sol", available, tiers).slug, "my-opus");
  assert.equal(tierModel(tiers, "opus", available, "gpt-6-sol"), "my-opus");
  assert.equal(tierModel(tiers, "haiku", available, "gpt-6-sol"), "gpt-6-sol");
});
