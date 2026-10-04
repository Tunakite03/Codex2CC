import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { BridgeError } from "./bridge.js";
import {
  CODEX2CC_DESKTOP_CONFIG_ID,
  resetConfig,
  resolveDefaultPaths,
  setupConfig,
  validateGatewayUrl,
  type SetupTarget,
} from "./config-setup.js";
import type { GatewayOptions } from "./gateway.js";
import { DEFAULT_TIER_MODELS } from "./models.js";
import { activeTierModels, parseTierModels } from "./tier-store.js";
import { clearLogs, getActiveLogFilePath, getLogs, getLogStats, recordLog, type LogLevel } from "./logger.js";
import { getTokenUsageStats, resetTokenUsage } from "./usage.js";

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
    child.unref();
  } catch {
    // Non-fatal if browser cannot be launched
  }
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function getStatus(options: GatewayOptions, port: number): Record<string, unknown> {
  const paths = resolveDefaultPaths();
  const gatewayUrl = `http://127.0.0.1:${port}`;
  const token = options.policy.mode === "token" ? options.policy.token : "";
  const currentTiers = activeTierModels(options);
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
  const metaFile = `${paths.claudeDesktopDir}/_meta.json`;
  if (existsSync(metaFile)) {
    try {
      const meta = JSON.parse(readFileSync(metaFile, "utf8"));
      if (meta?.appliedId === CODEX2CC_DESKTOP_CONFIG_ID) {
        desktopConfigured = true;
        const configFile = `${paths.claudeDesktopDir}/${CODEX2CC_DESKTOP_CONFIG_ID}.json`;
        if (existsSync(configFile)) {
          const cfg = JSON.parse(readFileSync(configFile, "utf8"));
          desktopBaseUrl = String(cfg?.inferenceGatewayBaseUrl || "");
          desktopInSync = inSync(desktopBaseUrl, String(cfg?.inferenceGatewayApiKey ?? ""));
        }
      }
    } catch {
      // Ignore
    }
  }

  return {
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
      path: paths.claudeDesktopDir,
    },
    tierMapping: {
      current: currentTiers,
      defaults: options.tierStore?.defaults() ?? options.tiers ?? DEFAULT_TIER_MODELS,
      custom: options.tierStore?.isCustom() ?? false,
      models: options.availableModels.map(({ slug, displayName }) => ({ slug, displayName })),
    },
  };
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

  if (pathname === "/api/ui/logs/clear" && request.method === "POST") {
    clearLogs({ clearFile: true });
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
    return true;
  }

  if (pathname === "/api/ui/usage" && request.method === "GET") {
    const usage = getTokenUsageStats();
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(usage));
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
      const availableModels = new Set(options.availableModels.map((model) => model.slug));
      const unavailable = Object.entries(tiers).find(([, model]) => !availableModels.has(model));
      if (unavailable) {
        throw new BridgeError(400, "model_unavailable", `Tier mapping model "${unavailable[1]}" is not in the current ChatGPT account model catalog.`);
      }
      store.save(tiers);
      recordLog({
        level: "info",
        operation: "tier_mapping_saved",
        message: "Saved Claude tier to ChatGPT model mapping",
        details: { fable: tiers.fable, opus: tiers.opus, sonnet: tiers.sonnet, haiku: tiers.haiku },
      });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true, tiers: store.current(), custom: store.isCustom() }));
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
      store.reset();
      recordLog({ level: "info", operation: "tier_mapping_reset", message: "Reset Claude tier mapping to environment or built-in defaults" });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true, tiers: store.current(), custom: store.isCustom() }));
    } catch (error) {
      const failure = new BridgeError(
        500,
        "tier_mapping_reset_failed",
        `Could not reset the tier mapping: ${error instanceof Error ? error.message : "unknown error"}.`,
      );
      recordLog({ level: "error", operation: "tier_mapping_reset_failed", message: failure.message });
      response.writeHead(failure.status, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: false, error: failure.message }));
    }
    return true;
  }

  if (pathname === "/api/ui/setup" && request.method === "POST") {
    const body = await readJsonBody(request);
    const target = (body.target as SetupTarget) || "all";
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
      const result = setupConfig(target, {
        gatewayUrl: cleanUrl,
        token,
        model: options.defaultModel,
        tiers: activeTierModels(options),
      });
      recordLog({
        level: "info",
        operation: "setup",
        message: `Client configuration applied for "${target}" (gateway: ${gatewayUrl})`,
        details: { target, gatewayUrl },
      });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true, result }));
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
    const target = (body.target as SetupTarget) || "all";
    try {
      const result = resetConfig(target);
      recordLog({
        level: "warn",
        operation: "reset",
        message: `Client configuration reset for target "${target}"`,
        details: { target },
      });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true, result }));
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
  <title>Codex2CC — Gateway & Client Control Panel</title>
  <link rel="icon" href="data:,">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Lexend:wght@400;500;600;700&family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      color-scheme: light;
      --background: #f5f7f6;
      --foreground: #17201d;
      --card: #ffffff;
      --card-foreground: #17201d;
      --primary: #176b64;
      --primary-foreground: #ffffff;
      --secondary: #edf2ef;
      --secondary-foreground: #26322c;
      --muted: #f3f6f4;
      --muted-foreground: #5d6d65;
      --accent: #e5f3ee;
      --accent-foreground: #174d48;
      --destructive: #b44235;
      --destructive-foreground: #ffffff;
      --border: #dce4df;
      --input: #cbd6cf;
      --ring: #17635e;
      --hard-shadow: rgba(23, 32, 29, 0.08);
      --radius: 0.5rem;
      --font-display: 'Lexend', sans-serif;
      --font-body: 'Plus Jakarta Sans', sans-serif;
      --font-mono: ui-monospace, SFMono-Regular, Menlo, monospace;
    }

    * { box-sizing: border-box; }
    html { -webkit-font-smoothing: antialiased; }
    body {
      margin: 0;
      font-family: var(--font-body);
      background: var(--background);
      color: var(--foreground);
      min-height: 100vh;
      padding: clamp(0.875rem, 2vw, 1.5rem);
      line-height: 1.45;
    }
    h1, h2, p { margin: 0; }
    button, input, select { font: inherit; }
    button:not(:disabled) { cursor: pointer; }
    :where(button, input, select):focus-visible {
      outline: 2px solid var(--ring);
      outline-offset: 3px;
    }
    .container {
      width: 100%;
      max-width: 1200px;
      margin: 0 auto;
      display: flex;
      flex-direction: column;
      gap: 1rem;
    }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 1rem;
      padding: 1rem 1.25rem;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 0.75rem;
      box-shadow: 0 1px 3px var(--hard-shadow);
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }
    .brand-icon {
      width: 2.5rem;
      height: 2.5rem;
      flex: none;
      background: var(--primary);
      border-radius: 0.5rem;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      font-family: var(--font-display);
      font-size: 1.125rem;
      color: var(--primary-foreground);
    }
    .brand-text h1 {
      font-family: var(--font-display);
      font-size: clamp(1.1rem, 2vw, 1.35rem);
      line-height: 1.2;
    }
    .brand-text p {
      margin-top: 0.1rem;
      font-size: 0.75rem;
      color: var(--muted-foreground);
    }
    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      flex: none;
      padding: 0.4rem 0.875rem;
      border-radius: 9999px;
      font-size: 0.8125rem;
      font-weight: 600;
      background: var(--accent);
      border: 1px solid var(--primary);
      color: var(--accent-foreground);
    }
    .pulse-dot {
      width: 0.5rem;
      height: 0.5rem;
      border-radius: 50%;
      background: var(--primary);
    }
    .metrics-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 0.75rem;
    }
    .metric-card {
      min-width: 0;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 0.75rem;
      padding: 0.875rem 1rem;
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
      box-shadow: 0 1px 3px var(--hard-shadow);
    }
    .metric-title {
      font-size: 0.6875rem;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--muted-foreground);
      font-weight: 700;
    }
    .metric-value {
      min-width: 0;
      overflow-wrap: anywhere;
      font-size: 1rem;
      font-weight: 600;
      font-family: var(--font-mono);
      color: var(--foreground);
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    .metric-sub {
      overflow-wrap: anywhere;
      font-size: 0.75rem;
      color: var(--muted-foreground);
    }
    .badge-sub {
      font-family: var(--font-body);
      font-size: 0.75rem;
      padding: 0.2rem 0.625rem;
      border-radius: 9999px;
      font-weight: 600;
    }
    .badge-active { background: var(--accent); color: var(--accent-foreground); border: 1px solid var(--primary); }
    .badge-inactive { background: var(--muted); color: var(--muted-foreground); border: 1px solid var(--border); }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 0.75rem;
      padding: 1.25rem;
      display: flex;
      flex-direction: column;
      gap: 1rem;
      box-shadow: 0 1px 3px var(--hard-shadow);
    }
    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid var(--border);
      padding-bottom: 0.75rem;
      gap: 0.75rem;
    }
    .card-title {
      font-family: var(--font-display);
      font-size: 0.9375rem;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    .form-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 0.875rem;
    }
    .tier-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 0.875rem;
    }
    .field {
      display: flex;
      flex-direction: column;
      min-width: 0;
      gap: 0.375rem;
    }
    label {
      font-size: 0.8125rem;
      font-weight: 600;
      color: var(--card-foreground);
    }
    .input-group {
      display: flex;
      gap: 0.5rem;
    }
    input, select {
      width: 100%;
      min-width: 0;
      background: var(--card);
      border: 1px solid var(--input);
      border-radius: var(--radius);
      padding: 0.625rem 0.75rem;
      font-size: 0.875rem;
      color: var(--foreground);
    }
    input::placeholder { color: var(--muted-foreground); }
    input:focus, select:focus {
      border-color: var(--ring);
    }
    select { cursor: pointer; }
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;
      padding: 0.625rem 0.875rem;
      border-radius: var(--radius);
      font-size: 0.875rem;
      font-weight: 600;
      border: 1px solid var(--border);
      transition: background-color 0.15s ease, border-color 0.15s ease;
      white-space: nowrap;
    }
    .btn:hover { border-color: var(--primary); }
    .btn:active { background: var(--accent); }
    .btn-primary {
      background: var(--primary);
      color: var(--primary-foreground);
      border-color: var(--primary);
    }
    .btn-primary:hover { background: #125950; }
    .btn-primary:active { background: #104c45; }
    .btn-secondary {
      background: var(--secondary);
      color: var(--secondary-foreground);
    }
    .btn-danger {
      background: var(--destructive);
      color: var(--destructive-foreground);
      border-color: var(--destructive);
    }
    .btn-sm {
      padding: 0.4rem 0.7rem;
      font-size: 0.75rem;
    }
    .action-bar {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
      align-items: center;
      justify-content: flex-end;
      padding-top: 0.5rem;
    }
    .instruction-card {
      background: var(--accent);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 0.75rem 1rem;
      font-size: 0.8125rem;
      line-height: 1.6;
      color: var(--accent-foreground);
    }
    .instruction-card strong { color: inherit; }
    .code-snippet {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
      background: var(--muted);
      border: 1px solid var(--border);
      padding: 0.75rem 1rem;
      border-radius: var(--radius);
      font-family: var(--font-mono);
      font-size: 0.75rem;
      color: var(--foreground);
    }
    .code-snippet span { overflow-wrap: anywhere; }
    #toast {
      position: fixed;
      bottom: 1.5rem;
      right: 1.5rem;
      max-width: min(24rem, calc(100vw - 3rem));
      padding: 0.75rem 1.25rem;
      border-radius: var(--radius);
      font-size: 0.875rem;
      font-weight: 600;
      box-shadow: 0 6px 20px var(--hard-shadow);
      opacity: 0;
      transform: translateY(1rem);
      transition: opacity 0.2s ease, transform 0.2s ease;
      z-index: 9999;
      pointer-events: none;
    }
    #toast.show { opacity: 1; transform: translateY(0); }
    #toast.success { background: var(--accent); color: var(--accent-foreground); border: 1px solid var(--primary); }
    #toast.error { background: var(--destructive); color: var(--destructive-foreground); border: 1px solid var(--destructive); }
    .danger-card { border-color: var(--destructive); }
    .danger-title { color: var(--destructive); }
    .reset-actions { justify-content: flex-start; }
    .supporting-text { font-size: 0.8125rem; color: var(--muted-foreground); }
    .usage-metrics {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      padding: 0.75rem 0;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      background: var(--muted);
    }
    .usage-stat {
      min-width: 0;
      padding: 0.25rem 1rem;
      display: flex;
      flex-direction: column;
      gap: 0.2rem;
    }
    .usage-stat + .usage-stat { border-left: 1px solid var(--border); }
    .usage-stat .metric-value { font-size: 1.25rem; line-height: 1.2; }
    .usage-stat .metric-sub { font-size: 0.6875rem; }
    .logs-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 0.75rem;
    }
    .logs-badges {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      flex-wrap: wrap;
    }
    #badge-log-file {
      max-width: 14rem;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--muted-foreground);
      font-family: var(--font-mono);
      font-size: 0.6875rem;
      font-weight: 400;
    }
    .badge-error {
      background: #fde8e8;
      color: var(--destructive);
      border: 1px solid var(--destructive);
    }
    .badge-warn {
      background: #fef3c7;
      color: #92400e;
      border: 1px solid #d97706;
    }
    .logs-toolbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 0.75rem;
      padding: 0;
    }
    .logs-filter-group {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      flex: 1;
      min-width: 18rem;
    }
    .logs-filter-group input {
      flex: 1;
      padding: 0.5rem 0.75rem;
      font-size: 0.8125rem;
    }
    .logs-filter-group select {
      width: auto;
      min-width: 7rem;
      padding: 0.5rem 0.75rem;
      font-size: 0.8125rem;
    }
    .logs-controls {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      flex-wrap: wrap;
    }
    .auto-refresh-toggle {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      font-size: 0.8125rem;
      font-weight: 600;
      color: var(--card-foreground);
      cursor: pointer;
      user-select: none;
      white-space: nowrap;
    }
    .auto-refresh-toggle input {
      width: auto;
      cursor: pointer;
    }
    .log-terminal {
      background: #141c18;
      color: #e2ece7;
      border: 1px solid #23332c;
      border-radius: var(--radius);
      padding: 0.875rem;
      font-family: var(--font-mono);
      font-size: 0.8125rem;
      line-height: 1.6;
      height: 320px;
      overflow-y: auto;
      overflow-x: hidden;
      display: flex;
      flex-direction: column;
      gap: 0.35rem;
    }
    .log-terminal.is-empty {
      height: 144px;
    }
    .log-row {
      display: flex;
      align-items: flex-start;
      gap: 0.5rem;
      padding: 0.2rem 0.35rem;
      border-radius: 0.25rem;
      word-break: break-word;
      transition: background-color 0.1s ease;
    }
    .log-row:hover {
      background: rgba(255, 255, 255, 0.05);
    }
    .log-time {
      color: #7b948b;
      flex: none;
      font-size: 0.75rem;
      padding-top: 0.1rem;
    }
    .log-tag {
      flex: none;
      font-size: 0.6875rem;
      font-weight: 700;
      padding: 0.1rem 0.4rem;
      border-radius: 0.25rem;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .log-tag-info {
      background: #0f362e;
      color: #34d399;
      border: 1px solid #059669;
    }
    .log-tag-warn {
      background: #3b2805;
      color: #fbbf24;
      border: 1px solid #d97706;
    }
    .log-tag-error {
      background: #3b0f0f;
      color: #f87171;
      border: 1px solid #dc2626;
    }
    .log-op {
      color: #93c5fd;
      flex: none;
      font-size: 0.75rem;
      padding-top: 0.05rem;
    }
    .log-msg {
      flex: 1;
      color: #f3f7f5;
    }
    .log-details-chip {
      color: #8da49a;
      font-size: 0.75rem;
      margin-left: 0.35rem;
    }
    .log-empty {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: #a9bcb2;
      text-align: center;
      padding: 1.25rem;
      font-size: 0.8125rem;
    }
    .usage-table-wrapper {
      overflow-x: auto;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      background: var(--card);
    }
    .usage-table {
      width: 100%;
      min-width: 760px;
      border-collapse: collapse;
      font-size: 0.8125rem;
      text-align: left;
    }
    .usage-table th {
      background: var(--muted);
      color: var(--muted-foreground);
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      font-weight: 700;
      padding: 0.625rem 0.75rem;
      border-bottom: 1px solid var(--border);
      white-space: nowrap;
    }
    .usage-table td {
      padding: 0.625rem 0.75rem;
      border-bottom: 1px solid var(--border);
      color: var(--foreground);
      white-space: nowrap;
    }
    .usage-table tbody tr:hover {
      background: rgba(36, 123, 121, 0.05);
    }
    .usage-table tfoot td {
      background: var(--accent);
      color: var(--accent-foreground);
      font-weight: 700;
      border-top: 2px solid var(--primary);
      border-bottom: none;
    }
    .usage-table .usage-empty {
      padding: 1.25rem 0.75rem;
      color: var(--muted-foreground);
      text-align: center;
      white-space: normal;
    }
    .num-col {
      text-align: right;
      font-family: var(--font-mono);
      font-variant-numeric: tabular-nums;
    }
    .model-tag {
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      padding: 0;
      font-family: var(--font-mono);
      font-size: 0.75rem;
      font-weight: 600;
      color: var(--foreground);
    }
    .share-pill {
      display: inline-block;
      min-width: 3rem;
      text-align: right;
      font-family: var(--font-mono);
      font-size: 0.75rem;
      font-weight: 600;
      color: var(--muted-foreground);
    }
    @media (max-width: 900px) {
      .metrics-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .form-grid, .tier-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .usage-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); row-gap: 0.75rem; }
      .usage-stat:nth-child(3) { border-left: 0; }
    }
    @media (max-width: 640px) {
      body { padding: 0.75rem; }
      .card { padding: 1rem; }
      header { flex-direction: column; align-items: flex-start; }
      .card-header { align-items: flex-start; flex-wrap: wrap; }
      .input-group { flex-wrap: wrap; }
      .input-group input { flex-basis: 100%; }
      .action-bar { justify-content: flex-start; }
      .action-bar .btn { width: 100%; }
      .code-snippet { align-items: flex-start; flex-direction: column; }
      .logs-toolbar { flex-direction: column; align-items: stretch; }
      .logs-filter-group { min-width: 0; }
      .logs-controls { justify-content: flex-start; }
      .log-terminal { height: 280px; }
    }
    @media (max-width: 420px) {
      .metrics-grid { grid-template-columns: 1fr; }
      .tier-grid { grid-template-columns: 1fr; }
      .usage-stat { padding: 0.25rem 0.625rem; }
      .usage-stat .metric-title { font-size: 0.625rem; }
      .logs-filter-group { flex-direction: column; align-items: stretch; }
      .logs-filter-group select { width: 100%; }
    }
    @media (prefers-reduced-motion: reduce) {
      .btn, #toast { transition: none; }
    }
  </style>
</head>
<body>
  <div class="container">
    <!-- Header -->
    <header>
      <div class="brand">
        <div class="brand-icon">CC</div>
        <div class="brand-text">
          <h1>Codex2CC Control Panel</h1>
          <p>Local Gateway & Client Configuration Manager</p>
        </div>
      </div>
      <div class="status-badge" id="gateway-badge">
        <span class="pulse-dot"></span>
        <span id="gateway-status-text">Checking gateway...</span>
      </div>
    </header>

    <!-- Metrics -->
    <div class="metrics-grid">
      <div class="metric-card">
        <span class="metric-title">Gateway Endpoint</span>
        <span class="metric-value" id="val-gateway-url">--</span>
        <span class="metric-sub" id="val-auth-mode">Token Protected</span>
      </div>
      <div class="metric-card">
        <span class="metric-title">Claude Code CLI</span>
        <span class="metric-value">
          <span class="badge-sub" id="badge-cli">Checking...</span>
        </span>
        <span class="metric-sub" id="val-cli-path">~/.claude/settings.json</span>
      </div>
      <div class="metric-card">
        <span class="metric-title">Claude Desktop</span>
        <span class="metric-value">
          <span class="badge-sub" id="badge-desktop">Checking...</span>
        </span>
        <span class="metric-sub">Claude-3p/configLibrary</span>
      </div>
    </div>

    <!-- Main Configuration Form -->
    <section class="card" aria-labelledby="configuration-title">
      <div class="card-header">
        <h2 class="card-title" id="configuration-title">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
          Client Configuration (Claude Code & Claude Desktop)
        </h2>
      </div>

      <div class="form-grid">
        <div class="field">
          <label for="input-url">Gateway Base URL</label>
          <input type="text" id="input-url" placeholder="http://127.0.0.1:3456" readonly />
        </div>
        <div class="field">
          <label for="input-token">Gateway Auth Token</label>
          <div class="input-group">
            <input type="password" id="input-token" autocomplete="off" placeholder="No token required" readonly />
            <button class="btn btn-secondary btn-sm" id="btn-copy-token" type="button" title="Copy token">Copy</button>
          </div>
        </div>
      </div>

      <div class="field">
        <label for="select-target">Target Application(s)</label>
        <select id="select-target">
          <option value="all">Both (Claude Code CLI + Claude Desktop)</option>
          <option value="cli">Claude Code CLI only (~/.claude/settings.json)</option>
          <option value="desktop">Claude Desktop only</option>
        </select>
      </div>

      <div class="action-bar">
        <button class="btn btn-primary" id="btn-apply" type="button">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
          Apply Configuration
        </button>
      </div>

      <div class="instruction-card">
        <strong>Next Steps after applying:</strong>
        <ul style="margin-left: 20px; margin-top: 6px;">
          <li><strong>Claude Desktop:</strong> Restart the Claude Desktop app, then click <em>"Continue with Gateway"</em> (do not log in with claude.ai).</li>
          <li><strong>Claude Code CLI:</strong> Reload your terminal or VS Code / Cursor session, then run <code>claude</code> directly.</li>
        </ul>
      </div>
    </section>

    <!-- Claude Tier Model Mapping -->
    <section class="card" aria-labelledby="tier-mapping-title">
      <div class="card-header">
        <h2 class="card-title" id="tier-mapping-title">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h16M4 12h16M4 17h16"/><circle cx="8" cy="7" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="10" cy="17" r="2"/></svg>
          Claude tier model mapping
        </h2>
        <span class="badge-sub" id="tier-mapping-status">Loading…</span>
      </div>
      <p class="supporting-text">Choose which ChatGPT model handles each Claude model tier. Gateway routing updates immediately and is saved for future starts. Re-apply client configuration and reload Claude Code sessions to update their saved tier aliases.</p>
      <div class="tier-grid">
        <div class="field">
          <label for="tier-fable">Fable</label>
          <select id="tier-fable" data-tier="fable"></select>
        </div>
        <div class="field">
          <label for="tier-opus">Opus</label>
          <select id="tier-opus" data-tier="opus"></select>
        </div>
        <div class="field">
          <label for="tier-sonnet">Sonnet</label>
          <select id="tier-sonnet" data-tier="sonnet"></select>
        </div>
        <div class="field">
          <label for="tier-haiku">Haiku</label>
          <select id="tier-haiku" data-tier="haiku"></select>
        </div>
      </div>
      <div class="action-bar">
        <button class="btn btn-secondary" id="btn-reset-tier-mapping" type="button">Use defaults</button>
        <button class="btn btn-primary" id="btn-save-tier-mapping" type="button">Save mapping</button>
      </div>
    </section>

    <!-- Token Usage Summary Table -->
    <section class="card" id="section-usage" aria-labelledby="usage-title">
      <div class="card-header">
        <h2 class="card-title" id="usage-title">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
          Token usage
        </h2>
        <div class="logs-controls">
          <button class="btn btn-secondary btn-sm" id="btn-refresh-usage" type="button" title="Refresh token usage">Refresh</button>
          <button class="btn btn-secondary btn-sm" id="btn-reset-usage" type="button" title="Reset token usage counters">Reset counters</button>
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

    <!-- Live Activity & Debug Logs -->
    <section class="card" id="section-logs" aria-labelledby="logs-title">
      <div class="card-header logs-header">
        <h2 class="card-title" id="logs-title">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
          Gateway activity
        </h2>
        <div class="logs-badges">
          <span class="badge-sub badge-active" id="badge-log-count">0 logs</span>
          <span class="badge-sub badge-warn" id="badge-warn-count" style="display:none;">0 warnings</span>
          <span class="badge-sub badge-error" id="badge-err-count" style="display:none;">0 errors</span>
        </div>
      </div>
      <div class="logs-toolbar">
        <div class="logs-filter-group">
          <input type="search" id="input-log-search" aria-label="Search logs" placeholder="Search logs" />
          <select id="select-log-level" aria-label="Log level">
            <option value="all">All levels</option>
            <option value="info">Info</option>
            <option value="warn">Warnings</option>
            <option value="error">Errors</option>
          </select>
        </div>
        <div class="logs-controls">
          <label class="auto-refresh-toggle" title="Poll every 2 seconds for live traffic">
            <input type="checkbox" id="check-auto-refresh" checked />
            Live (2s)
          </label>
          <button class="btn btn-secondary btn-sm" id="btn-refresh-logs" type="button" title="Fetch latest logs">Refresh</button>
          <button class="btn btn-secondary btn-sm" id="btn-copy-logs" type="button" title="Copy all visible logs">Copy</button>
          <button class="btn btn-secondary btn-sm" id="btn-clear-logs" type="button" title="Clear log history">Clear</button>
        </div>
      </div>

      <div class="log-terminal is-empty" id="log-terminal" role="log" aria-live="polite">
        <div class="log-empty">Connecting to gateway log feed…</div>
      </div>
    </section>

    <!-- Danger Zone / Reset Card -->
    <section class="card danger-card" aria-labelledby="reset-title">
      <div class="card-header">
        <h2 class="card-title danger-title" id="reset-title">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          Reset Configuration (Factory Clean)
        </h2>
      </div>
      <p class="supporting-text">
        Removes the gateway connection and restores standard Anthropic settings without deleting your chat history or unrelated environment variables.
      </p>
      <div class="action-bar reset-actions">
        <button class="btn btn-danger" id="btn-reset-all" type="button">Reset Everything (CLI + Desktop)</button>
        <button class="btn btn-secondary" id="btn-reset-cli" type="button">Reset CLI Only</button>
        <button class="btn btn-secondary" id="btn-reset-desktop" type="button">Reset Desktop Only</button>
      </div>
    </section>

    <!-- Standalone Run Command Box -->
    <section class="card" aria-labelledby="command-title">
      <div class="card-header">
        <h2 class="card-title" id="command-title">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
          CLI Gateway Run Command
        </h2>
      </div>
      <p class="supporting-text">
        To run the gateway as a background service on your Mac with this exact token:
      </p>
      <div class="code-snippet">
        <span id="text-run-cmd">CODEX2CC_TOKEN="..." node dist/main.js --serve --port 3456</span>
        <button class="btn btn-secondary btn-sm" id="btn-copy-cmd" type="button">Copy</button>
      </div>
    </section>
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

    function renderStatus(s) {
      document.getElementById("val-gateway-url").textContent = s.gateway.url;
      document.getElementById("val-auth-mode").textContent = s.gateway.policyMode === "token" ? "Token Protected" : "Open (--no-auth)";

      function applyBadge(badge, client) {
        if (client.configured && client.inSync) {
          badge.textContent = "Configured";
          badge.className = "badge-sub badge-active";
        } else if (client.configured) {
          badge.textContent = "Out of sync - click Apply";
          badge.className = "badge-sub badge-inactive";
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
    }

    function updateRunCommand() {
      const url = document.getElementById("input-url").value || "http://127.0.0.1:3456";
      let port = "3456";
      try { port = new URL(url).port || "3456"; } catch {}
      const token = document.getElementById("input-token").value || "YOUR_SECRET_TOKEN";
      document.getElementById("text-run-cmd").textContent = 'CODEX2CC_TOKEN="' + token + '" node dist/main.js --serve --port ' + port;
    }

    document.getElementById("btn-copy-token").addEventListener("click", () => {
      const val = document.getElementById("input-token").value;
      if (!val) return;
      navigator.clipboard.writeText(val);
      showToast("Token copied to clipboard!");
    });

    document.getElementById("btn-copy-cmd").addEventListener("click", () => {
      const cmd = document.getElementById("text-run-cmd").textContent;
      navigator.clipboard.writeText(cmd);
      showToast("Run command copied to clipboard!");
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
      try {
        const res = await fetch("/api/ui/tiers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tiers }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || "HTTP " + res.status);
        showToast("Tier model mapping saved.");
        await fetchStatus();
      } catch (err) {
        showToast("Failed to save tier mapping: " + err.message, "error");
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
        showToast("Reset completed for " + target + "!");
        fetchStatus();
      } catch (err) {
        showToast("Reset failed: " + err.message, "error");
      }
    }

    document.getElementById("btn-reset-all").addEventListener("click", () => sendReset("all"));
    document.getElementById("btn-reset-cli").addEventListener("click", () => sendReset("cli"));
    document.getElementById("btn-reset-desktop").addEventListener("click", () => sendReset("desktop"));

    let logsCache = [];
    let autoRefreshInterval = null;

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

    function renderLogs(logs, stats, logFile) {
      const terminal = document.getElementById("log-terminal");
      if (!terminal) return;
      terminal.classList.toggle("is-empty", logs.length === 0);

      if (stats) {
        document.getElementById("badge-log-count").textContent = stats.total + " log" + (stats.total === 1 ? "" : "s");
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
        } else {
          errEl.style.display = "none";
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
          if (!autoRefreshInterval) {
            autoRefreshInterval = setInterval(() => {
              fetchLogs();
              fetchUsage();
            }, 2000);
          }
        } else {
          if (autoRefreshInterval) {
            clearInterval(autoRefreshInterval);
            autoRefreshInterval = null;
          }
        }
      }
      autoRefreshCheck.addEventListener("change", updateAutoRefresh);
      updateAutoRefresh();
      fetchLogs();
    }

    function fmt(n) {
      return (Number(n) || 0).toLocaleString();
    }

    async function fetchUsage() {
      try {
        const res = await fetch("/api/ui/usage");
        if (!res.ok) return;
        const data = await res.json();
        renderUsage(data);
      } catch (err) {
        // Silently skip transient errors
      }
    }

    function renderUsage(data) {
      if (!data) return;
      document.getElementById("val-total-tokens").textContent = fmt(data.grandTotalTokens);
      document.getElementById("val-total-reqs").textContent = fmt(data.totalRequests) + (data.totalRequests === 1 ? " request" : " requests");
      document.getElementById("val-input-tokens").textContent = fmt(data.totalInputTokens);
      document.getElementById("val-output-tokens").textContent = fmt(data.totalOutputTokens);
      document.getElementById("val-cached-tokens").textContent = fmt(data.totalCachedTokens);

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

        html += '<tr>' +
          '<td><span class="model-tag">' + escapeHtml(m.model) + '</span></td>' +
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
      document.getElementById("btn-refresh-usage").addEventListener("click", () => fetchUsage());
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

    fetchStatus();
    fetchUsage();
    setupUsageControls();
    setupLogControls();
  </script>
</body>
</html>`;
}
