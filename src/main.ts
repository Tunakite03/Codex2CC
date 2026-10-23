#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { ChatGPTSession } from "./auth/auth.js";
import { BridgeError } from "./bridge/bridge.js";
import { parseCli, standalonePolicy, USAGE } from "./cli/cli.js";
import { createGatewayServer, listenOnLoopback, type GatewayOptions, type ModelInfo, type UpstreamSession } from "./gateway/gateway.js";
import { claudeLaunchEnvironment } from "./config/config-setup.js";
import {
  BOTH_PROFILES,
  describeOutcome,
  describePlans,
  desktopProcessState,
  DRY_RUN_TENSE,
  planDesktopSessionSync,
  requireDesktopClosed,
  resolveDesktopSessionPaths,
  runDesktopSessionSync,
  syncDesktopSessionsWhenClosed,
  TO_CLAUDE_PROFILE,
  TO_GATEWAY_PROFILE,
  type SyncDirection,
} from "./config/desktop-sessions.js";
import { getActiveLogFilePath } from "./telemetry/logger.js";
import {
  PROVIDER_LABELS,
  OFFLINE_CODEX_MODELS,
  routedModels,
  smallestContextWindow,
  tierModel,
} from "./models/models.js";
import { activeTierModels, resolveTierFilePath, TierModelStore } from "./models/tier-store.js";
import { isApiProvider, requireApiKey } from "./providers/config.js";
import { getProviderConfig, providerDefaultModel, providerModels } from "./providers/runtime.js";
import { enableUsagePersistence, resolveUsageFilePath } from "./telemetry/usage.js";

/** Defers Codex authentication until the UI switches to Codex and actually uses that session. */
function lazyCodexSession(): UpstreamSession {
  let session: ChatGPTSession | undefined;
  let opening: Promise<ChatGPTSession> | undefined;
  const getSession = async (): Promise<ChatGPTSession> => {
    if (session) return session;
    const pending = opening ??= ChatGPTSession.open();
    try {
      session = await pending;
      return session;
    } finally {
      // A failed open can be retried after the user signs in; concurrent callers share one open.
      if (opening === pending) opening = undefined;
    }
  };
  return {
    async accessToken() { return (await getSession()).accessToken(); },
    async refreshAfterRejection(rejected: string) { return (await getSession()).refreshAfterRejection(rejected); },
    accountId: () => session?.accountId() ?? "",
    async getUsageLimits(forceRefresh?: boolean) { return (await getSession()).getUsageLimits(forceRefresh); },
  };
}

function warnLoginUnavailable(operation: string, error: Error): void {
  process.stderr.write(`${JSON.stringify({ level: "warn", operation, message: `ChatGPT session unavailable: ${error.message}` })}\n`);
}

async function serveStandalone(options: GatewayOptions, requestedPort: number): Promise<void> {
  const server = createGatewayServer(options);
  const provider = options.provider ?? "codex";
  const policy = options.policy;
  const defaultModel = providerDefaultModel(options, provider);
  const availableModels = providerModels(options, provider);
  const port = await listenOnLoopback(server, requestedPort);
  const logFile = getActiveLogFilePath();
  const providerLabel = PROVIDER_LABELS[provider];

  process.stdout.write(`\n🚀 Codex2CC Standalone Gateway is RUNNING!\n`);
  process.stdout.write(`   Base URL: http://127.0.0.1:${port}\n`);
  process.stdout.write(`   Web Control Panel: http://127.0.0.1:${port}/ui\n`);
  process.stdout.write(`   Active Provider: ${providerLabel}\n`);
  if (logFile) {
    process.stdout.write(`   Log File: ${logFile}\n`);
  }
  process.stdout.write(`   Active Model: ${defaultModel}\n`);
  process.stdout.write(`   Available Models: ${availableModels.map((m) => m.slug).join(", ")}\n`);
  if (policy.mode === "token") {
    process.stdout.write(`   API key (send as "Authorization: Bearer" or "x-api-key"): ${policy.token}\n`);
  } else {
    process.stdout.write(`   WARNING: authentication disabled (--no-auth). Any local process can spend your quota.\n`);
  }
  process.stdout.write(`   Compatible Clients: Cherry Studio, Chatbox, Cline, Roo Code, LibreChat, TypingMind\n`);
  process.stdout.write(`   Press Ctrl+C to stop.\n\n`);

  await new Promise<void>((resolve) => {
    process.once("SIGINT", () => resolve());
    process.once("SIGTERM", () => resolve());
  });

  server.close();
}

async function serveClaudeCli(options: GatewayOptions, args: readonly string[]): Promise<number> {
  const provider = options.provider ?? "codex";
  if (isApiProvider(provider)) requireApiKey(getProviderConfig(options, provider), options.providerEnv ?? process.env);
  const selectedModel = providerDefaultModel(options, provider);
  const availableModels = providerModels(options, provider);
  const tiers = activeTierModels(options);
  const secret = randomBytes(32).toString("base64url");
  const server = createGatewayServer({ ...options, policy: { mode: "token", token: secret } });
  const port = await listenOnLoopback(server, 0);

  const modelSlugs = new Set(availableModels.map((m) => m.slug));
  const opusModel = tierModel(tiers, "opus", modelSlugs, selectedModel);
  const sonnetModel = tierModel(tiers, "sonnet", modelSlugs, selectedModel);
  const haikuModel = tierModel(tiers, "haiku", modelSlugs, selectedModel);

  const environment = claudeLaunchEnvironment(process.env, {
    gatewayUrl: `http://127.0.0.1:${port}`,
    token: secret,
    model: selectedModel,
    opusModel,
    sonnetModel,
    haikuModel,
    // Unavailable tier models fall back to selectedModel, which routedModels already includes.
    maxContextTokens: smallestContextWindow(availableModels, routedModels(tiers, selectedModel)),
  });

  const providerLabel = PROVIDER_LABELS[provider];
  // Status goes to stderr so `codex2cc -p "..."` keeps stdout clean for piping.
  process.stderr.write(`Codex2CC gateway running on http://127.0.0.1:${port}\n`);
  process.stderr.write(`Using ${providerLabel} model "${selectedModel}" in Claude Code CLI.\n`);
  process.stderr.write(`Models mapped: Opus -> ${opusModel}, Sonnet -> ${sonnetModel}, Haiku -> ${haikuModel}\n`);

  try {
    return await new Promise<number>((resolve, reject) => {
      const child = spawn("claude", [...args], { stdio: "inherit", shell: false, env: environment });
      child.once("error", reject);
      child.once("exit", (code, signal) => signal ? reject(new BridgeError(500, "claude_terminated", `Claude Code ended with signal ${signal}.`)) : resolve(code ?? 0));
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

/** Runs after a Desktop setup or reset; a Desktop that is open (or unverifiable) skips it with a hint. */
function syncDesktopSessionsAfterSwitch(directions: readonly SyncDirection[]): void {
  const outcome = syncDesktopSessionsWhenClosed(directions, resolveDesktopSessionPaths(), desktopProcessState(), new Date());
  process.stdout.write(`\n🔁 Desktop session lists:\n`);
  for (const line of describeOutcome(outcome)) process.stdout.write(`   ${line}\n`);
  // The setup or reset itself is done; a failed sync still makes the command exit non-zero.
  if (outcome.status === "failed") process.exitCode = 1;
}

async function main(): Promise<void> {
  const command = parseCli(process.argv.slice(2));

  if (command.kind === "help") {
    process.stdout.write(USAGE);
    return;
  }

  enableUsagePersistence(resolveUsageFilePath());

  if (command.kind === "sync-desktop-sessions") {
    const paths = resolveDesktopSessionPaths();
    if (command.dryRun) {
      for (const line of describePlans(planDesktopSessionSync(BOTH_PROFILES, paths), DRY_RUN_TENSE)) process.stdout.write(`${line}\n`);
      return;
    }
    requireDesktopClosed(desktopProcessState());
    const outcome = runDesktopSessionSync(BOTH_PROFILES, paths, new Date());
    for (const line of describeOutcome(outcome)) process.stdout.write(`${line}\n`);
    if (outcome.status === "failed") process.exitCode = 1;
    return;
  }

  if (command.kind === "reset-config") {
    const { resetConfig } = await import("./config/config-setup.js");
    const result = resetConfig(command.target);
    process.stdout.write(`\n🧹 Codex2CC Configuration Reset Complete!\n`);
    if (result.cliReset) process.stdout.write(`   ✓ Claude Code CLI config cleaned (~/.claude/settings.json, ~/.claude.json)\n`);
    if (result.desktopReset) process.stdout.write(`   ✓ Claude Desktop config removed\n`);
    if (result.filesModified.length > 0) {
      process.stdout.write(`   Files updated:\n`);
      for (const file of result.filesModified) process.stdout.write(`     - ${file}\n`);
    }
    if (result.desktopReset) syncDesktopSessionsAfterSwitch(TO_CLAUDE_PROFILE);
    process.stdout.write(`\nPlease restart Claude Desktop and any active terminal/IDE sessions.\n\n`);
    return;
  }

  const tierStore = TierModelStore.open(resolveTierFilePath(process.env), process.env);
  const provider = command.provider ?? tierStore.getProvider();
  let session: ChatGPTSession | undefined;
  let codexModels: readonly ModelInfo[] = OFFLINE_CODEX_MODELS;
  let codexCatalogLoaded = false;
  // API and Antigravity modes use local catalogs without Codex authentication or discovery.
  if (provider === "codex") {
    try {
      session = await ChatGPTSession.open();
      codexModels = await session.listModels();
      codexCatalogLoaded = true;
    } catch (error) {
      if (provider === "codex" && command.kind !== "ui" && command.kind !== "setup") throw error;
      if (provider === "codex") warnLoginUnavailable(`${command.kind}_login_unavailable`, error instanceof Error ? error : new Error("Unknown login failure"));
    }
  }
  const options: GatewayOptions = {
    session: session ?? lazyCodexSession(),
    defaultModel: codexModels[0]?.slug ?? OFFLINE_CODEX_MODELS[0]!.slug,
    availableModels: codexModels,
    policy: { mode: "open" },
    tierStore,
    provider,
    providerEnv: process.env,
    ...("model" in command && command.model ? { defaultModels: { [provider]: command.model } } : {}),
  };
  const models = providerModels(options, provider);
  if (command.kind === "list-models") {
    for (const model of models) process.stdout.write(`${model.slug}\t${model.displayName}\n`);
    return;
  }
  // Offline Codex setup can target an external gateway whose catalog is not available locally.
  const offlineCodexSetup = command.kind === "setup" && provider === "codex" && !codexCatalogLoaded;
  const selectedModel = command.model ?? (offlineCodexSetup ? tierStore.current(provider).sonnet : providerDefaultModel(options, provider));
  if (!offlineCodexSetup && !models.some((model) => model.slug === selectedModel)) {
    throw new BridgeError(400, "model_unavailable", `Selected model "${selectedModel}" is not in the ${PROVIDER_LABELS[provider]} model catalog (available: ${models.map((model) => model.slug).join(", ")}).`);
  }

  if (command.kind === "ui") {
    const { openBrowser } = await import("./ui/ui.js");
    const { configuredGatewayToken } = await import("./config/config-setup.js");
    const policy = standalonePolicy(false, process.env.CODEX2CC_TOKEN ?? configuredGatewayToken(`http://127.0.0.1:${command.port}`));
    const server = createGatewayServer({ ...options, policy });
    const port = await listenOnLoopback(server, command.port);

    const uiUrl = `http://127.0.0.1:${port}/ui`;
    const logFile = getActiveLogFilePath();
    process.stdout.write(`\n🚀 Codex2CC Web Control Panel is RUNNING!\n`);
    process.stdout.write(`   Control Panel: ${uiUrl}\n`);
    process.stdout.write(`   API Gateway:   http://127.0.0.1:${port}\n`);
    if (logFile) {
      process.stdout.write(`   Log File:      ${logFile}\n`);
    }
    if (policy.mode === "token") {
      process.stdout.write(`   Gateway Token: ${policy.token}\n`);
    }
    process.stdout.write(`   Opening browser...\n`);
    process.stdout.write(`   Press Ctrl+C to stop.\n\n`);

    openBrowser(uiUrl);

    await new Promise<void>((resolve) => {
      process.once("SIGINT", () => resolve());
      process.once("SIGTERM", () => resolve());
    });

    server.close();
    return;
  }

  if (command.kind === "setup") {
    const { setupConfig } = await import("./config/config-setup.js");
    const tiers = tierStore.current(provider);
    const availableModels = offlineCodexSetup ? undefined : models.map((model) => model.slug);
    const maxContextTokens = smallestContextWindow(models, routedModels(tiers, selectedModel));

    const token = command.token || process.env.CODEX2CC_TOKEN;
    const effort = command.effort || process.env.CLAUDE_CODE_EFFORT_LEVEL;
    const result = setupConfig(command.target, {
      gatewayUrl: command.gatewayUrl,
      token: token ?? "",
      model: selectedModel,
      effort,
      tiers,
      availableModels,
      maxContextTokens,
    });

    process.stdout.write(`\n✅ Codex2CC Gateway Configuration Applied!\n`);
    process.stdout.write(`   Gateway URL: ${result.gatewayUrl}\n`);
    process.stdout.write(`   Token: ${result.token}\n`);
    process.stdout.write(`   Default Model: ${result.model}\n`);
    if (result.effort) {
      process.stdout.write(`   Reasoning Effort: ${result.effort}\n`);
    }
    if (result.cliConfigured) {
      process.stdout.write(`   ✓ Claude Code CLI: configured (~/.claude/settings.json)\n`);
    }
    if (result.desktopConfigured) {
      process.stdout.write(`   ✓ Claude Desktop: configured with provider "gateway"\n`);
    }
    process.stdout.write(`\n   Files updated:\n`);
    for (const file of result.filesModified) {
      process.stdout.write(`     - ${file}\n`);
    }

    if (!token && result.gatewayUrl.startsWith("http://127.0.0.1")) {
      const parsedPort = new URL(result.gatewayUrl).port || "3456";
      process.stdout.write(`\n💡 To start the standalone gateway with this token, run:\n`);
      process.stdout.write(`   CODEX2CC_TOKEN="${result.token}" node dist/main.js --serve --port ${parsedPort} --provider ${provider}\n`);
    }
    if (result.desktopConfigured) {
      syncDesktopSessionsAfterSwitch(TO_GATEWAY_PROFILE);
      process.stdout.write(`\n👉 Claude Desktop: Restart Claude Desktop, then select "Continue with Gateway".\n`);
    }
    if (result.cliConfigured) {
      process.stdout.write(`👉 Claude Code CLI: Reload VS Code/Cursor or terminal, then run: claude\n\n`);
    }
    return;
  }

  if (command.kind === "serve") {
    const { configuredGatewayToken } = await import("./config/config-setup.js");
    const policy = command.noAuth
      ? standalonePolicy(true, undefined)
      : standalonePolicy(false, process.env.CODEX2CC_TOKEN ?? configuredGatewayToken(`http://127.0.0.1:${command.port}`));
    await serveStandalone({ ...options, policy }, command.port);
    return;
  }

  process.exitCode = await serveClaudeCli(options, command.claudeArgs);
}

main().catch((error: Error) => {
  const typed = error instanceof BridgeError ? error : new BridgeError(500, "startup_failed", error.message);
  process.stderr.write(`${JSON.stringify({ level: "error", operation: "startup", code: typed.code, message: typed.message })}\n`);
  process.exitCode = 1;
});
