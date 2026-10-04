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
      padding: clamp(0.75rem, 2.4vw, 1.75rem);
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
    /* Navigation Tabs */
    .nav-tabs {
      display: flex;
      align-items: center;
      gap: 0.15rem;
      background: transparent;
      border: 0;
      border-bottom: 1.5px solid var(--line);
      border-radius: 0;
      padding: 0;
      box-shadow: none;
      overflow-x: auto;
      scrollbar-width: none;
    }
    .nav-tabs::-webkit-scrollbar { display: none; }
    .nav-tab {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.6rem 0.85rem 0.55rem;
      border-bottom: 3px solid transparent;
      border-left: 0;
      border-right: 0;
      border-top: 0;
      border-radius: 0.45rem 0.45rem 0 0;
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
      border-bottom-color: var(--coral);
    }
    .tab-badge {
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

    /* Gateway Compact Bar */
    .gateway-bar {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 0.85rem;
      background: var(--card);
      border: 1.5px solid var(--line);
      border-radius: 1rem 0.85rem 1.1rem 0.9rem;
      padding: 0.9rem 1.15rem;
      box-shadow: var(--card-shadow);
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
      body { padding: 0.75rem; }
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
  <div class="container">
    <!-- Header -->
    <header>
      <div class="brand">
        <div class="brand-icon">CC</div>
        <div class="brand-text">
          <h1>Codex2CC Control Panel</h1>
          <p>Local gateway · Claude client setup</p>
        </div>
      </div>
      <div class="status-badge" id="gateway-badge">
        <span class="pulse-dot"></span>
        <span id="gateway-status-text">Checking gateway...</span>
      </div>
    </header>

    <!-- Navigation Tabs -->
    <nav class="nav-tabs" role="tablist" aria-label="Control Panel Sections">
      <button class="nav-tab active" data-tab="tab-setup" role="tab" aria-selected="true" id="tab-btn-setup" type="button">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
        <span>Overview & Clients</span>
      </button>
      <button class="nav-tab" data-tab="tab-routing" role="tab" aria-selected="false" id="tab-btn-routing" type="button">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h16M4 12h16M4 17h16"/><circle cx="8" cy="7" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="10" cy="17" r="2"/></svg>
        <span>Model Routing</span>
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

    <!-- Tab 1: Overview & Clients -->
    <div class="tab-pane active" id="tab-setup" role="tabpanel">
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

      <!-- Clients Configuration Card -->
      <section class="card" aria-labelledby="configuration-title">
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
      </section>
    </div>

    <!-- Tab 2: Model Routing -->
    <div class="tab-pane" id="tab-routing" role="tabpanel">
      <section class="card" aria-labelledby="tier-mapping-title">
        <div class="card-header">
          <h2 class="card-title" id="tier-mapping-title">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h16M4 12h16M4 17h16"/><circle cx="8" cy="7" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="10" cy="17" r="2"/></svg>
            Model routing
          </h2>
          <span class="badge-sub" id="tier-mapping-status">Loading…</span>
        </div>
        <p class="card-desc">Map each Claude tier to a ChatGPT backend model. Changes apply immediately upon saving.</p>

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

        <div class="tier-actions">
          <span class="supporting-text">Re-apply client setup and reload Claude Code to refresh saved model aliases.</span>
          <div style="display:flex;gap:0.5rem;">
            <button class="btn btn-secondary btn-sm" id="btn-reset-tier-mapping" type="button">Use defaults</button>
            <button class="btn btn-primary btn-sm" id="btn-save-tier-mapping" type="button">Save mapping</button>
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
            <label class="auto-refresh-toggle" title="Poll every 2 seconds for live traffic">
              <input type="checkbox" id="check-auto-refresh" checked />
              Live (2s)
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
      }

      tabs.forEach(tab => {
        tab.addEventListener("click", () => activateTab(tab.dataset.tab));
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

    function renderStatus(s) {
      document.getElementById("val-gateway-url").textContent = s.gateway.url;
      document.getElementById("val-auth-mode").textContent = s.gateway.policyMode === "token" ? "Token Protected" : "Open (--no-auth)";

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

    setupTabs();
    fetchStatus();
    fetchUsage();
    setupUsageControls();
    setupLogControls();
  </script>
</body>
</html>`;
}
