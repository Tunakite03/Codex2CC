import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { enableUsagePersistence, getTokenUsageStats, onUsageUpdated, recordTokenUsage, resetTokenUsage } from "./usage.js";

test("usage tracker aggregates token usage by model and overall statistics", () => {
  resetTokenUsage();

  const empty = getTokenUsageStats();
  assert.equal(empty.totalRequests, 0);
  assert.equal(empty.totalInputTokens, 0);
  assert.equal(empty.totalOutputTokens, 0);
  assert.equal(empty.totalCachedTokens, 0);
  assert.equal(empty.grandTotalTokens, 0);
  assert.deepEqual(empty.models, []);

  recordTokenUsage({
    model: "gpt-6-sol",
    inputTokens: 100,
    outputTokens: 50,
    cachedTokens: 20,
  });

  recordTokenUsage({
    model: "gpt-6-sol",
    inputTokens: 200,
    outputTokens: 100,
    cachedTokens: 0,
  });

  recordTokenUsage({
    model: "gpt-6-luna",
    inputTokens: 50,
    outputTokens: 25,
  });

  const stats = getTokenUsageStats();
  assert.equal(stats.totalRequests, 3);
  assert.equal(stats.totalInputTokens, 350);
  assert.equal(stats.totalOutputTokens, 175);
  assert.equal(stats.totalCachedTokens, 20);
  assert.equal(stats.grandTotalTokens, 350 + 175 + 20);
  assert.equal(stats.models.length, 2);

  // gpt-6-sol should be first due to higher totalTokens
  const sol = stats.models[0]!;
  assert.equal(sol.model, "gpt-6-sol");
  assert.equal(sol.requests, 2);
  assert.equal(sol.inputTokens, 300);
  assert.equal(sol.outputTokens, 150);
  assert.equal(sol.cachedTokens, 20);
  assert.equal(sol.totalTokens, 470);
  assert.ok(sol.lastUsed.length > 0);

  const luna = stats.models[1]!;
  assert.equal(luna.model, "gpt-6-luna");
  assert.equal(luna.requests, 1);
  assert.equal(luna.inputTokens, 50);
  assert.equal(luna.outputTokens, 25);
  assert.equal(luna.cachedTokens, 0);
  assert.equal(luna.totalTokens, 75);

  resetTokenUsage();
  const resetStats = getTokenUsageStats();
  assert.equal(resetStats.totalRequests, 0);
  assert.equal(resetStats.grandTotalTokens, 0);
  assert.deepEqual(resetStats.models, []);
});

test("usage tracker handles zero, negative or missing values gracefully", () => {
  resetTokenUsage();

  recordTokenUsage({
    model: "  gpt-6-astra  ",
    inputTokens: -10,
    outputTokens: 0,
    cachedTokens: undefined,
  });

  const stats = getTokenUsageStats();
  assert.equal(stats.totalRequests, 1);
  assert.equal(stats.totalInputTokens, 0);
  assert.equal(stats.totalOutputTokens, 0);
  assert.equal(stats.totalCachedTokens, 0);
  assert.equal(stats.grandTotalTokens, 0);
  assert.equal(stats.models[0]?.model, "gpt-6-astra");
});

test("usage tracker persists counters across restarts and quarantines corrupt files", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex2cc-usage-"));
  const file = join(dir, "usage.json");
  try {
    enableUsagePersistence(file);
    recordTokenUsage({ model: "gpt-6-sol", inputTokens: 10, outputTokens: 5, cachedTokens: 2 });
    assert.ok(existsSync(file));

    // Simulated restart: reload from disk.
    enableUsagePersistence(file);
    const restored = getTokenUsageStats();
    assert.equal(restored.totalRequests, 1);
    assert.equal(restored.grandTotalTokens, 17);

    resetTokenUsage();
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { version: 1, models: {} });

    writeFileSync(file, "{not json", "utf8");
    enableUsagePersistence(file);
    assert.equal(getTokenUsageStats().totalRequests, 0);
    assert.ok(existsSync(`${file}.corrupt`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("onUsageUpdated notifies subscribers on token recording and resets", () => {
  resetTokenUsage();
  const totals: number[] = [];

  const unsubscribe = onUsageUpdated((summary) => {
    totals.push(summary.grandTotalTokens);
  });

  recordTokenUsage({ model: "gpt-6-sol", inputTokens: 50, outputTokens: 20 });
  recordTokenUsage({ model: "gpt-6-sol", inputTokens: 10, outputTokens: 5 });
  resetTokenUsage();

  assert.deepEqual(totals, [70, 85, 0]);

  unsubscribe();
  recordTokenUsage({ model: "gpt-6-sol", inputTokens: 100, outputTokens: 50 });
  assert.deepEqual(totals, [70, 85, 0]);
});
