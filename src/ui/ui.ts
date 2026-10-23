import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { BridgeError } from "../bridge/bridge.js";
import {
  CODEX2CC_DESKTOP_CONFIG_ID,
  desktopInferenceModels,
  desktopLibraryDirs,
  refreshDesktopModelLabels,
  resetConfig,
  resolvePaths,
  setupConfig,
  validateGatewayUrl,
  type SetupPaths,
  type SetupTarget,
} from "../config/config-setup.js";
import type { GatewayOptions } from "../gateway/gateway.js";
import { ANTIGRAVITY_MODELS, ANTIGRAVITY_TIER_MODELS, DEFAULT_TIER_MODELS, routedModels, smallestContextWindow, type ProviderType } from "../models/models.js";
import { isAntigravityAvailable } from "../bridge/antigravity.js";
import {
  desktopProcessState,
  desktopSyncReport,
  resolveDesktopSessionPaths,
  syncDesktopSessionsWhenClosed,
  TO_CLAUDE_PROFILE,
  TO_GATEWAY_PROFILE,
  type DesktopSyncReport,
  type SyncDirection,
} from "../config/desktop-sessions.js";
import { activeTierModels, parseTierModels, EffortLevel } from "../models/tier-store.js";
import { clearLogs, getActiveLogFilePath, getLogs, getLogStats, onLog, onLogsCleared, recordLog, type LogLevel } from "../telemetry/logger.js";
import type { AccountUsageLimits } from "../auth/auth.js";
import { getTokenUsageStats, onUsageUpdated, resetTokenUsage } from "../telemetry/usage.js";

export function openBrowser(url: string): void {
  const plat = process.platform;
  let command: string;
  let args: string[];

  if (plat === "darwin") {
    command = "open";
    args = [url];
  } else if (plat === "win32") {
    command = "cmd.exe";
    args = ["/c", "start", '""', url];
  } else {
    command = "xdg-open";
    args = [url];
  }

  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.once("error", (error: Error) => {
      recordLog({
        level: "warn",
        operation: "open_browser_failed",
        message: `Could not open the browser automatically (${error.message}); open ${url} manually`,
        details: { command },
      });
    });
    child.unref();
  } catch (error) {
    // Non-fatal if browser cannot be launched
    recordLog({
      level: "warn",
      operation: "open_browser_failed",
      message: `Could not open the browser automatically (${(error as Error).message}); open ${url} manually`,
      details: { command },
    });
  }
}

const MAX_UI_BODY_BYTES = 1024 * 1024;
const SETUP_TARGETS: ReadonlySet<string> = new Set(["cli", "desktop", "all"]);

/** Reads a JSON object body (≤ 1 MiB). An empty body is `{}`; malformed or non-object JSON is a 400. */
async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_UI_BODY_BYTES) throw new BridgeError(413, "request_too_large", "Control panel request body exceeds 1 MiB.");
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BridgeError(400, "invalid_json", "Control panel request body is not valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new BridgeError(400, "invalid_body", "Control panel request body must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function parseSetupTarget(value: unknown): SetupTarget {
  if (value === undefined || value === "") return "all";
  if (typeof value === "string" && SETUP_TARGETS.has(value)) return value as SetupTarget;
  throw new BridgeError(400, "invalid_target", "Setup target must be one of: cli, desktop, all.");
}

export function getStatus(options: GatewayOptions, port: number, pathsInput?: SetupPaths): Record<string, unknown> {
  const paths = resolvePaths(pathsInput);
  const gatewayUrl = `http://127.0.0.1:${port}`;
  const token = options.policy.mode === "token" ? options.policy.token : "";
  const currentTiers = activeTierModels(options);
  const activeProvider: ProviderType = options.provider ?? "codex";
  const isAntigravity = activeProvider === "antigravity";
  const activeModels = isAntigravity
    ? (options.antigravityModels ?? ANTIGRAVITY_MODELS)
    : options.availableModels;
  const defaults = options.tierStore?.defaults(activeProvider)
    ?? (isAntigravity ? ANTIGRAVITY_TIER_MODELS : (options.tiers ?? DEFAULT_TIER_MODELS));
  // A stored config only works when it points at this gateway and carries its current token.
  const inSync = (baseUrl: string, storedToken: string): boolean =>
    baseUrl.replace(/\/+$/, "") === gatewayUrl && (options.policy.mode === "open" || storedToken === token);

  let cliConfigured = false;
  let cliBaseUrl = "";
  let cliInSync = false;

  if (existsSync(paths.claudeSettingsPath)) {
    try {
      const data = JSON.parse(readFileSync(paths.claudeSettingsPath, "utf8"));
      if (data?.env?.ANTHROPIC_BASE_URL) {
        cliConfigured = true;
        cliBaseUrl = String(data.env.ANTHROPIC_BASE_URL);
        cliInSync = inSync(cliBaseUrl, String(data.env.ANTHROPIC_AUTH_TOKEN ?? ""))
          && data.env.ANTHROPIC_DEFAULT_OPUS_MODEL === currentTiers.opus
          && data.env.ANTHROPIC_DEFAULT_SONNET_MODEL === currentTiers.sonnet
          && data.env.ANTHROPIC_DEFAULT_HAIKU_MODEL === currentTiers.haiku;
      }
    } catch {
      // Ignore
    }
  }

  let desktopConfigured = false;
  let desktopBaseUrl = "";
  let desktopInSync = false;
  let desktopDeploymentMode: "1p" | "3p" | undefined;
  let desktopPath = paths.claudeDesktopDir;
  for (const libraryDir of desktopLibraryDirs(paths)) {
    const metaFile = join(libraryDir, "_meta.json");
    if (!existsSync(metaFile)) continue;
    try {
      const meta = JSON.parse(readFileSync(metaFile, "utf8"));
      if (meta?.appliedId !== CODEX2CC_DESKTOP_CONFIG_ID) continue;
      desktopConfigured = true;
      desktopPath = libraryDir;
      const profileFile = join(dirname(libraryDir), "claude_desktop_config.json");
      if (existsSync(profileFile)) {
        const profile = JSON.parse(readFileSync(profileFile, "utf8"));
        if (profile?.deploymentMode === "1p" || profile?.deploymentMode === "3p") {
          desktopDeploymentMode = profile.deploymentMode;
        }
      }
      const configFile = join(libraryDir, `${CODEX2CC_DESKTOP_CONFIG_ID}.json`);
      if (existsSync(configFile)) {
        const cfg = JSON.parse(readFileSync(configFile, "utf8"));
        desktopBaseUrl = String(cfg?.inferenceGatewayBaseUrl || "");
        desktopInSync = inSync(desktopBaseUrl, String(cfg?.inferenceGatewayApiKey ?? ""))
          && desktopDeploymentMode === "3p"
          && JSON.stringify(cfg?.inferenceModels) === JSON.stringify(desktopInferenceModels(currentTiers));
      }
    } catch {
      // Ignore
    }
    if (desktopConfigured) break;
  }

  return {
    provider: {
      active: activeProvider,
      available: [
        { id: "codex", name: "ChatGPT (Codex)", available: true },
        { id: "antigravity", name: "Google Antigravity (agy)", available: isAntigravityAvailable() },
      ],
    },
    gateway: {
      port,
      url: gatewayUrl,
      policyMode: options.policy.mode,
      token,
    },
    cli: {
      configured: cliConfigured,
      inSync: cliInSync,
      baseUrl: cliBaseUrl,
      path: paths.claudeSettingsPath,
    },
    desktop: {
      configured: desktopConfigured,
      inSync: desktopInSync,
      baseUrl: desktopBaseUrl,
      path: desktopPath,
      deploymentMode: desktopDeploymentMode ?? null,
    },
    tierMapping: {
      current: currentTiers,
      defaults,
      custom: options.tierStore?.isCustom(activeProvider) ?? false,
      models: activeModels.map(({ slug, displayName }) => ({ slug, displayName })),
      effort: options.tierStore?.getEffort() ?? "",
    },
  };
}

/**
 * Rewrites Claude Desktop's picker labels to the active tier mapping when Desktop uses this gateway.
 * Runs after the mapping is persisted, so a failure says the mapping itself was kept.
 */
function refreshDesktopLabels(options: GatewayOptions): boolean {
  let files: readonly string[];
  try {
    files = refreshDesktopModelLabels(activeTierModels(options));
  } catch (error) {
    throw new BridgeError(
      500,
      "desktop_labels_refresh_failed",
      `Tier mapping saved, but Claude Desktop model labels were not updated: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
  if (files.length > 0) {
    recordLog({
      level: "info",
      operation: "desktop_labels_refreshed",
      message: "Updated Claude Desktop model picker labels to the active tier mapping; restart Claude Desktop to see them",
      details: { provider: options.provider ?? "codex" },
    });
  }
  return files.length > 0;
}

/** Syncs Desktop session lists after a profile switch and reports it in the activity log. */
function syncDesktopSessionsAfterSwitch(directions: readonly SyncDirection[]): DesktopSyncReport {
  const outcome = syncDesktopSessionsWhenClosed(directions, resolveDesktopSessionPaths(), desktopProcessState(), new Date());
  const report = desktopSyncReport(outcome);
  const changes = outcome.status === "applied" ? outcome.sync.entries.length : outcome.status === "failed" ? outcome.entries.length : 0;
  recordLog({
    level: report.level === "success" ? "info" : report.level === "warning" ? "warn" : "error",
    operation: "desktop_session_sync",
    message: report.messages.join(" "),
    details: { status: outcome.status, changes },
  });
  return report;
}

export async function handleUiRoute(
  options: GatewayOptions,
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  port: number,
): Promise<boolean> {
  if (pathname === "/" || pathname === "/ui") {
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache",
    });
    response.end(renderDashboardHtml());
    return true;
  }

  if (pathname === "/api/ui/status" && request.method === "GET") {
    const status = getStatus(options, port);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(status));
    return true;
  }

  if (pathname === "/api/ui/logs" && request.method === "GET") {
    const parsedUrl = new URL(request.url ?? "/api/ui/logs", `http://127.0.0.1:${port}`);
    const sinceParam = parsedUrl.searchParams.get("since");
    const sinceId = sinceParam !== null ? Number.parseInt(sinceParam, 10) : undefined;
    const levelParam = parsedUrl.searchParams.get("level");
    const level: LogLevel | undefined =
      levelParam === "info" || levelParam === "warn" || levelParam === "error" ? levelParam : undefined;
    const searchParam = parsedUrl.searchParams.get("search");
    const search = typeof searchParam === "string" && searchParam.trim().length > 0 ? searchParam.trim() : undefined;
    const limitParam = parsedUrl.searchParams.get("limit");
    const limit = limitParam !== null ? Number.parseInt(limitParam, 10) : undefined;

    const logs = getLogs({
      sinceId: sinceId !== undefined && !Number.isNaN(sinceId) ? sinceId : undefined,
      level,
      search,
      limit: limit !== undefined && !Number.isNaN(limit) ? limit : undefined,
    });
    const stats = getLogStats();
    const logFile = getActiveLogFilePath();

    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ logs, stats, logFile }));
    return true;
  }

  if (pathname === "/api/ui/events" && request.method === "GET") {
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });

    response.write(": connected\n\n");

    let cleanedUp = false;
    let heartbeat: NodeJS.Timeout | undefined;

    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = undefined;
      }
      unsubscribeLog();
      unsubscribeClear();
      unsubscribeUsage();
    };

    heartbeat = setInterval(() => {
      try {
        response.write(": ping\n\n");
      } catch {
        cleanup();
      }
    }, 15000);

    const unsubscribeLog = onLog((entry) => {
      try {
        const stats = getLogStats();
        response.write(`event: log\ndata: ${JSON.stringify({ log: entry, stats })}\n\n`);
      } catch {
        cleanup();
      }
    });

    const unsubscribeClear = onLogsCleared(() => {
      try {
        response.write(`event: log_clear\ndata: {}\n\n`);
      } catch {
        cleanup();
      }
    });

    const unsubscribeUsage = onUsageUpdated((summary) => {
      try {
        response.write(`event: usage\ndata: ${JSON.stringify({ ...summary, provider: options.provider ?? "codex", antigravity: { available: isAntigravityAvailable() } })}\n\n`);
      } catch {
        cleanup();
      }
    });

    request.on("close", cleanup);
    response.on("close", cleanup);
    return true;
  }

  if (pathname === "/api/ui/logs/clear" && request.method === "POST") {
    clearLogs({ clearFile: true });
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
    return true;
  }

  if (pathname === "/api/ui/usage" && request.method === "GET") {
    const parsedUrl = new URL(request.url ?? "/api/ui/usage", `http://127.0.0.1:${port}`);
    const forceRefresh = parsedUrl.searchParams.get("refresh") === "true";
    const usage = getTokenUsageStats();
    let limits: AccountUsageLimits | null = null;
    const currentProvider = options.provider ?? "codex";
    if (currentProvider === "codex" && typeof options.session.getUsageLimits === "function") {
      try {
        limits = await options.session.getUsageLimits(forceRefresh);
      } catch (error) {
        limits = null;
        recordLog({
          level: "warn",
          operation: "usage_limits_unavailable",
          message: `Could not fetch ChatGPT usage limits: ${error instanceof Error ? error.message : "unknown error"}`,
        });
      }
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      ...usage,
      provider: currentProvider,
      antigravity: {
        available: isAntigravityAvailable(),
      },
      limits: currentProvider === "codex" ? limits : null,
    }));
    return true;
  }

  if (pathname === "/api/ui/usage/reset" && request.method === "POST") {
    resetTokenUsage();
    recordLog({
      level: "info",
      operation: "usage_reset",
      message: "Reset all token usage counters",
    });
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
    return true;
  }

  if (pathname === "/api/ui/token" && request.method === "POST") {
    const token = randomBytes(32).toString("base64url");
    recordLog({
      level: "info",
      operation: "token_gen",
      message: "Generated new random gateway authentication token",
    });
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ token }));
    return true;
  }

  if (pathname === "/api/ui/provider" && request.method === "POST") {
    const body = await readJsonBody(request);
    if (body.provider !== "antigravity" && body.provider !== "codex") {
      throw new BridgeError(400, "invalid_provider", 'Provider must be "codex" or "antigravity".');
    }
    const target: ProviderType = body.provider;
    options.provider = target;
    if (options.tierStore) {
      options.tierStore.setProvider(target);
    }
    recordLog({
      level: "info",
      operation: "provider_switch",
      message: `Active provider changed to "${target}"`,
      details: { provider: target },
    });
    const desktopLabelsUpdated = refreshDesktopLabels(options);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ ok: true, provider: target, desktopLabelsUpdated }));
    return true;
  }

  if (pathname === "/api/ui/tiers" && request.method === "POST") {
    const store = options.tierStore;
    if (!store) {
      response.writeHead(503, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: false, error: "Tier mapping storage is unavailable in this gateway mode." }));
      return true;
    }
    try {
      const body = await readJsonBody(request);
      const tiers = parseTierModels(body.tiers);
      const currentProvider = options.provider ?? "codex";
      const isAnt = currentProvider === "antigravity";
      const modelCatalog = isAnt ? (options.antigravityModels ?? ANTIGRAVITY_MODELS) : options.availableModels;
      const availableModels = new Set(modelCatalog.map((model) => model.slug));
      const unavailable = Object.entries(tiers).find(([, model]) => !availableModels.has(model));
      if (unavailable) {
        throw new BridgeError(400, "model_unavailable", `Tier mapping model "${unavailable[1]}" is not in the current ${isAnt ? "Antigravity" : "ChatGPT"} model catalog.`);
      }
      store.save(tiers, currentProvider);
      if (typeof body.effort === "string") {
        const cleanEffort = body.effort.trim();
        if (cleanEffort === "") {
          store.setEffort(undefined);
        } else {
          const parsedEffort = EffortLevel.safeParse(cleanEffort);
          if (parsedEffort.success) {
            store.setEffort(parsedEffort.data);
          }
        }
      }
      recordLog({
        level: "info",
        operation: "tier_mapping_saved",
        message: `Saved Claude tier to ${isAnt ? "Antigravity" : "ChatGPT"} model mapping`,
        details: { provider: currentProvider, fable: tiers.fable, opus: tiers.opus, sonnet: tiers.sonnet, haiku: tiers.haiku },
      });
      const desktopLabelsUpdated = refreshDesktopLabels(options);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true, tiers: store.current(currentProvider), custom: store.isCustom(currentProvider), effort: store.getEffort() ?? "", desktopLabelsUpdated }));
    } catch (error) {
      const failure = error instanceof BridgeError
        ? error
        : new BridgeError(500, "tier_mapping_save_failed", `Could not save the tier mapping: ${error instanceof Error ? error.message : "unknown error"}.`);
      recordLog({
        level: failure.status >= 500 ? "error" : "warn",
        operation: "tier_mapping_save_failed",
        message: failure.message,
      });
      response.writeHead(failure.status, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: false, error: failure.message }));
    }
    return true;
  }

  if (pathname === "/api/ui/tiers/reset" && request.method === "POST") {
    const store = options.tierStore;
    if (!store) {
      response.writeHead(503, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: false, error: "Tier mapping storage is unavailable in this gateway mode." }));
      return true;
    }
    try {
      const currentProvider = options.provider ?? "codex";
      store.reset(currentProvider);
      recordLog({
        level: "info",
        operation: "tier_mapping_reset",
        message: `Reset Claude tier mapping to ${currentProvider === "antigravity" ? "Antigravity" : "ChatGPT"} environment or built-in defaults`,
      });
      const desktopLabelsUpdated = refreshDesktopLabels(options);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true, tiers: store.current(currentProvider), custom: store.isCustom(currentProvider), desktopLabelsUpdated }));
    } catch (error) {
      const failure = error instanceof BridgeError
        ? error
        : new BridgeError(500, "tier_mapping_reset_failed", `Could not reset the tier mapping: ${error instanceof Error ? error.message : "unknown error"}.`);
      recordLog({ level: "error", operation: "tier_mapping_reset_failed", message: failure.message });
      response.writeHead(failure.status, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: false, error: failure.message }));
    }
    return true;
  }

  if (pathname === "/api/ui/setup" && request.method === "POST") {
    const body = await readJsonBody(request);
    const target = parseSetupTarget(body.target);
    const gatewayUrl = typeof body.gatewayUrl === "string" ? body.gatewayUrl.trim() : `http://127.0.0.1:${port}`;
    const token = typeof body.token === "string" ? body.token.trim() : options.policy.mode === "token" ? options.policy.token : "";
    try {
      const cleanUrl = validateGatewayUrl(gatewayUrl);
      if (cleanUrl !== `http://127.0.0.1:${port}`) {
        throw new BridgeError(400, "gateway_url_mismatch", "Client setup must use this running gateway URL. Use the CLI setup command for another gateway.");
      }
      if (options.policy.mode === "token" && token !== options.policy.token) {
        throw new BridgeError(400, "gateway_token_mismatch", "Client setup token does not match the running gateway. Restart with CODEX2CC_TOKEN to change it.");
      }
      const effort = typeof body.effort === "string" && body.effort.trim() !== ""
        ? body.effort.trim()
        : options.tierStore?.getEffort();
      const tiers = activeTierModels(options);
      const catalog = (options.provider ?? "codex") === "antigravity" ? (options.antigravityModels ?? ANTIGRAVITY_MODELS) : options.availableModels;
      const result = setupConfig(target, {
        gatewayUrl: cleanUrl,
        token,
        model: options.defaultModel,
        tiers,
        effort,
        maxContextTokens: smallestContextWindow(catalog, routedModels(tiers, options.defaultModel)),
      });
      recordLog({
        level: "info",
        operation: "setup",
        message: `Client configuration applied for "${target}" (gateway: ${gatewayUrl})`,
        details: { target, gatewayUrl },
      });
      const desktopSessionSync = result.desktopConfigured ? syncDesktopSessionsAfterSwitch(TO_GATEWAY_PROFILE) : null;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true, result, desktopSessionSync }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      recordLog({
        level: "error",
        operation: "setup_failed",
        message: `Failed to apply client configuration for "${target}": ${msg}`,
        details: { target, error: msg },
      });
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: false, error: msg }));
    }
    return true;
  }

  if (pathname === "/api/ui/reset" && request.method === "POST") {
    const body = await readJsonBody(request);
    const target = parseSetupTarget(body.target);
    try {
      const result = resetConfig(target);
      recordLog({
        level: "warn",
        operation: "reset",
        message: `Client configuration reset for target "${target}"`,
        details: { target },
      });
      const desktopSessionSync = result.desktopReset ? syncDesktopSessionsAfterSwitch(TO_CLAUDE_PROFILE) : null;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true, result, desktopSessionSync }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      recordLog({
        level: "error",
        operation: "reset_failed",
        message: `Failed to reset client configuration for "${target}": ${msg}`,
        details: { target, error: msg },
      });
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: false, error: msg }));
    }
    return true;
  }

  return false;
}

export function renderDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Codex2CC Control Panel — Local Gateway & Claude Bridge</title>
  <link rel="icon" href="data:,">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700&family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      color-scheme: light;
      --background: #f3efe6;
      --paper-deep: #e7dfd1;
      --surface: #fffdf8;
      --surface-soft: #f8f4ec;
      --ink: #17201d;
      --ink-soft: #53605a;
      --ink-faint: #85908a;
      --line: #26322c;
      --line-soft: #d3cabd;
      --coral: #e96b4f;
      --coral-dark: #b74731;
      --teal-soft: #dcece6;
      --yellow: #f1c75b;
      --foreground: var(--ink);
      --card: var(--surface);
      --card-foreground: var(--ink);
      --primary: #247b79;
      --primary-hover: #1c6765;
      --primary-active: #155351;
      --action: var(--coral);
      --action-hover: var(--coral-dark);
      --primary-foreground: #ffffff;
      --secondary: var(--surface-soft);
      --secondary-hover: var(--paper-deep);
      --secondary-foreground: var(--ink);
      --muted: var(--surface-soft);
      --muted-foreground: var(--ink-soft);
      --accent: var(--teal-soft);
      --accent-foreground: #174d48;
      --destructive: #b94b46;
      --destructive-hover: #963c38;
      --destructive-foreground: #ffffff;
      --border: var(--line-soft);
      --border-subtle: #e8e0d4;
      --input: #b7b3a9;
      --ring: var(--yellow);
      --hard-shadow: rgba(23, 32, 29, 0.08);
      --card-shadow: 4px 4px 0 var(--paper-deep);
      --radius: 0.625rem;
      --radius-lg: 1rem;
      --font-display: 'Outfit', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      --font-body: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      --font-mono: ui-monospace, 'JetBrains Mono', SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }

    * { box-sizing: border-box; }
    html { min-width: 320px; -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; }
    body {
      margin: 0;
      font-family: var(--font-body);
      background: var(--background);
      color: var(--foreground);
      min-height: 100vh;
      line-height: 1.55;
      overflow-x: hidden;
    }

    h1, h2, h3, p { margin: 0; }
    button, input, select { font: inherit; }
    button:not(:disabled) { cursor: pointer; }
    :where(button, input, select):focus-visible {
      outline: 3px solid var(--ring);
      outline-offset: 3px;
    }

    .container {
      width: 100%;
      max-width: 1120px;
      margin: 0 auto;
      display: flex;
      flex-direction: column;
      gap: 0.9rem;
    }

    /* App shell: sidebar navigation and main content */
    .app-layout { display: flex; min-height: 100vh; }
    .sidebar {
      width: 250px;
      flex-shrink: 0;
      position: sticky;
      top: 0;
      height: 100vh;
      display: flex;
      flex-direction: column;
      gap: 1rem;
      padding: 1rem 0.875rem;
      background: var(--surface);
      border-right: 1.5px solid var(--line);
      overflow-y: auto;
      z-index: 40;
    }
    .sidebar-footer { margin-top: auto; padding-top: 1rem; border-top: 1.5px solid var(--line-soft); }
    .main-wrapper { flex: 1; min-width: 0; padding: clamp(0.75rem, 2.4vw, 1.75rem); }
    .mobile-bar { display: none; margin-bottom: 0.75rem; }
    .mobile-toggle-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 2.25rem;
      height: 2.25rem;
      padding: 0;
      border: 1.5px solid var(--line);
      border-radius: 0.55rem;
      background: var(--surface);
      color: var(--ink);
    }
    .sidebar-backdrop { display: none; }

    /* Header */
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 1rem;
      padding: 0.75rem 0.25rem 1rem;
      background: transparent;
      border: 0;
      border-bottom: 1.5px solid var(--line);
      border-radius: 0;
      box-shadow: none;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }
    .brand-icon {
      width: 2.25rem;
      height: 2.25rem;
      flex: none;
      background: var(--coral);
      border: 1.5px solid var(--line);
      border-radius: 0.75rem 0.55rem 0.8rem 0.6rem;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      font-family: var(--font-display);
      font-size: 1rem;
      color: var(--primary-foreground);
      box-shadow: 3px 3px 0 var(--line);
      transform: rotate(-2deg);
    }
    .brand-text h1 {
      font-family: var(--font-display);
      font-size: 1.15rem;
      font-weight: 700;
      letter-spacing: -0.02em;
      line-height: 1.2;
    }
    .brand-text p {
      font-size: 0.75rem;
      color: var(--muted-foreground);
    }
    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      flex: none;
      padding: 0.3rem 0.75rem;
      border-radius: 9999px;
      font-size: 0.75rem;
      font-weight: 600;
      background: #fff8df;
      border: 1.5px solid var(--line);
      color: var(--ink);
    }
    .pulse-dot {
      width: 0.5rem;
      height: 0.5rem;
      border-radius: 50%;
      background: var(--teal);
      border: 1.5px solid var(--line);
    }
    /* Provider Switcher */
    .provider-bar {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      flex-wrap: wrap;
      background: var(--surface-soft);
      border: 1px solid var(--line-soft);
      border-radius: var(--radius);
      padding: 0.35rem 0.65rem;
    }
    .provider-label {
      font-size: 0.72rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--ink-soft);
    }
    .provider-group {
      display: flex;
      gap: 0.35rem;
    }
    .provider-btn {
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      padding: 0.28rem 0.65rem;
      border-radius: 0.4rem;
      font-size: 0.75rem;
      font-weight: 600;
      border: 1.5px solid var(--border);
      background: var(--surface-soft);
      color: var(--ink-soft);
      transition: all 0.15s ease;
    }
    .provider-btn:hover {
      background: var(--paper-deep);
      color: var(--ink);
      border-color: var(--line);
    }
    .provider-btn.active {
      background: var(--primary);
      border-color: var(--line);
      color: #ffffff;
      box-shadow: 1.5px 1.5px 0 var(--line);
    }
    .provider-btn .p-icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 14px;
      height: 14px;
      flex-shrink: 0;
      font-size: 0.85rem;
      line-height: 1;
    }
    .provider-btn .p-icon svg {
      width: 14px;
      height: 14px;
      display: block;
    }
    .btn-provider-submit {
      display: inline-flex;
      align-items: center;
      gap: 0.3rem;
      padding: 0.28rem 0.65rem;
      border-radius: 0.4rem;
      font-size: 0.75rem;
      font-weight: 700;
      border: 1.5px solid var(--border);
      background: var(--surface-soft);
      color: var(--ink-faint);
      box-shadow: 1.5px 1.5px 0 var(--border);
      transition: all 0.15s ease;
      cursor: not-allowed;
      opacity: 0.55;
    }
    .btn-provider-submit.pending {
      opacity: 1;
      cursor: pointer;
      background: var(--coral);
      border-color: var(--line);
      color: #ffffff;
      box-shadow: 1.5px 1.5px 0 var(--line);
    }
    .btn-provider-submit.pending:hover {
      background: var(--coral-dark);
      transform: translate(-1px, -1px);
      box-shadow: 2.5px 2.5px 0 var(--line);
    }
    .btn-provider-submit.pending:active {
      transform: translate(1px, 1px);
      box-shadow: 1px 1px 0 var(--line);
    }
    /* Navigation Tabs */
    .nav-tabs {
      display: flex;
      flex-direction: column;
      align-items: stretch;
      gap: 0.3rem;
      background: transparent;
      border: 0;
      padding: 0;
      box-shadow: none;
    }
    .nav-tabs::-webkit-scrollbar { display: none; }
    .nav-tab {
      display: flex;
      align-items: center;
      gap: 0.6rem;
      padding: 0.6rem 0.75rem;
      border: 0;
      border-left: 3px solid transparent;
      border-radius: 0.45rem;
      flex: 0 0 auto;
      font-family: var(--font-display);
      font-size: 0.8125rem;
      font-weight: 600;
      color: var(--muted-foreground);
      background: transparent;
      white-space: nowrap;
      transition: color 0.15s ease, background-color 0.15s ease, border-color 0.15s ease;
    }
    .nav-tab:hover {
      color: var(--foreground);
      background: #fff8df;
    }
    .nav-tab.active {
      color: var(--coral-dark);
      background: #fff8df;
      border-left-color: var(--coral);
    }
    .tab-badge {
      margin-left: auto;
      font-family: var(--font-mono);
      font-size: 0.6875rem;
      padding: 0.1rem 0.4rem;
      border-radius: 9999px;
      background: var(--paper-deep);
      color: inherit;
    }
    .tab-badge.badge-alert {
      background: #f8dfd8;
      color: #7d3430;
      font-weight: 700;
    }

    /* Tab Panes */
    .tab-pane {
      display: none;
      flex-direction: column;
      gap: 0.75rem;
    }
    .tab-pane.active {
      display: flex;
    }

    /* Cards */
    .card {
      background: var(--card);
      border: 1.5px solid var(--line);
      border-radius: 1rem 0.85rem 1.1rem 0.9rem;
      padding: 1.1rem 1.25rem;
      display: flex;
      flex-direction: column;
      gap: 1rem;
      box-shadow: var(--card-shadow);
    }
    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 0.75rem;
      border-bottom: 1.5px solid var(--border-subtle);
      padding-bottom: 0.65rem;
    }
    .card-title {
      font-family: var(--font-display);
      font-size: 0.9375rem;
      font-weight: 700;
      letter-spacing: -0.01em;
      display: flex;
      align-items: center;
      gap: 0.5rem;
      color: var(--foreground);
    }
    .card-title svg {
      color: var(--primary);
      flex: none;
    }
    .card-desc {
      font-size: 0.75rem;
      color: var(--muted-foreground);
    }

    .card-section-divider {
      height: 1.5px;
      background: var(--border-subtle);
      border: none;
      margin: 0.25rem 0;
    }
    .setup-section {
      display: flex;
      flex-direction: column;
      gap: 0.9rem;
    }

    /* Gateway Compact Bar */
    .gateway-bar {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 0.85rem;
      background: var(--surface-soft);
      border: 1px solid var(--line-soft);
      border-radius: 0.7rem 0.6rem 0.75rem 0.6rem;
      padding: 0.85rem 1rem;
    }
    .gateway-field {
      display: flex;
      flex-direction: column;
      gap: 0.35rem;
      min-width: 0;
    }
    .gateway-label-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 0.5rem;
    }
    .gateway-label {
      font-size: 0.6875rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      font-weight: 700;
      color: var(--muted-foreground);
    }
    .badge-sub {
      font-family: var(--font-body);
      font-size: 0.6875rem;
      padding: 0.15rem 0.5rem;
      border-radius: 9999px;
      font-weight: 600;
      letter-spacing: 0;
      text-transform: none;
    }
    .badge-active { background: var(--teal-soft); color: #174d48; border: 1px solid #99beb1; }
    .badge-inactive { background: var(--surface-soft); color: var(--ink-soft); border: 1px solid var(--line-soft); }
    .badge-warn { background: #fff1c9; color: #6b4b0c; border: 1px solid #ddc47d; }
    .badge-error { background: #f8dfd8; color: #7d3430; border: 1px solid #d59d91; }

    /* Inputs & Buttons */
    .input-group {
      display: flex;
      gap: 0.4rem;
      align-items: center;
    }
    input, select {
      width: 100%;
      min-width: 0;
      background: var(--surface-soft);
      border: 1.5px solid var(--input);
      border-radius: 0.55rem 0.45rem 0.6rem 0.5rem;
      padding: 0.5rem 0.7rem;
      font-size: 0.8125rem;
      color: var(--foreground);
      transition: border-color 0.15s ease, box-shadow 0.15s ease;
    }
    input[readonly] {
      background: var(--muted);
      color: var(--ink-soft);
      font-family: var(--font-mono);
      font-size: 0.8rem;
    }
    input::placeholder { color: var(--muted-foreground); }
    input[type="checkbox"] {
      width: 1rem;
      height: 1rem;
      accent-color: var(--primary);
    }
    input:focus, select:focus {
      border-color: var(--coral-dark);
      outline: none;
      box-shadow: 3px 3px 0 var(--yellow);
    }
    input:focus-visible, select:focus-visible {
      outline: 3px solid var(--primary);
      outline-offset: 3px;
    }
    select {
      cursor: pointer;
      background-image: url("data:image/svg+xml,%3csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 20 20'%3e%3cpath stroke='%2364748b' stroke-linecap='round' stroke-linejoin='round' stroke-width='1.5' d='M6 8l4 4 4-4'/%3e%3c/svg%3e");
      background-position: right 0.5rem center;
      background-repeat: no-repeat;
      background-size: 1.25em 1.25em;
      padding-right: 2rem;
      -webkit-appearance: none;
      appearance: none;
    }

    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 0.4rem;
      padding: 0.45rem 0.8rem;
      border-radius: 0.55rem 0.45rem 0.6rem 0.5rem;
      font-family: var(--font-display);
      font-size: 0.8125rem;
      font-weight: 600;
      border: 1.5px solid var(--line);
      background: var(--surface);
      color: var(--foreground);
      box-shadow: 2px 2px 0 var(--paper-deep);
      transition: color 0.15s ease, background-color 0.15s ease, transform 0.15s ease, box-shadow 0.15s ease;
      white-space: nowrap;
      user-select: none;
    }
    .btn:hover:not(:disabled) {
      color: var(--surface);
      background: var(--ink);
      border-color: var(--ink);
      transform: translate(-1px, -1px);
      box-shadow: 3px 3px 0 var(--paper-deep);
    }
    .btn:active:not(:disabled) {
      transform: translate(1px, 1px);
      box-shadow: 1px 1px 0 var(--paper-deep);
    }
    .btn-primary {
      background: var(--action);
      color: var(--ink);
      border-color: var(--line);
      box-shadow: 3px 3px 0 var(--line);
    }
    .btn-primary:hover:not(:disabled) {
      background: var(--action-hover);
      border-color: var(--line);
      color: var(--primary-foreground);
      transform: translate(-1px, -1px);
      box-shadow: 4px 4px 0 var(--line);
    }
    .btn-primary:active {
      background: var(--coral-dark);
      color: var(--primary-foreground);
      transform: translate(2px, 2px);
      box-shadow: 1px 1px 0 var(--line);
    }
    .btn-secondary {
      background: var(--surface);
      border-color: var(--line);
    }
    .btn-danger {
      background: var(--destructive);
      color: var(--destructive-foreground);
      border-color: var(--line);
      box-shadow: 3px 3px 0 var(--line);
    }
    .btn-danger:hover:not(:disabled) {
      background: var(--destructive-hover);
      border-color: var(--line);
      transform: translate(-1px, -1px);
      box-shadow: 4px 4px 0 var(--line);
    }
    .btn:disabled {
      cursor: not-allowed;
      opacity: 0.6;
      transform: none;
      box-shadow: 1px 1px 0 var(--paper-deep);
    }
    .btn-sm {
      padding: 0.35rem 0.6rem;
      font-size: 0.75rem;
    }
    .btn-link {
      background: none;
      border: none;
      color: var(--primary);
      font-size: 0.75rem;
      font-weight: 600;
      padding: 0;
      cursor: pointer;
    }
    .btn-link:hover {
      text-decoration: underline;
    }

    /* Clients Grid */
    .clients-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 0.75rem;
    }
    .client-card {
      background: var(--surface-soft);
      border: 1px solid var(--line-soft);
      border-radius: 0.7rem 0.6rem 0.75rem 0.6rem;
      padding: 0.85rem 1rem;
      display: flex;
      flex-direction: column;
      gap: 0.6rem;
    }
    .client-card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 0.5rem;
    }
    .client-title {
      font-family: var(--font-display);
      font-size: 0.875rem;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 0.4rem;
    }
    .client-path {
      font-family: var(--font-mono);
      font-size: 0.725rem;
      color: var(--muted-foreground);
      background: var(--card);
      border: 1px solid var(--border-subtle);
      border-radius: 0.35rem;
      padding: 0.35rem 0.5rem;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .client-actions {
      display: flex;
      justify-content: flex-end;
    }

    /* Quick Setup Toolbar */
    .setup-toolbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 0.75rem;
      padding-top: 0.5rem;
      border-top: 1px solid var(--border-subtle);
      flex-wrap: wrap;
    }
    .setup-target-group {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      flex: 1;
      min-width: 14rem;
    }
    .setup-target-group label {
      font-size: 0.8125rem;
      font-weight: 600;
      white-space: nowrap;
      color: var(--foreground);
    }
    .setup-target-group select {
      flex: 1;
      max-width: 22rem;
    }
    .instruction-card {
      background: #fff8df;
      border: 1.5px solid var(--line);
      border-left: 4px solid var(--yellow);
      border-radius: 0.65rem 0.55rem 0.7rem 0.6rem;
      padding: 0.6rem 0.85rem;
      font-size: 0.75rem;
      line-height: 1.45;
      color: var(--ink);
    }
    .instruction-card code {
      font-family: var(--font-mono);
      font-size: 0.75rem;
      background: rgba(0, 0, 0, 0.05);
      padding: 0.1rem 0.3rem;
      border-radius: 0.25rem;
    }

    /* Tier Model Grid */
    .tier-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 0.65rem;
    }
    .tier-item {
      display: flex;
      flex-direction: column;
      gap: 0.3rem;
      background: var(--surface-soft);
      border: 1px solid var(--line-soft);
      border-radius: 0.65rem 0.55rem 0.7rem 0.6rem;
      padding: 0.65rem 0.75rem;
    }
    .tier-label-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .tier-name {
      font-family: var(--font-display);
      font-size: 0.8125rem;
      font-weight: 600;
      color: var(--foreground);
    }
    .tier-hint {
      font-size: 0.6875rem;
      color: var(--muted-foreground);
    }
    .tier-item select {
      font-size: 0.785rem;
      padding: 0.38rem 0.55rem;
      background-color: var(--card);
    }
    .tier-actions {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 0.75rem;
      padding-top: 0.4rem;
      border-top: 1px solid var(--border-subtle);
    }

    /* Account Quota & Usage Remaining (5h & Weekly) */
    .quota-limits-section {
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
      background: var(--surface-soft);
      border: 1.5px solid var(--line);
      border-radius: 0.75rem 0.65rem 0.8rem 0.7rem;
      padding: 0.85rem 1rem;
    }
    .quota-limits-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 0.5rem;
      border-bottom: 1px solid var(--line-soft);
      padding-bottom: 0.5rem;
    }
    .quota-header-left {
      display: flex;
      align-items: center;
      gap: 0.6rem;
    }
    .quota-section-title {
      font-family: var(--font-display);
      font-size: 0.875rem;
      font-weight: 700;
      color: var(--ink);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .quota-plan-badge {
      font-family: var(--font-mono);
      font-size: 0.6875rem;
      font-weight: 700;
      background: #fff8df;
      color: var(--ink);
      border: 1.5px solid var(--line);
      border-radius: 9999px;
      padding: 0.15rem 0.55rem;
      text-transform: capitalize;
    }
    .quota-status-text {
      font-size: 0.75rem;
      color: var(--muted-foreground);
    }
    .quota-limits-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 0.85rem;
    }
    @media (max-width: 640px) {
      .quota-limits-grid {
        grid-template-columns: 1fr;
      }
    }
    .quota-card {
      background: var(--card);
      border: 1.5px solid var(--line);
      border-radius: 0.65rem 0.55rem 0.7rem 0.6rem;
      padding: 0.75rem 0.9rem;
      display: flex;
      flex-direction: column;
      gap: 0.6rem;
      box-shadow: 2px 2px 0 var(--paper-deep);
    }
    .quota-card-top {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 0.5rem;
    }
    .quota-card-title-group {
      display: flex;
      flex-direction: column;
      gap: 0.1rem;
    }
    .quota-window-name {
      font-family: var(--font-display);
      font-size: 0.875rem;
      font-weight: 700;
      color: var(--foreground);
    }
    .quota-window-type {
      font-size: 0.7rem;
      color: var(--muted-foreground);
    }
    .quota-percent-group {
      display: flex;
      flex-direction: column;
      align-items: flex-end;
    }
    .quota-remaining-val {
      font-family: var(--font-mono);
      font-size: 1.25rem;
      font-weight: 800;
      line-height: 1.1;
      color: var(--primary);
    }
    .quota-remaining-label {
      font-size: 0.65rem;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--muted-foreground);
      font-weight: 600;
    }
    .quota-bar-track {
      width: 100%;
      height: 0.55rem;
      background: var(--paper-deep);
      border: 1px solid var(--line-soft);
      border-radius: 9999px;
      overflow: hidden;
    }
    .quota-bar-fill {
      height: 100%;
      border-radius: 9999px;
      transition: width 0.35s ease, background-color 0.35s ease;
      background-color: var(--primary);
    }
    .quota-card-meta {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 0.75rem;
      color: var(--muted-foreground);
      border-top: 1px dashed var(--border-subtle);
      padding-top: 0.4rem;
    }
    .quota-card-meta strong {
      font-family: var(--font-mono);
      color: var(--foreground);
      font-weight: 600;
    }
    .quota-meta-item {
      display: flex;
      align-items: center;
      gap: 0.3rem;
    }
    .quota-meta-right {
      justify-content: flex-end;
    }

    /* Usage Stats Strip */
    .usage-metrics {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      background: var(--surface-soft);
      border: 1.5px solid var(--line);
      border-radius: 0.7rem 0.6rem 0.75rem 0.6rem;
      overflow: hidden;
    }
    .usage-stat {
      padding: 0.65rem 1rem;
      display: flex;
      flex-direction: column;
      gap: 0.15rem;
    }
    .usage-stat + .usage-stat {
      border-left: 1px solid var(--line-soft);
    }
    .metric-title {
      font-size: 0.6875rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--muted-foreground);
      font-weight: 700;
    }
    .metric-value {
      font-family: var(--font-mono);
      font-size: 1.15rem;
      font-weight: 700;
      color: var(--foreground);
    }
    .metric-sub {
      font-size: 0.6875rem;
      color: var(--muted-foreground);
    }

    /* Usage Table */
    .usage-table-wrapper {
      overflow-x: auto;
      border: 1.5px solid var(--line);
      border-radius: 0.7rem 0.6rem 0.75rem 0.6rem;
      background: var(--surface);
    }
    .usage-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.8125rem;
      text-align: left;
    }
    .usage-table th {
      background: var(--surface-soft);
      color: var(--muted-foreground);
      font-size: 0.6875rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      font-weight: 700;
      padding: 0.5rem 0.75rem;
      border-bottom: 1px solid var(--border);
    }
    .usage-table td {
      padding: 0.55rem 0.75rem;
      border-bottom: 1px solid var(--border-subtle);
      color: var(--foreground);
    }
    .usage-table tbody tr:hover {
      background: #fff8df;
    }
    .usage-table tfoot td {
      background: var(--accent);
      color: var(--accent-foreground);
      font-weight: 700;
      border-top: 2px solid var(--primary);
      border-bottom: none;
    }
    .usage-empty {
      padding: 1.5rem !important;
      text-align: center;
      color: var(--muted-foreground);
    }
    .num-col {
      text-align: right;
      font-family: var(--font-mono);
      font-variant-numeric: tabular-nums;
    }
    .model-tag {
      font-family: var(--font-mono);
      font-weight: 600;
      font-size: 0.785rem;
    }
    .share-pill {
      font-family: var(--font-mono);
      font-size: 0.725rem;
      font-weight: 600;
      color: var(--muted-foreground);
    }

    /* Logs & Terminal */
    .logs-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 0.5rem;
    }
    .logs-badges {
      display: flex;
      align-items: center;
      gap: 0.4rem;
      flex-wrap: wrap;
    }
    #badge-log-file {
      max-width: 14rem;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-family: var(--font-mono);
      font-size: 0.6875rem;
      color: var(--muted-foreground);
    }
    .logs-toolbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 0.6rem;
      flex-wrap: wrap;
    }
    .logs-filter-group {
      display: flex;
      align-items: center;
      gap: 0.4rem;
      flex: 1;
      min-width: 16rem;
    }
    .logs-filter-group input {
      flex: 1;
      font-size: 0.785rem;
      padding: 0.4rem 0.6rem;
    }
    .logs-filter-group select {
      width: auto;
      min-width: 6.5rem;
      font-size: 0.785rem;
      padding: 0.4rem 0.6rem;
    }
    .logs-controls {
      display: flex;
      align-items: center;
      gap: 0.4rem;
    }
    .auto-refresh-toggle {
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      font-size: 0.75rem;
      font-weight: 600;
      color: var(--foreground);
      cursor: pointer;
      user-select: none;
      margin-right: 0.3rem;
    }
    .auto-refresh-toggle input {
      width: auto;
      cursor: pointer;
    }
    .log-terminal {
      background: var(--ink);
      color: var(--surface);
      border: 1.5px solid var(--line);
      border-radius: var(--radius);
      padding: 0.75rem 0.85rem;
      font-family: var(--font-mono);
      font-size: 0.75rem;
      line-height: 1.5;
      height: 340px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
    }
    .log-terminal.is-empty {
      height: 120px;
    }
    .log-row {
      display: flex;
      align-items: flex-start;
      gap: 0.45rem;
      padding: 0.15rem 0.25rem;
      border-radius: 0.2rem;
      word-break: break-all;
    }
    .log-row:hover {
      background: rgba(255, 255, 255, 0.05);
    }
    .log-time {
      color: #a6b2aa;
      flex: none;
      font-size: 0.7rem;
    }
    .log-tag {
      flex: none;
      font-size: 0.625rem;
      font-weight: 700;
      padding: 0.05rem 0.35rem;
      border-radius: 0.2rem;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .log-tag-info { background: #244c3e; color: #d2ebde; }
    .log-tag-warn { background: #604512; color: #ffe19a; }
    .log-tag-error { background: #672f2b; color: #ffd4c9; }
    .log-op {
      color: #9ad8cf;
      flex: none;
      font-size: 0.7rem;
    }
    .log-msg {
      flex: 1;
      color: var(--surface);
    }
    .log-details-chip {
      color: #b4c0b8;
      font-size: 0.7rem;
      margin-left: 0.3rem;
    }
    .log-empty {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: #a6b2aa;
      font-size: 0.75rem;
    }

    /* Advanced Panel */
    .advanced-panel {
      border: 1.5px solid var(--line);
      border-radius: 0.9rem 0.75rem 1rem 0.8rem;
      background: var(--surface);
      overflow: hidden;
      box-shadow: var(--card-shadow);
    }
    .advanced-panel summary {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 0.75rem 1.15rem;
      cursor: pointer;
      font-family: var(--font-display);
      font-size: 0.875rem;
      font-weight: 600;
      color: var(--foreground);
      user-select: none;
      list-style: none;
    }
    .advanced-panel summary::-webkit-details-marker { display: none; }
    .advanced-panel summary:hover {
      background: var(--surface-soft);
    }
    .advanced-hint {
      font-family: var(--font-body);
      font-size: 0.725rem;
      color: var(--muted-foreground);
      font-weight: 400;
    }
    .advanced-content {
      padding: 0.85rem 1.15rem;
      border-top: 1px solid var(--line-soft);
      display: flex;
      flex-direction: column;
      gap: 0.85rem;
    }
    .danger-title {
      color: var(--destructive);
    }
    .supporting-text {
      font-size: 0.75rem;
      color: var(--muted-foreground);
    }
    .code-snippet {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.75rem;
      background: var(--surface-soft);
      border: 1.5px solid var(--line);
      padding: 0.5rem 0.75rem;
      border-radius: 0.65rem 0.55rem 0.7rem 0.6rem;
      font-family: var(--font-mono);
      font-size: 0.75rem;
      color: var(--foreground);
    }
    .code-snippet span {
      overflow-wrap: anywhere;
    }

    /* Toast */
    #toast {
      position: fixed;
      bottom: 1.25rem;
      right: 1.25rem;
      max-width: 22rem;
      padding: 0.65rem 1rem;
      border-radius: 0.65rem 0.55rem 0.7rem 0.6rem;
      font-size: 0.8125rem;
      font-weight: 600;
      box-shadow: 3px 3px 0 var(--line);
      opacity: 0;
      transform: translateY(0.75rem);
      transition: all 0.2s ease;
      z-index: 9999;
      pointer-events: none;
    }
    #toast.show {
      opacity: 1;
      transform: translateY(0);
    }
    #toast.success {
      background: var(--teal-soft);
      color: #174d48;
      border: 1.5px solid var(--line);
    }
    #toast.error {
      background: #f8dfd8;
      color: #7d3430;
      border: 1.5px solid var(--line);
    }

    /* Responsive */
    @media (max-width: 960px) {
      .sidebar {
        position: fixed;
        left: 0;
        top: 0;
        bottom: 0;
        height: auto;
        transform: translateX(-100%);
        transition: transform 0.25s ease;
        box-shadow: 4px 0 0 var(--paper-deep);
      }
      .sidebar.open { transform: translateX(0); }
      .mobile-bar { display: flex; }
      .sidebar-backdrop {
        position: fixed;
        inset: 0;
        z-index: 35;
        background: rgba(23, 32, 29, 0.4);
      }
      .sidebar-backdrop.active { display: block; }
    }
    @media (max-width: 768px) {
      header { align-items: flex-start; flex-direction: column; }
      .gateway-bar { grid-template-columns: 1fr; }
      .clients-grid { grid-template-columns: 1fr; }
      .tier-grid { grid-template-columns: repeat(2, 1fr); }
      .usage-metrics { grid-template-columns: repeat(2, 1fr); }
      .usage-stat:nth-child(3) { border-left: none; }
      .setup-toolbar { flex-direction: column; align-items: stretch; }
      .setup-target-group select { max-width: none; }
      .logs-toolbar { flex-direction: column; align-items: stretch; }
      .logs-filter-group { min-width: 0; }
      .logs-controls { flex-wrap: wrap; }
    }
    @media (max-width: 480px) {
      .main-wrapper { padding: 0.75rem; }
      header { gap: 0.75rem; }
      .brand-text h1 { font-size: 1.05rem; }
      .status-badge { font-size: 0.7rem; }
      .card { padding: 0.9rem; }
      .tier-grid { grid-template-columns: 1fr; }
      .usage-metrics { grid-template-columns: 1fr; }
      .usage-stat + .usage-stat { border-left: none; border-top: 1px solid var(--border); }
      .setup-target-group { min-width: 0; align-items: stretch; flex-direction: column; }
      .advanced-panel summary { align-items: flex-start; flex-direction: column; gap: 0.25rem; }
      .logs-filter-group { flex-direction: column; align-items: stretch; }
      .logs-filter-group select { width: 100%; }
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { scroll-behavior: auto !important; transition-duration: 0.01ms !important; }
    }
  </style>
</head>
<body>
  <div class="app-layout">
    <aside class="sidebar" id="app-sidebar">
    <header>
      <div class="brand">
        <div class="brand-icon">CC</div>
        <div class="brand-text">
          <h1>Codex2CC Control Panel</h1>
          <p>Local gateway · Claude client setup</p>
        </div>
      </div>
    </header>

    <!-- Navigation Tabs -->
    <nav class="nav-tabs" role="tablist" aria-label="Control Panel Sections">
      <button class="nav-tab active" data-tab="tab-setup" role="tab" aria-selected="true" id="tab-btn-setup" type="button">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
        <span>Setup</span>
      </button>
      <button class="nav-tab" data-tab="tab-usage" role="tab" aria-selected="false" id="tab-btn-usage" type="button">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
        <span>Token Usage</span>
        <span class="tab-badge" id="tab-badge-tokens">0</span>
      </button>
      <button class="nav-tab" data-tab="tab-logs" role="tab" aria-selected="false" id="tab-btn-logs" type="button">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
        <span>Activity Logs</span>
        <span class="tab-badge" id="tab-badge-logs">0</span>
      </button>
      <button class="nav-tab" data-tab="tab-advanced" role="tab" aria-selected="false" id="tab-btn-advanced" type="button">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
        <span>Advanced</span>
      </button>
    </nav>


    <div class="sidebar-footer">
      <div class="status-badge" id="gateway-badge">
        <span class="pulse-dot"></span>
        <span id="gateway-status-text">Checking gateway...</span>
      </div>
    </div>
    </aside>
    <div class="sidebar-backdrop" id="sidebar-backdrop" aria-hidden="true"></div>

    <main class="main-wrapper">
      <div class="mobile-bar">
        <button class="mobile-toggle-btn" id="btn-toggle-sidebar" type="button" aria-label="Toggle navigation menu">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
        </button>
      </div>
    <div class="container">
    <!-- Setup: provider, gateway endpoint, Claude clients and model map -->
    <div class="tab-pane active" id="tab-setup" role="tabpanel">
      <section class="card" aria-label="Setup and configuration">
        <!-- Top row: Provider switcher -->
        <div class="provider-bar">
          <span class="provider-label">Provider</span>
          <div class="provider-group" id="provider-selector" role="radiogroup" aria-label="Active LLM Provider">
            <button class="provider-btn active" id="btn-provider-codex" type="button" data-provider="codex" role="radio" aria-checked="true" title="Use ChatGPT Codex subscription">
              <span class="p-icon">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M14.949 6.547a3.94 3.94 0 0 0-.348-3.273 4.11 4.11 0 0 0-4.4-1.934A4.1 4.1 0 0 0 8.423.2 4.15 4.15 0 0 0 6.305.086a4.1 4.1 0 0 0-1.891.948 4.04 4.04 0 0 0-1.158 1.753 4.1 4.1 0 0 0-1.563.679A4 4 0 0 0 .554 4.72a3.99 3.99 0 0 0 .502 4.731 3.94 3.94 0 0 0 .346 3.274 4.11 4.11 0 0 0 4.402 1.933c.382.425.852.764 1.377.995.526.231 1.095.35 1.67.346 1.78.002 3.358-1.132 3.901-2.804a4.1 4.1 0 0 0 1.563-.68 4 4 0 0 0 1.14-1.253 3.99 3.99 0 0 0-.506-4.716m-6.097 8.406a3.05 3.05 0 0 1-1.945-.694l.096-.054 3.23-1.838a.53.53 0 0 0 .265-.455v-4.49l1.366.778q.02.011.025.035v3.722c-.003 1.653-1.361 2.992-3.037 2.996m-6.53-2.75a2.95 2.95 0 0 1-.36-2.01l.095.057L5.29 12.09a.53.53 0 0 0 .527 0l3.949-2.246v1.555a.05.05 0 0 1-.022.041L6.473 13.3c-1.454.826-3.311.335-4.15-1.098m-.85-6.94A3.02 3.02 0 0 1 3.07 3.949v3.785a.51.51 0 0 0 .262.451l3.93 2.237-1.366.779a.05.05 0 0 1-.048 0L2.585 9.342a2.98 2.98 0 0 1-1.113-4.094zm11.216 2.571L8.747 5.576l1.362-.776a.05.05 0 0 1 .048 0l3.265 1.86a3 3 0 0 1 1.173 1.207 2.96 2.96 0 0 1-.27 3.2 3.05 3.05 0 0 1-1.36.997V8.279a.52.52 0 0 0-.276-.445m1.36-2.015-.097-.057-3.226-1.855a.53.53 0 0 0-.53 0L6.249 6.153V4.598a.04.04 0 0 1 .019-.04L9.533 2.7a3.07 3.07 0 0 1 3.257.139c.474.325.843.778 1.066 1.303.223.526.289 1.103.191 1.664zM5.503 8.575 4.139 7.8a.05.05 0 0 1-.026-.037V4.049c0-.57.166-1.127.476-1.607s.752-.864 1.275-1.105a3.08 3.08 0 0 1 3.234.41l-.096.054-3.23 1.838a.53.53 0 0 0-.265.455zm.742-1.577 1.758-1 1.762 1v2l-1.755 1-1.762-1z"/></svg>
              </span>
              <span>ChatGPT (Codex)</span>
            </button>
            <button class="provider-btn" id="btn-provider-antigravity" type="button" data-provider="antigravity" role="radio" aria-checked="false" title="Use Google Antigravity (agy) session">
              <span class="p-icon">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/></svg>
              </span>
              <span>Antigravity (agy)</span>
            </button>
          </div>
          <button class="btn btn-primary btn-provider-submit" id="btn-provider-submit" type="button" disabled title="Click to apply and switch provider">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
            <span>Submit</span>
          </button>
        </div>

        <p class="instruction-card" id="provider-hint" hidden>Antigravity needs the <code>agy</code> CLI. Put agy on the gateway's PATH, or set <code>CODEX2CC_AGY_BIN</code> to its full path, then restart the gateway.</p>

        <!-- Gateway Credentials Bar -->
        <div class="gateway-bar">
          <div class="gateway-field">
            <div class="gateway-label-row">
              <span class="gateway-label">Gateway Endpoint</span>
              <span class="badge-sub badge-active" id="val-auth-mode">Token Protected</span>
            </div>
            <div class="input-group">
              <input type="text" id="input-url" placeholder="http://127.0.0.1:3456" readonly />
              <span id="val-gateway-url" style="display:none">--</span>
              <button class="btn btn-secondary btn-sm" id="btn-copy-url" type="button" title="Copy Gateway URL">Copy</button>
            </div>
          </div>
          <div class="gateway-field">
            <div class="gateway-label-row">
              <span class="gateway-label">Auth Token</span>
              <button class="btn-link" id="btn-toggle-token" type="button">Show</button>
            </div>
            <div class="input-group">
              <input type="password" id="input-token" autocomplete="off" placeholder="No token required" readonly />
              <button class="btn btn-secondary btn-sm" id="btn-copy-token" type="button" title="Copy token">Copy</button>
            </div>
          </div>
        </div>

        <div class="card-section-divider"></div>

        <!-- Clients Configuration Section -->
        <div class="setup-section" aria-labelledby="configuration-title">
          <div class="card-header">
            <h2 class="card-title" id="configuration-title">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
              Claude Clients Connection
            </h2>
            <span class="card-desc">Sync settings for Claude Code CLI and Desktop app</span>
          </div>

          <div class="clients-grid">
            <!-- Claude Code CLI Card -->
            <div class="client-card">
              <div class="client-card-header">
                <div class="client-title">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
                  Claude Code CLI
                </div>
                <span class="badge-sub" id="badge-cli">Checking...</span>
              </div>
              <div class="client-path" id="val-cli-path">~/.claude/settings.json</div>
              <div class="client-actions">
                <button class="btn btn-secondary btn-sm" id="btn-quick-cli" type="button">Sync CLI</button>
              </div>
            </div>

            <!-- Claude Desktop Card -->
            <div class="client-card">
              <div class="client-card-header">
                <div class="client-title">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
                  Claude Desktop
                </div>
                <span class="badge-sub" id="badge-desktop">Checking...</span>
              </div>
              <div class="client-path">Claude-3p/configLibrary</div>
              <div class="client-actions">
                <button class="btn btn-secondary btn-sm" id="btn-quick-desktop" type="button">Sync Desktop</button>
              </div>
            </div>
          </div>

          <div class="setup-toolbar">
            <div class="setup-target-group">
              <label for="select-target">Apply target:</label>
              <select id="select-target">
                <option value="all">Both clients (Recommended)</option>
                <option value="cli">Claude Code CLI only (~/.claude/settings.json)</option>
                <option value="desktop">Claude Desktop only</option>
              </select>
            </div>
            <button class="btn btn-primary" id="btn-apply" type="button">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
              Apply configuration
            </button>
          </div>

          <p class="instruction-card"><strong>Next:</strong> Restart Claude Desktop and choose “Continue with Gateway” (not claude.ai). Reload your terminal or editor before running <code>claude</code>.</p>
        </div>

        <div class="card-section-divider"></div>

        <!-- Model Routing Section -->
        <div class="setup-section" aria-labelledby="tier-mapping-title">
          <div class="card-header">
            <h2 class="card-title" id="tier-mapping-title">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h16M4 12h16M4 17h16"/><circle cx="8" cy="7" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="10" cy="17" r="2"/></svg>
              Model routing
            </h2>
            <span class="badge-sub" id="tier-mapping-status">Loading…</span>
          </div>
          <p class="card-desc" id="tier-mapping-desc">Map each Claude tier to a backend model. Changes apply immediately upon saving.</p>

          <div class="tier-grid">
            <div class="tier-item">
              <div class="tier-label-row">
                <label for="tier-fable" class="tier-name">Fable</label>
                <span class="tier-hint">Preview</span>
              </div>
              <select id="tier-fable" data-tier="fable"></select>
            </div>
            <div class="tier-item">
              <div class="tier-label-row">
                <label for="tier-opus" class="tier-name">Opus</label>
                <span class="tier-hint">Reasoning</span>
              </div>
              <select id="tier-opus" data-tier="opus"></select>
            </div>
            <div class="tier-item">
              <div class="tier-label-row">
                <label for="tier-sonnet" class="tier-name">Sonnet</label>
                <span class="tier-hint">Coding / Daily</span>
              </div>
              <select id="tier-sonnet" data-tier="sonnet"></select>
            </div>
            <div class="tier-item">
              <div class="tier-label-row">
                <label for="tier-haiku" class="tier-name">Haiku</label>
                <span class="tier-hint">Fast / Light</span>
              </div>
              <select id="tier-haiku" data-tier="haiku"></select>
            </div>
          </div>

          <div class="effort-row" style="display:flex;align-items:center;justify-content:space-between;padding:0.75rem 1rem;background:var(--surface-soft);border:1px solid var(--line-soft);border-radius:0.6rem;">
            <div>
              <label for="select-effort" style="font-weight:600;font-size:0.875rem;">Thinking Level</label>
              <p style="font-size:0.75rem;color:var(--muted-foreground);margin:0.15rem 0 0 0;">Default thinking level applied to reasoning models (saved to settings.json).</p>
            </div>
            <select id="select-effort" style="width:auto;min-width:140px;padding:0.4rem 0.6rem;border-radius:0.45rem;border:1.5px solid var(--input);background:var(--surface);color:inherit;">
              <option value="">Default (None)</option>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="xhigh">X-High</option>
              <option value="max">Max</option>
            </select>
          </div>

          <div class="tier-actions">
            <span class="supporting-text">Re-apply client setup and reload Claude Code to refresh saved model aliases.</span>
            <div style="display:flex;gap:0.5rem;">
              <button class="btn btn-secondary btn-sm" id="btn-reset-tier-mapping" type="button">Use defaults</button>
              <button class="btn btn-primary btn-sm" id="btn-save-tier-mapping" type="button">Save mapping</button>
            </div>
          </div>
        </div>
      </section>
    </div>

    <!-- Tab 3: Token Usage -->
    <div class="tab-pane" id="tab-usage" role="tabpanel">
      <section class="card" id="section-usage" aria-labelledby="usage-title">
        <div class="card-header">
          <h2 class="card-title" id="usage-title">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
            Token usage & quota limits
          </h2>
          <div class="logs-controls">
            <button class="btn btn-secondary btn-sm" id="btn-refresh-usage" type="button" title="Refresh token usage & limits">Refresh</button>
            <button class="btn btn-secondary btn-sm" id="btn-reset-usage" type="button" title="Reset token usage counters">Reset counters</button>
          </div>
        </div>

        <!-- Account Quota & Remaining Limits (5h & Weekly) -->
        <div class="quota-limits-section" id="quota-limits-section">
          <div class="quota-limits-header">
            <div class="quota-header-left">
              <span class="quota-section-title">Usage remaining</span>
              <span class="quota-plan-badge" id="quota-plan-badge">Account limits</span>
            </div>
            <span class="quota-status-text" id="quota-status-text">Synchronized with ChatGPT account</span>
          </div>

          <div class="quota-limits-grid">
            <!-- 5-Hour Window -->
            <div class="quota-card" id="card-quota-5h">
              <div class="quota-card-top">
                <div class="quota-card-title-group">
                  <span class="quota-window-name">5-hour window</span>
                  <span class="quota-window-sub">Rolling session quota</span>
                </div>
                <div class="quota-percent-group">
                  <span class="quota-remaining-val" id="val-5h-remaining">--%</span>
                  <span class="quota-remaining-label">remaining</span>
                </div>
              </div>

              <div class="quota-bar-track">
                <div class="quota-bar-fill" id="bar-5h" style="width: 0%;"></div>
              </div>

              <div class="quota-card-meta">
                <div class="quota-meta-item">
                  <span class="quota-meta-label">Used:</span>
                  <strong id="val-5h-used">--%</strong>
                </div>
                <div class="quota-meta-item quota-meta-right">
                  <span class="quota-meta-label">Resets in:</span>
                  <strong id="val-5h-reset">--</strong>
                </div>
              </div>
            </div>

            <!-- Weekly Allowance -->
            <div class="quota-card" id="card-quota-weekly">
              <div class="quota-card-top">
                <div class="quota-card-title-group">
                  <span class="quota-window-name">Weekly allowance</span>
                  <span class="quota-window-sub">7-day capacity limit</span>
                </div>
                <div class="quota-percent-group">
                  <span class="quota-remaining-val" id="val-weekly-remaining">--%</span>
                  <span class="quota-remaining-label">remaining</span>
                </div>
              </div>

              <div class="quota-bar-track">
                <div class="quota-bar-fill" id="bar-weekly" style="width: 0%;"></div>
              </div>

              <div class="quota-card-meta">
                <div class="quota-meta-item">
                  <span class="quota-meta-label">Used:</span>
                  <strong id="val-weekly-used">--%</strong>
                </div>
                <div class="quota-meta-item quota-meta-right">
                  <span class="quota-meta-label">Resets in:</span>
                  <strong id="val-weekly-reset">--</strong>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="usage-metrics" aria-label="Token usage totals">
          <div class="usage-stat">
            <span class="metric-title">Total tokens</span>
            <span class="metric-value" id="val-total-tokens">0</span>
            <span class="metric-sub" id="val-total-reqs">0 requests</span>
          </div>
          <div class="usage-stat">
            <span class="metric-title">Input</span>
            <span class="metric-value" id="val-input-tokens">0</span>
          </div>
          <div class="usage-stat">
            <span class="metric-title">Output</span>
            <span class="metric-value" id="val-output-tokens">0</span>
          </div>
          <div class="usage-stat">
            <span class="metric-title">Cache read</span>
            <span class="metric-value" id="val-cached-tokens">0</span>
          </div>
        </div>

        <div class="usage-table-wrapper">
          <table class="usage-table" id="usage-table">
            <thead>
              <tr>
                <th>Model</th>
                <th class="num-col">Requests</th>
                <th class="num-col">Input</th>
                <th class="num-col">Output</th>
                <th class="num-col">Cache read</th>
                <th class="num-col">Total</th>
                <th class="num-col">Share</th>
              </tr>
            </thead>
            <tbody id="usage-table-body">
              <tr>
                <td colspan="7" class="usage-empty">No usage yet. Send a request through the gateway to see model totals.</td>
              </tr>
            </tbody>
            <tfoot id="usage-table-foot" style="display: none;">
              <tr>
                <td><strong>All models</strong></td>
                <td class="num-col" id="foot-reqs">0</td>
                <td class="num-col" id="foot-input">0</td>
                <td class="num-col" id="foot-output">0</td>
                <td class="num-col" id="foot-cached">0</td>
                <td class="num-col" id="foot-total">0</td>
                <td class="num-col">100.0%</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </section>
    </div>

    <!-- Tab 4: Live Logs -->
    <div class="tab-pane" id="tab-logs" role="tabpanel">
      <section class="card" id="section-logs" aria-labelledby="logs-title">
        <div class="card-header logs-header">
          <h2 class="card-title" id="logs-title">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
            Gateway activity
          </h2>
          <div class="logs-badges">
            <span class="badge-sub badge-active" id="badge-log-count">0 logs</span>
            <span class="badge-sub badge-warn" id="badge-warn-count" style="display:none;">0 warnings</span>
            <span class="badge-sub badge-error" id="badge-err-count" style="display:none;">0 errors</span>
            <span id="badge-log-file"></span>
          </div>
        </div>

        <div class="logs-toolbar">
          <div class="logs-filter-group">
            <input type="search" id="input-log-search" aria-label="Search logs" placeholder="Filter logs by operation, message..." />
            <select id="select-log-level" aria-label="Log level">
              <option value="all">All levels</option>
              <option value="info">Info</option>
              <option value="warn">Warnings</option>
              <option value="error">Errors</option>
            </select>
          </div>
          <div class="logs-controls">
            <label class="auto-refresh-toggle" title="Stream live traffic events via Server-Sent Events">
              <input type="checkbox" id="check-auto-refresh" checked />
              Live Stream
            </label>
            <button class="btn btn-secondary btn-sm" id="btn-refresh-logs" type="button" title="Fetch latest logs">Refresh</button>
            <button class="btn btn-secondary btn-sm" id="btn-copy-logs" type="button" title="Copy visible logs">Copy</button>
            <button class="btn btn-secondary btn-sm" id="btn-clear-logs" type="button" title="Clear log history">Clear</button>
          </div>
        </div>

        <div class="log-terminal is-empty" id="log-terminal" role="log" aria-live="polite">
          <div class="log-empty">Connecting to gateway log feed…</div>
        </div>
      </section>
    </div>

    <!-- Tab 5: Advanced -->
    <div class="tab-pane" id="tab-advanced" role="tabpanel">
      <details class="advanced-panel" open>
        <summary>
          <span>Advanced actions</span>
          <span class="advanced-hint">Reset client settings or copy the gateway launch command</span>
        </summary>
        <div class="advanced-content">
          <section class="card" style="border-left: 3px solid var(--destructive);" aria-labelledby="reset-title">
            <div class="card-header">
              <h2 class="card-title danger-title" id="reset-title">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                Reset client configuration
              </h2>
            </div>
            <p class="supporting-text">Restore Anthropic defaults for selected clients. Chat history and unrelated environment variables are preserved.</p>
            <div style="display:flex;gap:0.5rem;flex-wrap:wrap;padding-top:0.4rem;">
              <button class="btn btn-danger btn-sm" id="btn-reset-all" type="button">Reset both clients</button>
              <button class="btn btn-secondary btn-sm" id="btn-reset-cli" type="button">Reset CLI</button>
              <button class="btn btn-secondary btn-sm" id="btn-reset-desktop" type="button">Reset Desktop</button>
            </div>
          </section>

          <section class="card" aria-labelledby="command-title">
            <div class="card-header">
              <h2 class="card-title" id="command-title">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
                Gateway CLI command
              </h2>
            </div>
            <div class="code-snippet">
              <span id="text-run-cmd">CODEX2CC_TOKEN="..." node dist/main.js --serve --port 3456</span>
              <button class="btn btn-secondary btn-sm" id="btn-copy-cmd" type="button">Copy</button>
            </div>
          </section>
        </div>
      </details>
    </div>
    </div>
    </main>
  </div>

  <div id="toast" role="status" aria-live="polite"></div>

  <script>
    let currentStatus = null;

    function showToast(msg, type = "success") {
      const el = document.getElementById("toast");
      el.textContent = msg;
      el.className = "show " + type;
      setTimeout(() => { el.className = ""; }, 3500);
    }

    /* Tab Controller */
    const appSidebar = document.getElementById("app-sidebar");
    const sidebarBackdrop = document.getElementById("sidebar-backdrop");

    function toggleSidebar(forceState) {
      const isOpen = forceState !== undefined ? forceState : !appSidebar.classList.contains("open");
      appSidebar.classList.toggle("open", isOpen);
      sidebarBackdrop.classList.toggle("active", isOpen);
    }

    document.getElementById("btn-toggle-sidebar").addEventListener("click", () => toggleSidebar());
    sidebarBackdrop.addEventListener("click", () => toggleSidebar(false));

    function setupTabs() {
      const tabs = document.querySelectorAll(".nav-tab");
      const panes = document.querySelectorAll(".tab-pane");

      function activateTab(tabId) {
        tabs.forEach(t => {
          const active = t.dataset.tab === tabId;
          t.classList.toggle("active", active);
          t.setAttribute("aria-selected", active ? "true" : "false");
        });
        panes.forEach(p => {
          p.classList.toggle("active", p.id === tabId);
        });
        try {
          localStorage.setItem("codex2cc_tab", tabId);
          history.replaceState(null, "", "#" + tabId.replace("tab-", ""));
        } catch {}
        if (tabId === "tab-usage") {
          fetchUsage();
        }
      }

      tabs.forEach(tab => {
        tab.addEventListener("click", () => {
          activateTab(tab.dataset.tab);
          toggleSidebar(false);
        });
      });

      const hash = window.location.hash.replace("#", "");
      const savedTab = hash ? "tab-" + hash : (localStorage.getItem("codex2cc_tab") || "tab-setup");
      if (document.getElementById(savedTab)) {
        activateTab(savedTab);
      } else {
        activateTab("tab-setup");
      }
    }

    async function fetchStatus() {
      try {
        const res = await fetch("/api/ui/status");
        if (!res.ok) throw new Error("HTTP " + res.status);
        currentStatus = await res.json();
        renderStatus(currentStatus);
        document.getElementById("gateway-status-text").textContent = "Server running";
      } catch (err) {
        document.getElementById("gateway-status-text").textContent = "Gateway Unavailable";
        showToast("Failed to fetch gateway status: " + err.message, "error");
      }
    }

    let currentActiveProvider = "codex";
    let selectedProvider = "codex";
    let isProviderSwitching = false;

    function updateProviderControls(availableList) {
      const btnCodex = document.getElementById("btn-provider-codex");
      const btnAnt = document.getElementById("btn-provider-antigravity");
      const btnSubmit = document.getElementById("btn-provider-submit");
      if (!btnCodex || !btnAnt) return;

      if (Array.isArray(availableList)) {
        const antigravityReady = availableList.some((p) => p.id === "antigravity" && p.available);
        btnAnt.disabled = !antigravityReady && currentActiveProvider !== "antigravity";
        btnAnt.title = antigravityReady ? "Use Google Antigravity (agy) session" : "agy binary not found on PATH";
        document.getElementById("provider-hint").hidden = antigravityReady;
      }

      btnCodex.classList.toggle("active", selectedProvider === "codex");
      btnCodex.setAttribute("aria-checked", selectedProvider === "codex" ? "true" : "false");
      btnAnt.classList.toggle("active", selectedProvider === "antigravity");
      btnAnt.setAttribute("aria-checked", selectedProvider === "antigravity" ? "true" : "false");

      const isPending = selectedProvider !== currentActiveProvider;
      if (btnSubmit) {
        btnSubmit.disabled = isProviderSwitching || !isPending;
        btnSubmit.classList.toggle("pending", isPending && !isProviderSwitching);
        if (isPending) {
          btnSubmit.title = "Click to apply and switch to " + (selectedProvider === "antigravity" ? "Google Antigravity" : "ChatGPT Codex");
        } else {
          btnSubmit.title = "Active provider already selected";
        }
      }
    }

    function selectProvider(target) {
      if (isProviderSwitching) return;
      if (target !== "codex" && target !== "antigravity") return;
      const btn = document.getElementById(target === "codex" ? "btn-provider-codex" : "btn-provider-antigravity");
      if (btn?.disabled) return;
      selectedProvider = target;
      updateProviderControls();
    }

    function renderStatus(s) {
      document.getElementById("val-gateway-url").textContent = s.gateway.url;
      document.getElementById("val-auth-mode").textContent = s.gateway.policyMode === "token" ? "Token Protected" : "Open (--no-auth)";

      if (s.provider) {
        const previousActiveProvider = currentActiveProvider;
        currentActiveProvider = s.provider.active;
        if (!isProviderSwitching) {
          selectedProvider = selectedProvider === previousActiveProvider ? currentActiveProvider : selectedProvider;
        }
        updateProviderControls(s.provider.available);
        const descElem = document.getElementById("tier-mapping-desc");
        if (descElem) {
          descElem.textContent = currentActiveProvider === "antigravity"
            ? "Map each Claude tier to a Google Antigravity (agy) model. Changes apply immediately upon saving."
            : "Map each Claude tier to a ChatGPT backend model. Changes apply immediately upon saving.";
        }
      }

      function applyBadge(badge, client) {
        if (client.configured && client.inSync) {
          badge.textContent = "Configured";
          badge.className = "badge-sub badge-active";
        } else if (client.configured) {
          badge.textContent = "Out of sync - click Apply";
          badge.className = "badge-sub badge-warn";
        } else {
          badge.textContent = "Not Configured";
          badge.className = "badge-sub badge-inactive";
        }
      }
      applyBadge(document.getElementById("badge-cli"), s.cli);
      applyBadge(document.getElementById("badge-desktop"), s.desktop);

      document.getElementById("input-url").value = s.gateway.url;
      document.getElementById("input-token").value = s.gateway.token;
      renderTierMapping(s.tierMapping);

      updateRunCommand();
    }

    async function switchProvider(provider) {
      try {
        const res = await fetch("/api/ui/provider", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider }),
        });
        const data = await res.json();
        if (data.ok) {
          showToast("Switched active provider to " + (provider === "antigravity" ? "Google Antigravity (agy)" : "ChatGPT (Codex)"));
          cachedLimits = null;
          await fetchStatus();
          await fetchUsage(true);
        } else {
          showToast("Failed to switch provider: " + (data.error || "Unknown error"), "error");
        }
      } catch (err) {
        showToast("Error switching provider: " + err.message, "error");
      }
    }

    document.getElementById("btn-provider-codex")?.addEventListener("click", () => selectProvider("codex"));
    document.getElementById("btn-provider-antigravity")?.addEventListener("click", () => selectProvider("antigravity"));

    document.getElementById("btn-provider-submit")?.addEventListener("click", async () => {
      if (selectedProvider === currentActiveProvider || isProviderSwitching) return;
      if (hasUnsavedTierChanges()) {
        if (!confirm("You have unsaved model routing edits for the current provider. Switch anyway?")) return;
      }
      const btnSubmit = document.getElementById("btn-provider-submit");
      isProviderSwitching = true;
      if (btnSubmit) {
        btnSubmit.disabled = true;
        btnSubmit.textContent = "Switching…";
      }
      try {
        await switchProvider(selectedProvider);
      } finally {
        isProviderSwitching = false;
        if (btnSubmit) {
          btnSubmit.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> <span>Submit</span>';
        }
        updateProviderControls();
      }
    });

    /* True when the model map holds selections that differ from the mapping saved on the server. */
    function hasUnsavedTierChanges() {
      const saved = currentStatus?.tierMapping;
      if (!saved) return false;
      const tiersChanged = ["fable", "opus", "sonnet", "haiku"].some((tier) => document.getElementById("tier-" + tier).value !== saved.current[tier]);
      return tiersChanged || document.getElementById("select-effort").value !== (saved.effort || "");
    }

    function renderTierMapping(mapping) {
      const tiers = ["fable", "opus", "sonnet", "haiku"];
      const models = Array.isArray(mapping.models) ? mapping.models : [];
      for (const tier of tiers) {
        const select = document.getElementById("tier-" + tier);
        const selectedModel = mapping.current[tier];
        const choices = [...models];
        if (!choices.some((model) => model.slug === selectedModel)) {
          choices.push({ slug: selectedModel, displayName: selectedModel + " (not in current account catalog)" });
        }
        select.replaceChildren();
        for (const model of choices) {
          const option = document.createElement("option");
          option.value = model.slug;
          option.textContent = model.displayName + " (" + model.slug + ")";
          select.appendChild(option);
        }
        select.value = selectedModel;
      }
      const status = document.getElementById("tier-mapping-status");
      status.textContent = mapping.custom ? "Saved mapping" : "Environment or built-in defaults";
      status.className = mapping.custom ? "badge-sub badge-active" : "badge-sub";

      const effortSelect = document.getElementById("select-effort");
      if (effortSelect && mapping.effort !== undefined) {
        effortSelect.value = mapping.effort || "";
      }
    }

    function updateRunCommand() {
      const url = document.getElementById("input-url").value || "http://127.0.0.1:3456";
      let port = "3456";
      try { port = new URL(url).port || "3456"; } catch {}
      const token = document.getElementById("input-token").value || "YOUR_SECRET_TOKEN";
      document.getElementById("text-run-cmd").textContent = 'CODEX2CC_TOKEN="' + token + '" node dist/main.js --serve --port ' + port;
    }

    /* Clipboard & Input helpers */
    document.getElementById("btn-copy-token").addEventListener("click", () => {
      const val = document.getElementById("input-token").value;
      if (!val) return;
      navigator.clipboard.writeText(val);
      showToast("Token copied to clipboard!");
    });

    document.getElementById("btn-copy-url")?.addEventListener("click", () => {
      const val = document.getElementById("input-url").value;
      if (!val) return;
      navigator.clipboard.writeText(val);
      showToast("Gateway URL copied to clipboard!");
    });

    document.getElementById("btn-toggle-token")?.addEventListener("click", () => {
      const input = document.getElementById("input-token");
      const btn = document.getElementById("btn-toggle-token");
      if (input.type === "password") {
        input.type = "text";
        btn.textContent = "Hide";
      } else {
        input.type = "password";
        btn.textContent = "Show";
      }
    });

    document.getElementById("btn-copy-cmd").addEventListener("click", () => {
      const cmd = document.getElementById("text-run-cmd").textContent;
      navigator.clipboard.writeText(cmd);
      showToast("Run command copied to clipboard!");
    });

    /* Quick sync client buttons */
    document.getElementById("btn-quick-cli")?.addEventListener("click", () => {
      document.getElementById("select-target").value = "cli";
      document.getElementById("btn-apply").click();
    });

    document.getElementById("btn-quick-desktop")?.addEventListener("click", () => {
      document.getElementById("select-target").value = "desktop";
      document.getElementById("btn-apply").click();
    });

    document.getElementById("btn-apply").addEventListener("click", async () => {
      const target = document.getElementById("select-target").value;
      const gatewayUrl = document.getElementById("input-url").value.trim();
      const token = document.getElementById("input-token").value.trim();

      try {
        const res = await fetch("/api/ui/setup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ target, gatewayUrl, token }),
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error);
        showToast("Configuration applied successfully!");
        fetchStatus();
      } catch (err) {
        showToast("Failed to apply configuration: " + err.message, "error");
      }
    });

    document.getElementById("btn-save-tier-mapping").addEventListener("click", async () => {
      const tiers = Object.fromEntries(["fable", "opus", "sonnet", "haiku"].map((tier) => [
        tier,
        document.getElementById("tier-" + tier).value,
      ]));
      const effort = document.getElementById("select-effort")?.value || "";
      try {
        const res = await fetch("/api/ui/tiers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tiers, effort }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || "HTTP " + res.status);
        showToast("Settings and model mapping saved.");
        await fetchStatus();
      } catch (err) {
        showToast("Failed to save settings: " + err.message, "error");
      }
    });

    document.getElementById("btn-reset-tier-mapping").addEventListener("click", async () => {
      if (!confirm("Reset the tier mapping to environment or built-in defaults?")) return;
      try {
        const res = await fetch("/api/ui/tiers/reset", { method: "POST" });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || "HTTP " + res.status);
        showToast("Tier mapping reset to defaults.");
        await fetchStatus();
      } catch (err) {
        showToast("Failed to reset tier mapping: " + err.message, "error");
      }
    });

    async function sendReset(target) {
      if (!confirm("Are you sure you want to reset " + target + " settings to default?")) return;
      try {
        const res = await fetch("/api/ui/reset", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ target }),
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error);
        const restartHint = target === "cli"
          ? "Reload your terminal or editor."
          : "Quit and reopen Claude Desktop to return to Claude account sign-in.";
        showToast("Reset completed for " + target + ". " + restartHint);
        fetchStatus();
      } catch (err) {
        showToast("Reset failed: " + err.message, "error");
      }
    }

    document.getElementById("btn-reset-all").addEventListener("click", () => sendReset("all"));
    document.getElementById("btn-reset-cli").addEventListener("click", () => sendReset("cli"));
    document.getElementById("btn-reset-desktop").addEventListener("click", () => sendReset("desktop"));

    let logsCache = [];
    let eventSource = null;

    function escapeHtml(str) {
      if (typeof str !== "string") return String(str);
      return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }

    async function fetchLogs() {
      try {
        const levelVal = document.getElementById("select-log-level")?.value || "all";
        const searchVal = document.getElementById("input-log-search")?.value.trim() || "";
        const params = new URLSearchParams();
        if (levelVal !== "all") params.set("level", levelVal);
        if (searchVal) params.set("search", searchVal);
        params.set("limit", "250");

        const res = await fetch("/api/ui/logs?" + params.toString());
        if (!res.ok) return;
        const data = await res.json();
        logsCache = data.logs || [];
        renderLogs(logsCache, data.stats, data.logFile);
      } catch (err) {
        // Silently skip transient log poll errors
      }
    }

    function matchesLogFilter(log, levelVal, searchVal) {
      if (levelVal !== "all" && log.level !== levelVal) return false;
      if (searchVal) {
        const query = searchVal.toLowerCase();
        const inMsg = (log.message || "").toLowerCase().includes(query);
        const inOp = (log.operation || "").toLowerCase().includes(query);
        let inDet = false;
        if (log.details) {
          try {
            inDet = JSON.stringify(log.details).toLowerCase().includes(query);
          } catch {}
        }
        if (!inMsg && !inOp && !inDet) return false;
      }
      return true;
    }

    function appendLogRow(log) {
      const terminal = document.getElementById("log-terminal");
      if (!terminal) return;

      terminal.classList.remove("is-empty");
      const emptyEl = terminal.querySelector(".log-empty");
      if (emptyEl) {
        terminal.innerHTML = "";
      }

      const isScrolledToBottom = terminal.scrollHeight - terminal.clientHeight <= terminal.scrollTop + 50;

      const time = log.timestamp ? log.timestamp.split("T")[1]?.slice(0, 8) || log.timestamp : "";
      let detailsStr = "";
      if (log.details && Object.keys(log.details).length > 0) {
        try {
          detailsStr = " " + JSON.stringify(log.details);
        } catch {}
      }

      const row = document.createElement("div");
      row.className = "log-row";
      row.innerHTML = '<span class="log-time">' + escapeHtml(time) + '</span>' +
        '<span class="log-tag log-tag-' + escapeHtml(log.level) + '">' + escapeHtml(log.level) + '</span>' +
        '<span class="log-op">[' + escapeHtml(log.operation) + ']</span>' +
        '<span class="log-msg">' + escapeHtml(log.message) +
        (detailsStr ? '<span class="log-details-chip">' + escapeHtml(detailsStr) + '</span>' : '') +
        '</span>';

      terminal.appendChild(row);

      while (terminal.children.length > 250) {
        terminal.removeChild(terminal.firstElementChild);
      }

      if (isScrolledToBottom) {
        terminal.scrollTop = terminal.scrollHeight;
      }
    }

    function handleLiveLog(entry, stats) {
      if (!logsCache.some(l => l.id === entry.id)) {
        logsCache.push(entry);
        if (logsCache.length > 250) {
          logsCache.shift();
        }
      }

      const tabBadge = document.getElementById("tab-badge-logs");
      if (stats) {
        document.getElementById("badge-log-count").textContent = stats.total + " log" + (stats.total === 1 ? "" : "s");
        if (tabBadge) tabBadge.textContent = String(stats.total);

        const warnEl = document.getElementById("badge-warn-count");
        if (stats.warnCount > 0) {
          warnEl.style.display = "inline-flex";
          warnEl.textContent = stats.warnCount + " warning" + (stats.warnCount === 1 ? "" : "s");
        } else {
          warnEl.style.display = "none";
        }
        const errEl = document.getElementById("badge-err-count");
        if (stats.errorCount > 0) {
          errEl.style.display = "inline-flex";
          errEl.textContent = stats.errorCount + " error" + (stats.errorCount === 1 ? "" : "s");
          if (tabBadge) tabBadge.classList.add("badge-alert");
        } else {
          errEl.style.display = "none";
          if (tabBadge) tabBadge.classList.remove("badge-alert");
        }
      }

      const levelVal = document.getElementById("select-log-level")?.value || "all";
      const searchVal = document.getElementById("input-log-search")?.value.trim() || "";
      if (matchesLogFilter(entry, levelVal, searchVal)) {
        appendLogRow(entry);
      }
    }

    function connectEventStream() {
      if (eventSource) return;
      if (typeof EventSource === "undefined") return;

      try {
        eventSource = new EventSource("/api/ui/events");

        eventSource.addEventListener("log", (e) => {
          try {
            const data = JSON.parse(e.data);
            if (data && data.log) {
              handleLiveLog(data.log, data.stats);
            }
          } catch {}
        });

        eventSource.addEventListener("log_clear", () => {
          logsCache = [];
          renderLogs([], { total: 0, infoCount: 0, warnCount: 0, errorCount: 0 });
        });

        eventSource.addEventListener("usage", (e) => {
          try {
            const summary = JSON.parse(e.data);
            if (summary) {
              renderUsage(summary);
            }
          } catch {}
        });
      } catch (err) {
        // Silently ignore EventSource setup error
      }
    }

    function disconnectEventStream() {
      if (eventSource) {
        eventSource.close();
        eventSource = null;
      }
    }

    window.addEventListener("beforeunload", () => {
      disconnectEventStream();
    });

    function renderLogs(logs, stats, logFile) {
      const terminal = document.getElementById("log-terminal");
      if (!terminal) return;
      terminal.classList.toggle("is-empty", logs.length === 0);

      const tabBadge = document.getElementById("tab-badge-logs");
      if (stats) {
        document.getElementById("badge-log-count").textContent = stats.total + " log" + (stats.total === 1 ? "" : "s");
        if (tabBadge) tabBadge.textContent = String(stats.total);

        const warnEl = document.getElementById("badge-warn-count");
        if (stats.warnCount > 0) {
          warnEl.style.display = "inline-flex";
          warnEl.textContent = stats.warnCount + " warning" + (stats.warnCount === 1 ? "" : "s");
        } else {
          warnEl.style.display = "none";
        }
        const errEl = document.getElementById("badge-err-count");
        if (stats.errorCount > 0) {
          errEl.style.display = "inline-flex";
          errEl.textContent = stats.errorCount + " error" + (stats.errorCount === 1 ? "" : "s");
          if (tabBadge) tabBadge.classList.add("badge-alert");
        } else {
          errEl.style.display = "none";
          if (tabBadge) tabBadge.classList.remove("badge-alert");
        }
      }

      if (logFile) {
        const fileEl = document.getElementById("badge-log-file");
        if (fileEl) {
          const parts = logFile.split(/[/\\\\]/);
          const shortPath = parts.slice(-2).join("/");
          fileEl.textContent = shortPath;
          fileEl.title = "Project log file: " + logFile;
        }
      }

      if (logs.length === 0) {
        terminal.innerHTML = '<div class="log-empty">No activity yet. Send a request through the gateway to see live logs.</div>';
        return;
      }

      const isScrolledToBottom = terminal.scrollHeight - terminal.clientHeight <= terminal.scrollTop + 50;

      let html = "";
      for (const log of logs) {
        const time = log.timestamp ? log.timestamp.split("T")[1]?.slice(0, 8) || log.timestamp : "";
        let detailsStr = "";
        if (log.details && Object.keys(log.details).length > 0) {
          try {
            detailsStr = " " + JSON.stringify(log.details);
          } catch {}
        }
        html += '<div class="log-row">' +
          '<span class="log-time">' + escapeHtml(time) + '</span>' +
          '<span class="log-tag log-tag-' + escapeHtml(log.level) + '">' + escapeHtml(log.level) + '</span>' +
          '<span class="log-op">[' + escapeHtml(log.operation) + ']</span>' +
          '<span class="log-msg">' + escapeHtml(log.message) +
          (detailsStr ? '<span class="log-details-chip">' + escapeHtml(detailsStr) + '</span>' : '') +
          '</span>' +
          '</div>';
      }
      terminal.innerHTML = html;

      if (isScrolledToBottom) {
        terminal.scrollTop = terminal.scrollHeight;
      }
    }

    function setupLogControls() {
      document.getElementById("btn-refresh-logs").addEventListener("click", () => fetchLogs());
      document.getElementById("select-log-level").addEventListener("change", () => fetchLogs());
      document.getElementById("input-log-search").addEventListener("input", () => fetchLogs());

      document.getElementById("btn-clear-logs").addEventListener("click", async () => {
        try {
          const res = await fetch("/api/ui/logs/clear", { method: "POST" });
          if (res.ok) {
            logsCache = [];
            renderLogs([], { total: 0, infoCount: 0, warnCount: 0, errorCount: 0 });
            showToast("Log history cleared!");
          }
        } catch (err) {
          showToast("Failed to clear logs: " + err.message, "error");
        }
      });

      document.getElementById("btn-copy-logs").addEventListener("click", () => {
        if (logsCache.length === 0) {
          showToast("No logs to copy", "error");
          return;
        }
        const text = logsCache.map(l => {
          const det = l.details ? " " + JSON.stringify(l.details) : "";
          return "[" + l.timestamp + "] [" + l.level.toUpperCase() + "] [" + l.operation + "] " + l.message + det;
        }).join("\\n");
        navigator.clipboard.writeText(text);
        showToast("Copied " + logsCache.length + " log entries to clipboard!");
      });

      const autoRefreshCheck = document.getElementById("check-auto-refresh");
      function updateAutoRefresh() {
        if (autoRefreshCheck.checked) {
          connectEventStream();
        } else {
          disconnectEventStream();
        }
      }
      autoRefreshCheck.addEventListener("change", updateAutoRefresh);
      updateAutoRefresh();
      fetchLogs();
    }

    function fmt(n) {
      return (Number(n) || 0).toLocaleString();
    }

    function formatDuration(seconds) {
      if (typeof seconds !== "number" || isNaN(seconds) || seconds < 0) return "--";
      if (seconds < 60) return seconds + "s";
      const mins = Math.floor(seconds / 60);
      if (mins < 60) return mins + "m";
      const hours = Math.floor(mins / 60);
      const remMins = mins % 60;
      if (hours < 24) return hours + "h " + (remMins > 0 ? remMins + "m" : "");
      const days = Math.floor(hours / 24);
      const remHours = hours % 24;
      return days + "d " + (remHours > 0 ? remHours + "h" : "");
    }

    function renderQuotaWindow(prefix, win) {
      const remEl = document.getElementById("val-" + prefix + "-remaining");
      const usedEl = document.getElementById("val-" + prefix + "-used");
      const resetEl = document.getElementById("val-" + prefix + "-reset");
      const barEl = document.getElementById("bar-" + prefix);

      if (!win) {
        if (remEl) { remEl.textContent = "--%"; remEl.style.color = "var(--muted-foreground)"; }
        if (usedEl) usedEl.textContent = "--%";
        if (resetEl) { resetEl.textContent = "--"; resetEl.removeAttribute("title"); }
        if (barEl) barEl.style.width = "0%";
        return;
      }

      const rem = Math.max(0, Math.min(100, Math.round(win.remainingPercent !== undefined ? win.remainingPercent : (100 - win.usedPercent))));
      const used = Math.max(0, Math.min(100, Math.round(win.usedPercent)));

      if (remEl) {
        remEl.textContent = rem + "%";
        if (rem <= 15) {
          remEl.style.color = "var(--coral-dark)";
        } else if (rem <= 35) {
          remEl.style.color = "#b45309";
        } else {
          remEl.style.color = "var(--primary)";
        }
      }

      if (usedEl) usedEl.textContent = used + "%";

      if (resetEl) {
        resetEl.textContent = formatDuration(win.resetAfterSeconds);
        if (win.resetAt) {
          try {
            const date = new Date(win.resetAt * 1000);
            resetEl.title = "Resets at " + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + " on " + date.toLocaleDateString();
          } catch {}
        }
      }

      if (barEl) {
        barEl.style.width = rem + "%";
        if (rem <= 15) {
          barEl.style.backgroundColor = "var(--coral)";
        } else if (rem <= 35) {
          barEl.style.backgroundColor = "#f59e0b";
        } else {
          barEl.style.backgroundColor = "var(--primary)";
        }
      }
    }

    async function fetchUsage(refresh = false) {
      try {
        const url = refresh ? "/api/ui/usage?refresh=true" : "/api/ui/usage";
        const res = await fetch(url);
        if (!res.ok) return;
        const data = await res.json();
        renderUsage(data);
      } catch (err) {
        // Silently skip transient errors
      }
    }

    let cachedLimits = null;

    function renderUsage(data) {
      if (!data) return;
      document.getElementById("val-total-tokens").textContent = fmt(data.grandTotalTokens);
      document.getElementById("val-total-reqs").textContent = fmt(data.totalRequests) + (data.totalRequests === 1 ? " request" : " requests");
      document.getElementById("val-input-tokens").textContent = fmt(data.totalInputTokens);
      document.getElementById("val-output-tokens").textContent = fmt(data.totalOutputTokens);
      document.getElementById("val-cached-tokens").textContent = fmt(data.totalCachedTokens);

      const isAnt = (data.provider === "antigravity") || (!data.provider && currentStatus?.provider?.active === "antigravity");
      const planBadge = document.getElementById("quota-plan-badge");
      const statusText = document.getElementById("quota-status-text");

      if (isAnt) {
        if (planBadge) {
          planBadge.textContent = "Google Antigravity";
          planBadge.className = "quota-plan-badge badge-active";
        }
        if (statusText) {
          statusText.innerHTML = data.antigravity?.available !== false
            ? '<span style="color:var(--primary);font-weight:600;">Connected · agy on PATH</span>'
            : '<span style="color:var(--coral-dark);font-weight:600;">agy binary not detected on PATH</span>';
        }
        const name5h = document.querySelector("#card-quota-5h .quota-window-name");
        const sub5h = document.querySelector("#card-quota-5h .quota-window-sub");
        const rem5h = document.getElementById("val-5h-remaining");
        const label5h = document.querySelector("#card-quota-5h .quota-remaining-label");
        const bar5h = document.getElementById("bar-5h");
        const used5h = document.getElementById("val-5h-used");
        const reset5h = document.getElementById("val-5h-reset");

        if (name5h) name5h.textContent = "CLI Session (agy)";
        if (sub5h) sub5h.textContent = "Local Subprocess Bridge";
        if (rem5h) {
          rem5h.textContent = data.antigravity?.available !== false ? "Active" : "Unavailable";
          rem5h.style.color = data.antigravity?.available !== false ? "var(--primary)" : "var(--coral-dark)";
        }
        if (label5h) label5h.textContent = "status";
        if (bar5h) {
          bar5h.style.width = data.antigravity?.available !== false ? "100%" : "0%";
          bar5h.style.backgroundColor = data.antigravity?.available !== false ? "var(--primary)" : "var(--coral)";
        }
        if (used5h) used5h.textContent = data.antigravity?.available !== false ? "Process ready" : "Not found";
        if (reset5h) reset5h.textContent = "Auto-managed";

        const nameWk = document.querySelector("#card-quota-weekly .quota-window-name");
        const subWk = document.querySelector("#card-quota-weekly .quota-window-sub");
        const remWk = document.getElementById("val-weekly-remaining");
        const labelWk = document.querySelector("#card-quota-weekly .quota-remaining-label");
        const barWk = document.getElementById("bar-weekly");
        const usedWk = document.getElementById("val-weekly-used");
        const resetWk = document.getElementById("val-weekly-reset");

        if (nameWk) nameWk.textContent = "Quota Channel";
        if (subWk) subWk.textContent = "Google Antigravity Subscription";
        if (remWk) {
          remWk.textContent = "Direct";
          remWk.style.color = "var(--primary)";
        }
        if (labelWk) labelWk.textContent = "unmetered by gateway";
        if (barWk) {
          barWk.style.width = "100%";
          barWk.style.backgroundColor = "var(--primary)";
        }
        if (usedWk) usedWk.textContent = "Bypasses ChatGPT limits";
        if (resetWk) resetWk.textContent = "Google Account";
      } else {
        const name5h = document.querySelector("#card-quota-5h .quota-window-name");
        const sub5h = document.querySelector("#card-quota-5h .quota-window-sub");
        const label5h = document.querySelector("#card-quota-5h .quota-remaining-label");
        if (name5h) name5h.textContent = "5-hour window";
        if (sub5h) sub5h.textContent = "Rolling session quota";
        if (label5h) label5h.textContent = "remaining";

        const nameWk = document.querySelector("#card-quota-weekly .quota-window-name");
        const subWk = document.querySelector("#card-quota-weekly .quota-window-sub");
        const labelWk = document.querySelector("#card-quota-weekly .quota-remaining-label");
        if (nameWk) nameWk.textContent = "Weekly allowance";
        if (subWk) subWk.textContent = "7-day capacity limit";
        if (labelWk) labelWk.textContent = "remaining";

        if (data.limits !== undefined) {
          cachedLimits = data.limits;
        }
        const limits = cachedLimits;

        if (limits) {
          if (planBadge) {
            const planStr = limits.planType ? (limits.planType.charAt(0).toUpperCase() + limits.planType.slice(1)) + " plan" : "Active";
            planBadge.textContent = planStr;
            planBadge.className = "quota-plan-badge";
          }
          if (statusText) {
            if (limits.limitReached) {
              statusText.innerHTML = '<span style="color:var(--coral-dark);font-weight:700;">Rate limit reached</span>';
            } else {
              statusText.textContent = limits.allowed ? "Allowed — Quota active" : "Usage paused";
            }
          }
          renderQuotaWindow("5h", limits.primaryWindow);
          renderQuotaWindow("weekly", limits.secondaryWindow);
        } else {
          if (statusText) {
            statusText.textContent = "Rate limits not available in current session";
          }
          renderQuotaWindow("5h", null);
          renderQuotaWindow("weekly", null);
        }
      }

      const tabBadge = document.getElementById("tab-badge-tokens");
      if (tabBadge) {
        tabBadge.textContent = data.grandTotalTokens > 1000 ? (data.grandTotalTokens / 1000).toFixed(1) + "k" : fmt(data.grandTotalTokens);
      }

      const tbody = document.getElementById("usage-table-body");
      const tfoot = document.getElementById("usage-table-foot");
      if (!tbody || !tfoot) return;

      if (!data.models || data.models.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" class="usage-empty">No usage yet. Send a request through the gateway to see model totals.</td></tr>';
        tfoot.style.display = "none";
        return;
      }

      let html = "";
      for (const m of data.models) {
        const pct = data.grandTotalTokens > 0
          ? ((m.totalTokens / data.grandTotalTokens) * 100).toFixed(1) + "%"
          : "0.0%";

        const isAntModel = m.model.startsWith("claude-") || m.model.startsWith("gemini-") || m.model.startsWith("gpt-oss-");
        const providerBadge = isAntModel
          ? '<span class="badge-sub" style="margin-left:0.5rem;font-size:0.68rem;padding:0.12rem 0.45rem;border-radius:4px;background:rgba(36,123,121,0.15);color:var(--primary);font-weight:600;">Antigravity</span>'
          : '<span class="badge-sub" style="margin-left:0.5rem;font-size:0.68rem;padding:0.12rem 0.45rem;border-radius:4px;background:rgba(217,119,6,0.15);color:#d97706;font-weight:600;">ChatGPT</span>';

        html += '<tr>' +
          '<td><span class="model-tag">' + escapeHtml(m.model) + '</span>' + providerBadge + '</td>' +
          '<td class="num-col">' + fmt(m.requests) + '</td>' +
          '<td class="num-col">' + fmt(m.inputTokens) + '</td>' +
          '<td class="num-col">' + fmt(m.outputTokens) + '</td>' +
          '<td class="num-col">' + fmt(m.cachedTokens) + '</td>' +
          '<td class="num-col" style="font-weight: 700; color: var(--primary);">' + fmt(m.totalTokens) + '</td>' +
          '<td class="num-col"><span class="share-pill">' + pct + '</span></td>' +
          '</tr>';
      }
      tbody.innerHTML = html;

      document.getElementById("foot-reqs").textContent = fmt(data.totalRequests);
      document.getElementById("foot-input").textContent = fmt(data.totalInputTokens);
      document.getElementById("foot-output").textContent = fmt(data.totalOutputTokens);
      document.getElementById("foot-cached").textContent = fmt(data.totalCachedTokens);
      document.getElementById("foot-total").textContent = fmt(data.grandTotalTokens);
      tfoot.style.display = "table-footer-group";
    }

    function setupUsageControls() {
      document.getElementById("btn-refresh-usage").addEventListener("click", () => fetchUsage(true));
      document.getElementById("btn-reset-usage").addEventListener("click", async () => {
        if (!confirm("Reset all token usage counters to zero?")) return;
        try {
          const res = await fetch("/api/ui/usage/reset", { method: "POST" });
          if (res.ok) {
            showToast("Token usage counters reset.");
            fetchUsage();
          }
        } catch (err) {
          showToast("Failed to reset token usage: " + err.message, "error");
        }
      });
    }

    setupTabs();
    fetchStatus();
    fetchUsage();
    setupUsageControls();
    setupLogControls();
  </script>
</body>
</html>`;
}
