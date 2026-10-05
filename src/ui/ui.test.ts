import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";
import type { GatewayOptions } from "../gateway/gateway.js";
import { DEFAULT_TIER_MODELS, ANTIGRAVITY_TIER_MODELS, type TierModels } from "../models/models.js";
import { TierModelStore } from "../models/tier-store.js";
import { clearLogs, recordLog } from "../telemetry/logger.js";
import { recordTokenUsage } from "../telemetry/usage.js";
import { getStatus, handleUiRoute, renderDashboardHtml } from "./ui.js";

function createMockResponse(): { response: ServerResponse; getOutput: () => { statusCode: number; headers: Record<string, string>; body: string } } {
  let statusCode = 200;
  let headers: Record<string, string> = {};
  const chunks: Buffer[] = [];
  const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};

  const response = {
    writeHead(code: number, h?: Record<string, string>) {
      statusCode = code;
      if (h) headers = { ...headers, ...h };
      return this;
    },
    write(data?: string | Buffer) {
      if (data) chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
      return true;
    },
    end(data?: string | Buffer) {
      if (data) chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
      return this;
    },
    on(event: string, listener: (...args: unknown[]) => void) {
      listeners[event] = listeners[event] || [];
      listeners[event].push(listener);
      return this;
    },
    emit(event: string, ...args: unknown[]) {
      for (const fn of listeners[event] || []) {
        fn(...args);
      }
      return true;
    },
  } as unknown as ServerResponse;

  return {
    response,
    getOutput: () => ({
      statusCode,
      headers,
      body: Buffer.concat(chunks).toString("utf8"),
    }),
  };
}

function createMockRequest(method: string, url: string, bodyJson?: object): IncomingMessage {
  const content = bodyJson !== undefined ? [Buffer.from(JSON.stringify(bodyJson))] : [];
  const req = Readable.from(content) as unknown as IncomingMessage;
  (req as { method: string }).method = method;
  (req as { url: string }).url = url;
  return req;
}

const mockOptions: GatewayOptions = {
  session: {
    async accessToken() { return "fake-token"; },
    async refreshAfterRejection() { return "refreshed-token"; },
    accountId: () => "acc-123",
  },
  defaultModel: "gpt-6-sol",
  availableModels: [
    { slug: "gpt-6-sol", displayName: "ChatGPT Sonnet" },
    { slug: "gpt-6.1-sol", displayName: "ChatGPT Opus" },
  ],
  policy: { mode: "token", token: "test-token-1234567890123456" },
};

test("dashboard inline JavaScript parses before it fetches status", () => {
  const html = renderDashboardHtml();
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  const result = spawnSync(process.execPath, ["--check"], { input: script, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("renderDashboardHtml generates rich HTML markup with control panel components and log monitor", () => {
  const html = renderDashboardHtml();
  assert.ok(html.includes("Codex2CC Control Panel"));
  assert.ok(html.includes("btn-apply"));
  assert.ok(html.includes("tier-fable"));
  assert.ok(html.includes("tier-opus"));
  assert.ok(html.includes("tier-sonnet"));
  assert.ok(html.includes("tier-haiku"));
  assert.ok(html.includes("btn-save-tier-mapping"));
  assert.ok(html.includes("btn-reset-tier-mapping"));
  assert.ok(html.includes("btn-reset-all"));
  assert.ok(html.includes("input-token"));
  assert.ok(html.includes("section-logs"));
  assert.ok(html.includes("logs-title"));
  assert.ok(html.includes("btn-refresh-logs"));
  assert.ok(html.includes("btn-clear-logs"));
  assert.ok(html.includes("btn-copy-logs"));
  assert.ok(html.includes("input-log-search"));
  assert.ok(html.includes("select-log-level"));
  assert.ok(html.includes("log-terminal"));
  assert.ok(html.includes('id="input-token" autocomplete="off" placeholder="No token required" readonly'));
  assert.ok(!html.includes('id="btn-gen-token"'));
  assert.ok(html.includes("section-usage"));
  assert.ok(html.includes("usage-title"));
  assert.ok(html.includes("usage-table"));
  assert.ok(html.includes("btn-refresh-usage"));
  assert.ok(html.includes("btn-reset-usage"));
  assert.ok(!html.includes('id="select-model"'));
  assert.ok(!html.includes('id="slider-effort"'));
  assert.ok(!html.includes("Reasoning Effort"));
  assert.ok(html.includes("color-scheme: light"));
  assert.ok(html.includes("--background: #f3efe6"));
  assert.ok(html.includes("--primary: #247b79"));
  assert.ok(!html.includes("prefers-color-scheme: dark"));
  assert.ok(html.includes("family=Outfit"));
  assert.ok(html.includes("family=Plus+Jakarta+Sans"));
});

test("getStatus provides gateway metadata and client detection without model controls", () => {
  const status = getStatus(mockOptions, 3456) as Record<string, unknown>;
  const gateway = status.gateway as Record<string, unknown>;
  assert.equal(gateway.port, 3456);
  assert.equal(gateway.url, "http://127.0.0.1:3456");
  assert.equal(gateway.token, "test-token-1234567890123456");
  assert.equal(gateway.activeModel, undefined);
  assert.equal(status.account, undefined);
  const cli = status.cli as Record<string, unknown>;
  assert.equal(cli.effort, undefined);
  const tierMapping = status.tierMapping as { current: typeof DEFAULT_TIER_MODELS };
  assert.deepEqual(tierMapping.current, DEFAULT_TIER_MODELS);
});

test("handleUiRoute serves HTML dashboard on /ui and /", async () => {
  const { response, getOutput } = createMockResponse();
  const req = createMockRequest("GET", "/ui");
  const handled = await handleUiRoute(mockOptions, req, response, "/ui", 3456);

  assert.equal(handled, true);
  const out = getOutput();
  assert.equal(out.statusCode, 200);
  assert.ok(out.headers["Content-Type"]?.includes("text/html"));
  assert.ok(out.body.includes("Codex2CC Control Panel"));
});

test("handleUiRoute responds to /api/ui/status and /api/ui/token", async () => {
  // Status check
  {
    const { response, getOutput } = createMockResponse();
    const req = createMockRequest("GET", "/api/ui/status");
    const handled = await handleUiRoute(mockOptions, req, response, "/api/ui/status", 3456);
    assert.equal(handled, true);
    const out = getOutput();
    assert.equal(out.statusCode, 200);
    const data = JSON.parse(out.body);
    assert.equal(data.gateway.port, 3456);
  }

  // Token generation check
  {
    const { response, getOutput } = createMockResponse();
    const req = createMockRequest("POST", "/api/ui/token");
    const handled = await handleUiRoute(mockOptions, req, response, "/api/ui/token", 3456);
    assert.equal(handled, true);
    const out = getOutput();
    assert.equal(out.statusCode, 200);
    const data = JSON.parse(out.body);
    assert.ok(typeof data.token === "string" && data.token.length >= 32);
  }
});

test("handleUiRoute rejects invalid gateway setup without writing client files", async () => {
  const { response, getOutput } = createMockResponse();
  const req = createMockRequest("POST", "/api/ui/setup", {
    target: "cli",
    gatewayUrl: "invalid-url",
    token: "valid-secret-token-1234567890123456",
  });
  const handled = await handleUiRoute(mockOptions, req, response, "/api/ui/setup", 3456);
  assert.equal(handled, true);
  const out = getOutput();
  assert.equal(out.statusCode, 400);
  const data = JSON.parse(out.body);
  assert.equal(data.ok, false);
  assert.match(data.error, /Invalid gateway URL/);
});

test("handleUiRoute rejects a token that differs from the running gateway", async () => {
  const { response, getOutput } = createMockResponse();
  const req = createMockRequest("POST", "/api/ui/setup", {
    target: "desktop",
    gatewayUrl: "http://127.0.0.1:3456",
    token: "different-token-1234567890",
  });
  const handled = await handleUiRoute(mockOptions, req, response, "/api/ui/setup", 3456);
  assert.equal(handled, true);
  const out = getOutput();
  assert.equal(out.statusCode, 400);
  assert.match(JSON.parse(out.body).error, /does not match the running gateway/);
});

test("tier mapping API saves, applies, and resets the UI mapping", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex2cc-tier-mapping-"));
  const filePath = join(directory, "tier-models.json");
  const tierStore = TierModelStore.open(filePath, {});
  const options: GatewayOptions = { ...mockOptions, tierStore };
  const tiers = { fable: "gpt-6-sol", opus: "gpt-6.1-sol", sonnet: "gpt-6.1-sol", haiku: "gpt-6-sol" };

  try {
    const saveOutput = createMockResponse();
    await handleUiRoute(
      options,
      createMockRequest("POST", "/api/ui/tiers", { tiers }),
      saveOutput.response,
      "/api/ui/tiers",
      3456,
    );
    assert.equal(saveOutput.getOutput().statusCode, 200);
    assert.deepEqual(tierStore.current(), tiers);
    assert.deepEqual(JSON.parse(readFileSync(filePath, "utf8")).tiers, tiers);
    assert.deepEqual(TierModelStore.open(filePath, {}).current(), tiers);

    const invalidOutput = createMockResponse();
    await handleUiRoute(
      options,
      createMockRequest("POST", "/api/ui/tiers", { tiers: { ...tiers, opus: "not-in-account" } }),
      invalidOutput.response,
      "/api/ui/tiers",
      3456,
    );
    assert.equal(invalidOutput.getOutput().statusCode, 400);
    assert.deepEqual(tierStore.current(), tiers);

    const resetOutput = createMockResponse();
    await handleUiRoute(
      options,
      createMockRequest("POST", "/api/ui/tiers/reset"),
      resetOutput.response,
      "/api/ui/tiers/reset",
      3456,
    );
    assert.equal(resetOutput.getOutput().statusCode, 200);
    assert.deepEqual(tierStore.current(), DEFAULT_TIER_MODELS);
    assert.equal(tierStore.isCustom(), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("handleUiRoute provides log retrieval and log clearing endpoints", async () => {
  // Test clearing logs
  {
    const { response, getOutput } = createMockResponse();
    const req = createMockRequest("POST", "/api/ui/logs/clear");
    const handled = await handleUiRoute(mockOptions, req, response, "/api/ui/logs/clear", 3456);
    assert.equal(handled, true);
    const out = getOutput();
    assert.equal(out.statusCode, 200);
    const data = JSON.parse(out.body);
    assert.equal(data.ok, true);
  }

  // Trigger an action that records a log (e.g. generate token)
  {
    const { response } = createMockResponse();
    const req = createMockRequest("POST", "/api/ui/token");
    await handleUiRoute(mockOptions, req, response, "/api/ui/token", 3456);
  }

  // Query logs
  {
    const { response, getOutput } = createMockResponse();
    const req = createMockRequest("GET", "/api/ui/logs?limit=10");
    const handled = await handleUiRoute(mockOptions, req, response, "/api/ui/logs", 3456);
    assert.equal(handled, true);
    const out = getOutput();
    assert.equal(out.statusCode, 200);
    const data = JSON.parse(out.body);
    assert.ok(Array.isArray(data.logs));
    assert.ok(data.logs.length >= 1);
    assert.equal(data.stats.total >= 1, true);
    assert.ok(typeof data.logFile === "string" && data.logFile.length > 0);
    const last = data.logs[data.logs.length - 1];
    assert.equal(last.operation, "token_gen");
  }
});

test("handleUiRoute provides token usage retrieval and reset endpoints", async () => {
  // Query usage initially
  {
    const { response, getOutput } = createMockResponse();
    const req = createMockRequest("GET", "/api/ui/usage");
    const handled = await handleUiRoute(mockOptions, req, response, "/api/ui/usage", 3456);
    assert.equal(handled, true);
    const out = getOutput();
    assert.equal(out.statusCode, 200);
    const data = JSON.parse(out.body);
    assert.ok(typeof data.totalRequests === "number");
    assert.ok(typeof data.grandTotalTokens === "number");
    assert.ok(Array.isArray(data.models));
  }

  // Reset usage
  {
    const { response, getOutput } = createMockResponse();
    const req = createMockRequest("POST", "/api/ui/usage/reset");
    const handled = await handleUiRoute(mockOptions, req, response, "/api/ui/usage/reset", 3456);
    assert.equal(handled, true);
    const out = getOutput();
    assert.equal(out.statusCode, 200);
    const data = JSON.parse(out.body);
    assert.equal(data.ok, true);
  }

  // Query usage with account limits (5h & weekly)
  {
    let receivedRefreshArg: boolean | undefined;
    const optionsWithLimits: GatewayOptions = {
      ...mockOptions,
      session: {
        ...mockOptions.session,
        async getUsageLimits(forceRefresh?: boolean) {
          receivedRefreshArg = forceRefresh;
          return {
            planType: "plus",
            allowed: true,
            limitReached: false,
            primaryWindow: {
              usedPercent: 45,
              remainingPercent: 55,
              limitWindowSeconds: 18000,
              resetAfterSeconds: 12000,
              resetAt: 1791189847,
            },
            secondaryWindow: {
              usedPercent: 30,
              remainingPercent: 70,
              limitWindowSeconds: 604800,
              resetAfterSeconds: 420000,
              resetAt: 1791617223,
            },
            lastUpdated: "2026-10-05T00:00:00.000Z",
          };
        },
      },
    };

    const { response, getOutput } = createMockResponse();
    const req = createMockRequest("GET", "/api/ui/usage?refresh=true");
    const handled = await handleUiRoute(optionsWithLimits, req, response, "/api/ui/usage", 3456);
    assert.equal(handled, true);
    const out = getOutput();
    assert.equal(out.statusCode, 200);
    const data = JSON.parse(out.body);
    assert.equal(receivedRefreshArg, true);
    assert.ok(data.limits !== null);
    assert.equal(data.limits.planType, "plus");
    assert.equal(data.limits.primaryWindow.remainingPercent, 55);
    assert.equal(data.limits.secondaryWindow.remainingPercent, 70);
  }
});

test("renderDashboardHtml includes 5-hour and weekly usage remaining components", () => {
  const html = renderDashboardHtml();
  assert.ok(html.includes('id="quota-limits-section"'), "quota limits section present");
  assert.ok(html.includes('id="card-quota-5h"'), "5h quota card present");
  assert.ok(html.includes('id="card-quota-weekly"'), "weekly quota card present");
  assert.ok(html.includes('id="val-5h-remaining"'), "5h remaining value placeholder present");
  assert.ok(html.includes('id="val-weekly-remaining"'), "weekly remaining value placeholder present");
  assert.ok(html.includes('id="bar-5h"'), "5h progress bar present");
  assert.ok(html.includes('id="bar-weekly"'), "weekly progress bar present");
});

test("handleUiRoute streams real-time SSE events for logs and usage", async () => {
  const { response, getOutput } = createMockResponse();
  const req = createMockRequest("GET", "/api/ui/events");
  const handled = await handleUiRoute(mockOptions, req, response, "/api/ui/events", 3456);
  assert.equal(handled, true);

  const out = getOutput();
  assert.equal(out.statusCode, 200);
  assert.equal(out.headers["Content-Type"], "text/event-stream");
  assert.ok(out.body.includes(": connected\n\n"));

  // Trigger a log event
  recordLog({ level: "info", operation: "sse_test", message: "SSE log message" });
  const logOut = getOutput().body;
  assert.ok(logOut.includes("event: log\ndata: {"));
  assert.ok(logOut.includes("SSE log message"));

  // Trigger a usage event
  recordTokenUsage({ model: "gpt-6-sol", inputTokens: 42, outputTokens: 12 });
  const usageOut = getOutput().body;
  assert.ok(usageOut.includes("event: usage\ndata: {"));
  assert.ok(usageOut.includes("totalRequests"));

  // Trigger a log clear event
  clearLogs();
  const clearOut = getOutput().body;
  assert.ok(clearOut.includes("event: log_clear\ndata: {}\n\n"));

  // Simulate client disconnect to verify cleanup doesn't error
  (req as unknown as { emit: (ev: string) => void }).emit("close");
});

type StatusResponse = {
  provider: { active: string };
  tierMapping: { current: TierModels; custom: boolean; defaults: TierModels; models: { slug: string; displayName: string }[] };
};

test("switching provider updates tier mapping and saves per-provider independently", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex2cc-tier-provider-"));
  const filePath = join(directory, "tier-models.json");
  const tierStore = TierModelStore.open(filePath, {});
  const options: GatewayOptions = { ...mockOptions, tierStore };

  try {
    // 1. Initial status is codex with DEFAULT_TIER_MODELS
    const initialStatus = getStatus(options, 3456) as unknown as StatusResponse;
    assert.equal(initialStatus.provider.active, "codex");
    assert.deepEqual(initialStatus.tierMapping.current, DEFAULT_TIER_MODELS);

    // 2. Switch provider to antigravity via /api/ui/provider
    const switchRes = createMockResponse();
    await handleUiRoute(
      options,
      createMockRequest("POST", "/api/ui/provider", { provider: "antigravity" }),
      switchRes.response,
      "/api/ui/provider",
      3456,
    );
    assert.equal(switchRes.getOutput().statusCode, 200);

    // 3. Status now reflects antigravity mapping
    const antStatus = getStatus(options, 3456) as unknown as StatusResponse;
    assert.equal(antStatus.provider.active, "antigravity");
    assert.deepEqual(antStatus.tierMapping.current, ANTIGRAVITY_TIER_MODELS);
    assert.equal(antStatus.tierMapping.custom, false);

    // 4. Save custom antigravity mapping
    const customAntTiers = {
      fable: "claude-sonnet-4-6",
      opus: "claude-opus-4-6-thinking",
      sonnet: "gemini-3.1-pro-high",
      haiku: "gemini-3.8-flash-high",
    };
    const saveAntRes = createMockResponse();
    await handleUiRoute(
      options,
      createMockRequest("POST", "/api/ui/tiers", { tiers: customAntTiers }),
      saveAntRes.response,
      "/api/ui/tiers",
      3456,
    );
    assert.equal(saveAntRes.getOutput().statusCode, 200);
    assert.deepEqual(tierStore.current("antigravity"), customAntTiers);
    assert.equal(tierStore.isCustom("antigravity"), true);

    // 5. Switch back to codex and verify codex tiers remained DEFAULT_TIER_MODELS and uncustomized
    const switchBackRes = createMockResponse();
    await handleUiRoute(
      options,
      createMockRequest("POST", "/api/ui/provider", { provider: "codex" }),
      switchBackRes.response,
      "/api/ui/provider",
      3456,
    );
    assert.equal(switchBackRes.getOutput().statusCode, 200);
    const codexStatus = getStatus(options, 3456) as unknown as StatusResponse;
    assert.equal(codexStatus.provider.active, "codex");
    assert.deepEqual(codexStatus.tierMapping.current, DEFAULT_TIER_MODELS);
    assert.equal(codexStatus.tierMapping.custom, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("unified settings.json persists provider, effort, and per-provider model mappings together", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex2cc-unified-settings-"));
  const filePath = join(directory, "settings.json");
  const store = TierModelStore.open(filePath, {});
  const options: GatewayOptions = { ...mockOptions, tierStore: store };

  try {
    // Save settings with custom effort and mappings
    const tiers = {
      fable: "gpt-6-sol",
      opus: "gpt-6.1-sol",
      sonnet: "gpt-6.1-sol",
      haiku: "gpt-6-sol",
    };
    const res = createMockResponse();
    await handleUiRoute(
      options,
      createMockRequest("POST", "/api/ui/tiers", { tiers, effort: "high" }),
      res.response,
      "/api/ui/tiers",
      3456,
    );
    assert.equal(res.getOutput().statusCode, 200);

    // Verify stored JSON has unified schema
    const savedJson = JSON.parse(readFileSync(filePath, "utf8")) as {
      version: number;
      provider?: string;
      effort?: string;
      mappings?: { codex?: typeof tiers; antigravity?: typeof tiers };
    };
    assert.equal(savedJson.version, 1);
    assert.equal(savedJson.effort, "high");
    assert.equal(store.getEffort(), "high");

    // Verify status returns effort
    const status = getStatus(options, 3456) as unknown as StatusResponse & { tierMapping: { effort: string } };
    assert.equal(status.tierMapping.effort, "high");

    // Verify a fresh store instance reloads the saved effort and mappings from settings.json
    const reloaded = TierModelStore.open(filePath, {});
    assert.equal(reloaded.getEffort(), "high");
    assert.deepEqual(reloaded.current("codex"), tiers);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});



