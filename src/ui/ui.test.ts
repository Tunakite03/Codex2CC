import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";
import type { GatewayOptions } from "../gateway/gateway.js";
import { DEFAULT_TIER_MODELS } from "../models/models.js";
import { TierModelStore } from "../models/tier-store.js";
import { getStatus, handleUiRoute, renderDashboardHtml } from "./ui.js";

function createMockResponse(): { response: ServerResponse; getOutput: () => { statusCode: number; headers: Record<string, string>; body: string } } {
  let statusCode = 200;
  let headers: Record<string, string> = {};
  const chunks: Buffer[] = [];

  const response = {
    writeHead(code: number, h?: Record<string, string>) {
      statusCode = code;
      if (h) headers = { ...headers, ...h };
      return this;
    },
    end(data?: string | Buffer) {
      if (data) chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
      return this;
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

