import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Readable } from "node:stream";
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import test from "node:test";
import { CODEX2CC_DESKTOP_CONFIG_ID, resolveDefaultPaths } from "../config/config-setup.js";
import { createGatewayServer, listenOnLoopback, type GatewayOptions } from "../gateway/gateway.js";
import { BridgeError } from "../bridge/bridge.js";
import { API_PROVIDERS, defaultApiProviderConfig, type ApiProviderConfig } from "../providers/config.js";
import { DEFAULT_TIER_MODELS, ANTIGRAVITY_TIER_MODELS, PROVIDERS, type TierModels } from "../models/models.js";
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
  assert.ok(html.includes("select-target"));
  assert.ok(html.includes("btn-quick-cli"));
  assert.ok(html.includes("btn-quick-desktop"));
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
  assert.ok(html.includes('id="btn-provider-submit"'));
  assert.ok(!html.includes("M11.04 19.32Q12 21.51"), "sparkle icon must not be present in markup");
});

test("setup section holds the provider switch, gateway endpoint, Claude clients and model map", () => {
  const html = renderDashboardHtml();
  const setupStart = html.indexOf('id="tab-setup"');
  const usageStart = html.indexOf('id="tab-usage"');
  assert.ok(setupStart !== -1 && usageStart > setupStart);
  const setup = html.slice(setupStart, usageStart);
  for (const marker of ['id="btn-provider-submit"', 'id="input-url"', 'id="btn-quick-cli"', 'id="tier-fable"', 'id="btn-save-tier-mapping"']) {
    assert.ok(setup.includes(marker), `${marker} should live in the setup section`);
  }
  assert.ok(!html.includes('id="tab-routing"'), "model routing is merged into setup");
  assert.ok(html.includes('id="app-sidebar"'));
  assert.ok(html.includes('id="btn-toggle-sidebar"'));
});

test("provider buttons only stage a choice; the switch runs when Submit is pressed", () => {
  const html = renderDashboardHtml();
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  assert.ok(script.includes('addEventListener("click", () => selectProvider("codex"))'));
  assert.ok(script.includes('addEventListener("click", () => selectProvider("antigravity"))'));
  assert.ok(!script.includes('() => switchProvider("'), "provider buttons must not switch the provider directly");
  assert.ok(script.includes("await switchProvider(selectedProvider)"));
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

test("saving the tier mapping relabels Claude Desktop's model picker with the routed account models", async () => {
  // Desktop config paths resolve under HOME, so the applied config stays inside a sandbox.
  const home = mkdtempSync(join(tmpdir(), "codex2cc-ui-labels-home-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  const tierStore = TierModelStore.open(join(home, "tier-models.json"), {});
  const options: GatewayOptions = { ...mockOptions, tierStore };
  const tiers = { fable: "gpt-6-sol", opus: "gpt-6.1-sol", sonnet: "gpt-6-sol", haiku: "gpt-6-sol" };
  const configFile = join(resolveDefaultPaths().claudeDesktopDir, `${CODEX2CC_DESKTOP_CONFIG_ID}.json`);
  const desktopStatus = (): { inSync: boolean } => (getStatus(options, 3456) as { desktop: { inSync: boolean } }).desktop;
  try {
    const unapplied = createMockResponse();
    await handleUiRoute(options, createMockRequest("POST", "/api/ui/tiers", { tiers }), unapplied.response, "/api/ui/tiers", 3456);
    assert.equal(JSON.parse(unapplied.getOutput().body).desktopLabelsUpdated, false, "Desktop not on the gateway is left alone");

    const setup = createMockResponse();
    await handleUiRoute(
      options,
      createMockRequest("POST", "/api/ui/setup", { target: "desktop", token: mockOptions.policy.mode === "token" ? mockOptions.policy.token : "" }),
      setup.response,
      "/api/ui/setup",
      3456,
    );
    assert.equal(setup.getOutput().statusCode, 200);
    assert.equal(desktopStatus().inSync, true);

    const changed = { ...tiers, opus: "gpt-6-sol", sonnet: "gpt-6.1-sol" };
    const save = createMockResponse();
    await handleUiRoute(options, createMockRequest("POST", "/api/ui/tiers", { tiers: changed }), save.response, "/api/ui/tiers", 3456);
    assert.equal(save.getOutput().statusCode, 200);
    assert.equal(JSON.parse(save.getOutput().body).desktopLabelsUpdated, true);
    const config = JSON.parse(readFileSync(configFile, "utf8")) as { inferenceModels: unknown; inferenceGatewayApiKey: string };
    assert.deepEqual(config.inferenceModels, [
      { name: "claude-sonnet-5-5", labelOverride: "gpt-6.1-sol" },
      { name: "claude-opus-5-5", labelOverride: "gpt-6-sol" },
      { name: "claude-haiku-5", labelOverride: "gpt-6-sol" },
      { name: "claude-fable-5-1", labelOverride: "gpt-6-sol" },
    ]);
    assert.equal(config.inferenceGatewayApiKey, mockOptions.policy.mode === "token" ? mockOptions.policy.token : "");
    assert.equal(desktopStatus().inSync, true);

    writeFileSync(configFile, JSON.stringify({ ...config, inferenceModels: [{ name: "claude-sonnet-5-5" }] }), "utf8");
    assert.equal(desktopStatus().inSync, false, "a config without the current labels needs re-applying");
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
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




test("a Desktop reset reports the session-list sync it ran, separately from the reset itself", async () => {
  // Every client and Desktop path resolves under HOME, so the reset and the sync stay inside a sandbox.
  const home = mkdtempSync(join(tmpdir(), "codex2cc-ui-reset-home-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const { response, getOutput } = createMockResponse();
    await handleUiRoute(mockOptions, createMockRequest("POST", "/api/ui/reset", { target: "desktop" }), response, "/api/ui/reset", 3456);
    const out = getOutput();
    assert.equal(out.statusCode, 200);
    const data = JSON.parse(out.body) as { ok: boolean; desktopSessionSync: { status: string; level: string; messages: string[] } };
    assert.equal(data.ok, true);
    const expectedLevel: Record<string, string> = { applied: "success", skipped: "warning", failed: "error" };
    assert.equal(data.desktopSessionSync.level, expectedLevel[data.desktopSessionSync.status]);
    assert.ok(Array.isArray(data.desktopSessionSync.messages));

    const cliOnly = createMockResponse();
    await handleUiRoute(mockOptions, createMockRequest("POST", "/api/ui/reset", { target: "cli" }), cliOnly.response, "/api/ui/reset", 3456);
    assert.equal(JSON.parse(cliOnly.getOutput().body).desktopSessionSync, null, "no Desktop switch, no sync report");
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});


type ApiStatus = StatusResponse & {
  provider: { active: string; config?: ApiProviderConfig; keyConfigured?: boolean; available: { id: string; config?: ApiProviderConfig; keyConfigured?: boolean }[] };
};

test("API provider buttons stage selection and settings never request a secret", () => {
  const html = renderDashboardHtml();
  for (const provider of API_PROVIDERS) {
    assert.ok(html.includes(`id="btn-provider-${provider}"`));
    assert.ok(html.includes(`addEventListener("click", () => selectProvider("${provider}"))`));
  }
  for (const id of ["api-key-env", "api-default-model", "api-model-catalog", "api-endpoint-responses", "api-endpoint-chat-completions", "api-endpoint-anthropic-messages"]) assert.ok(html.includes(`id="${id}"`));
  const panel = html.slice(html.indexOf('<section id="api-provider-settings"'), html.indexOf('<!-- Gateway Credentials Bar -->'));
  assert.ok(!panel.includes('type="password"'));
  assert.ok(!panel.includes('id="api-key"'));
  assert.ok(html.includes('document.getElementById("card-quota-5h").hidden = isApi'));
});

test("API settings, key indicators and every provider mapping survive independent switches", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex2cc-api-settings-"));
  const file = join(directory, "settings.json");
  const store = TierModelStore.open(file, {});
  const secret = "test-runtime-secret-never-serialize";
  const options: GatewayOptions = { ...mockOptions, tierStore: store, providerEnv: { OPENROUTER_API_KEY: secret } };
  const saved = new Map<string, TierModels>();
  try {
    for (const provider of PROVIDERS) {
      if (API_PROVIDERS.some((candidate) => candidate === provider)) {
        const apiProvider = API_PROVIDERS.find((candidate) => candidate === provider)!;
        const config = defaultApiProviderConfig(apiProvider);
        const response = createMockResponse();
        await handleUiRoute(options, createMockRequest("POST", "/api/ui/provider-config", { provider, config: { ...config, apiKey: secret, ignored: true } }), response.response, "/api/ui/provider-config", 3456);
        assert.equal(response.getOutput().statusCode, 200);
        assert.deepEqual(JSON.parse(response.getOutput().body).config, config);
        assert.ok(!response.getOutput().body.includes(secret));
      }
      const switched = createMockResponse();
      await handleUiRoute(options, createMockRequest("POST", "/api/ui/provider", { provider }), switched.response, "/api/ui/provider", 3456);
      assert.equal(switched.getOutput().statusCode, 200);
      const status = getStatus(options, 3456) as ApiStatus;
      assert.equal(status.provider.active, provider);
      const model = status.tierMapping.models[0]!.slug;
      const tiers = { fable: model, opus: model, sonnet: model, haiku: model };
      const mapped = createMockResponse();
      await handleUiRoute(options, createMockRequest("POST", "/api/ui/tiers", { tiers }), mapped.response, "/api/ui/tiers", 3456);
      assert.equal(mapped.getOutput().statusCode, 200);
      saved.set(provider, tiers);
      if (status.provider.config) assert.equal(status.provider.keyConfigured, provider === "openrouter");
      assert.ok(!JSON.stringify(status).includes(secret));
    }
    const disk = readFileSync(file, "utf8");
    assert.ok(!disk.includes(secret));
    assert.ok(!disk.includes('"apiKey"'));
    const reloaded = TierModelStore.open(file, {});
    for (const provider of PROVIDERS) assert.deepEqual(reloaded.current(provider), saved.get(provider));
    const restarted = getStatus({ ...mockOptions, tierStore: reloaded, providerEnv: {} }, 3456) as ApiStatus;
    assert.equal(restarted.provider.active, "opencode");
    assert.equal(restarted.provider.keyConfigured, false);
    assert.deepEqual(restarted.tierMapping.current, saved.get("opencode"));
    await handleUiRoute(options, createMockRequest("POST", "/api/ui/provider", { provider: "codex" }), createMockResponse().response, "/api/ui/provider", 3456);
    const codex = getStatus(options, 3456) as ApiStatus;
    assert.deepEqual(codex.tierMapping.models, mockOptions.availableModels);
    assert.deepEqual(codex.tierMapping.current, saved.get("codex"));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("API settings reject invalid providers and catalogs without changing the store", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex2cc-invalid-api-"));
  const store = TierModelStore.open(join(directory, "settings.json"), {});
  const options: GatewayOptions = { ...mockOptions, tierStore: store, providerEnv: {} };
  const config = defaultApiProviderConfig("openai");
  try {
    for (const provider of ["codex", "antigravity", "unknown", null]) {
      await assert.rejects(handleUiRoute(options, createMockRequest("POST", "/api/ui/provider-config", { provider, config }), createMockResponse().response, "/api/ui/provider-config", 3456), (error: unknown) => error instanceof BridgeError && error.code === "invalid_provider");
    }
    for (const invalid of [{ ...config, apiKeyEnv: "a-secret-value" }, { ...config, models: [] }, { ...config, defaultModel: "missing" }, { ...config, endpoints: { responses: "https://api.example.com/responses?key=secret" } }]) {
      await assert.rejects(handleUiRoute(options, createMockRequest("POST", "/api/ui/provider-config", { provider: "openai", config: invalid }), createMockResponse().response, "/api/ui/provider-config", 3456), (error: unknown) => error instanceof BridgeError && error.code === "invalid_provider_config");
      assert.deepEqual(store.getApiProviderConfig("openai"), config);
    }
    await assert.rejects(handleUiRoute(options, createMockRequest("POST", "/api/ui/provider", { provider: "invalid" }), createMockResponse().response, "/api/ui/provider", 3456), (error: unknown) => error instanceof BridgeError && error.code === "invalid_provider");
    assert.equal(store.getProvider(), "codex");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("failed provider persistence leaves the active provider and API config unchanged", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex2cc-provider-failure-"));
  const file = join(directory, "settings.json");
  const store = TierModelStore.open(file, {});
  const options: GatewayOptions = { ...mockOptions, tierStore: store, provider: "codex" };
  const config = defaultApiProviderConfig("openai");
  mkdirSync(`${file}.tmp`);
  try {
    await assert.rejects(handleUiRoute(options, createMockRequest("POST", "/api/ui/provider", { provider: "openai" }), createMockResponse().response, "/api/ui/provider", 3456));
    assert.equal(options.provider, "codex");
    assert.equal(store.getProvider(), "codex");
    await assert.rejects(handleUiRoute(options, createMockRequest("POST", "/api/ui/provider-config", { provider: "openai", config: { ...config, apiKeyEnv: "CUSTOM_API_KEY" } }), createMockResponse().response, "/api/ui/provider-config", 3456));
    assert.deepEqual(store.getApiProviderConfig("openai"), config);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("API usage never queries ChatGPT subscription limits", async () => {
  for (const provider of API_PROVIDERS) {
    const options: GatewayOptions = { ...mockOptions, provider, providerEnv: {}, session: { ...mockOptions.session, async getUsageLimits() { assert.fail("API providers must not request ChatGPT quotas"); } } };
    const response = createMockResponse();
    await handleUiRoute(options, createMockRequest("GET", "/api/ui/usage?refresh=true"), response.response, "/api/ui/usage", 3456);
    const body = JSON.parse(response.getOutput().body);
    assert.equal(body.provider, provider);
    assert.equal(body.limits, null);
  }
});


test("provider configuration HTTP route keeps host and origin guards and sanitizes secrets", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex2cc-api-http-"));
  const store = TierModelStore.open(join(directory, "settings.json"), {});
  const server = createGatewayServer({ ...mockOptions, tierStore: store, providerEnv: { OPENAI_API_KEY: "runtime-only-secret" } });
  const port = await listenOnLoopback(server, 0);
  const origin = `http://127.0.0.1:${port}`;
  const config = defaultApiProviderConfig("openai");
  try {
    const denied = await fetch(`${origin}/api/ui/provider-config`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://attacker.example" }, body: JSON.stringify({ provider: "openai", config }) });
    assert.equal(denied.status, 403);
    await denied.text();
    // Fetch normalizes Host; use the HTTP client to send an actual hostile Host header.
    const badHost = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(`${origin}/api/ui/status`, { headers: { Host: "attacker.example" } }, (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode));
      });
      request.once("error", reject);
      request.end();
    });
    assert.equal(badHost, 403);
    const saved = await fetch(`${origin}/api/ui/provider-config`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify({ provider: "openai", config: { ...config, apiKey: "submitted-secret" } }) });
    assert.equal(saved.status, 200);
    const body = await saved.json() as { config: ApiProviderConfig; keyConfigured: boolean };
    assert.deepEqual(body.config, config);
    assert.equal(body.keyConfigured, true);
    const statusResponse = await fetch(`${origin}/api/ui/status`);
    const status = await statusResponse.text();
    assert.ok(!status.includes("runtime-only-secret"));
    assert.ok(!status.includes("submitted-secret"));
    const invalid = await fetch(`${origin}/api/ui/provider-config`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify({ provider: "openai", config: { ...config, models: [] } }) });
    assert.equal(invalid.status, 400);
    await invalid.text();
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});

test("legacy settings keep Codex mappings when API providers are configured", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex2cc-legacy-ui-"));
  const file = join(directory, "settings.json");
  const tiers = { fable: "gpt-6-sol", opus: "gpt-6.1-sol", sonnet: "gpt-6-sol", haiku: "gpt-6-sol" };
  writeFileSync(file, JSON.stringify({ version: 1, tiers }));
  try {
    const store = TierModelStore.open(file, {});
    const options: GatewayOptions = { ...mockOptions, tierStore: store, providerEnv: {} };
    assert.deepEqual((getStatus(options, 3456) as StatusResponse).tierMapping.current, tiers);
    await handleUiRoute(options, createMockRequest("POST", "/api/ui/provider-config", { provider: "openai", config: defaultApiProviderConfig("openai") }), createMockResponse().response, "/api/ui/provider-config", 3456);
    const reloaded = TierModelStore.open(file, {});
    assert.deepEqual(reloaded.current("codex"), tiers);
    assert.equal(reloaded.getProvider(), "codex");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("API setup uses its catalog and does not carry another provider's model override", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex2cc-api-model-default-"));
  const store = TierModelStore.open(join(directory, "settings.json"), {});
  const config = defaultApiProviderConfig("opencode");
  store.saveApiProviderConfig("opencode", { ...config, defaultModel: "kimi-k3" });
  const options: GatewayOptions = { ...mockOptions, tierStore: store, provider: "opencode", providerEnv: {}, defaultModels: { openai: "gpt-5.5" } };
  try {
    const response = createMockResponse();
    await handleUiRoute(options, createMockRequest("POST", "/api/ui/setup", { target: "cli" }), response.response, "/api/ui/setup", 3456);
    assert.equal(response.getOutput().statusCode, 200);
    assert.equal(JSON.parse(response.getOutput().body).result.model, "kimi-k3");
    const settings = JSON.parse(readFileSync(resolveDefaultPaths().claudeSettingsPath, "utf8")) as { env: Record<string, string> };
    assert.equal(settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL, "kimi-k3");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
