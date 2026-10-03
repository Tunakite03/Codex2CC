#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { ChatGPTSession } from "./auth.js";
import { BridgeError } from "./bridge.js";
import { parseCli, standalonePolicy, USAGE } from "./cli.js";
import { createGatewayServer, listenOnLoopback, type ModelInfo } from "./gateway.js";
import { loadTierModels, tierModel } from "./models.js";
import type { GuardPolicy } from "./guard.js";

async function serveStandalone(
  session: ChatGPTSession,
  defaultModel: string,
  availableModels: readonly ModelInfo[],
  requestedPort: number,
  policy: GuardPolicy,
): Promise<void> {
  const server = createGatewayServer({ session, defaultModel, availableModels, policy, tiers: loadTierModels(process.env) });
  const port = await listenOnLoopback(server, requestedPort);

  process.stdout.write(`\n🚀 Codex2CC Standalone Gateway is RUNNING!\n`);
  process.stdout.write(`   Base URL: http://127.0.0.1:${port}\n`);
  process.stdout.write(`   Active Codex Model: ${defaultModel}\n`);
  process.stdout.write(`   Available Models: ${availableModels.map((m) => m.slug).join(", ")}\n`);
  if (policy.mode === "token") {
    process.stdout.write(`   API key (send as "Authorization: Bearer" or "x-api-key"): ${policy.token}\n`);
  } else {
    process.stdout.write(`   WARNING: authentication disabled (--no-auth). Any local process can spend your ChatGPT quota.\n`);
  }
  process.stdout.write(`   Compatible Clients: Cherry Studio, Chatbox, Cline, Roo Code, LibreChat, TypingMind\n`);
  process.stdout.write(`   Press Ctrl+C to stop.\n\n`);

  await new Promise<void>((resolve) => {
    process.once("SIGINT", () => resolve());
    process.once("SIGTERM", () => resolve());
  });

  server.close();
}

async function serveClaudeCli(
  session: ChatGPTSession,
  selectedModel: string,
  availableModels: readonly ModelInfo[],
  args: readonly string[],
): Promise<number> {
  const secret = randomBytes(32).toString("base64url");
  const tiers = loadTierModels(process.env);
  const server = createGatewayServer({
    session,
    defaultModel: selectedModel,
    availableModels,
    policy: { mode: "token", token: secret },
    tiers,
  });
  const port = await listenOnLoopback(server, 0);

  const modelSlugs = new Set(availableModels.map((m) => m.slug));
  const opusModel = tierModel(tiers, "opus", modelSlugs, selectedModel);
  const sonnetModel = tierModel(tiers, "sonnet", modelSlugs, selectedModel);
  const haikuModel = tierModel(tiers, "haiku", modelSlugs, selectedModel);

  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    ANTHROPIC_AUTH_TOKEN: secret,
    ANTHROPIC_MODEL: selectedModel,
    ANTHROPIC_DEFAULT_OPUS_MODEL: opusModel,
    ANTHROPIC_DEFAULT_SONNET_MODEL: sonnetModel,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: haikuModel,
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
    CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: "1",
  };
  delete environment.ANTHROPIC_API_KEY;

  // Status goes to stderr so `codex2cc -p "..."` keeps stdout clean for piping.
  process.stderr.write(`Codex2CC gateway running on http://127.0.0.1:${port}\n`);
  process.stderr.write(`Using ChatGPT Plus model "${selectedModel}" in Claude Code CLI.\n`);
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

async function main(): Promise<void> {
  const command = parseCli(process.argv.slice(2));

  if (command.kind === "help") {
    process.stdout.write(USAGE);
    return;
  }

  if (command.kind === "mcp") {
    const { runMcpServer } = await import("./mcp.js");
    await runMcpServer();
    return;
  }

  const session = await ChatGPTSession.open();
  const models = await session.listModels();

  if (command.kind === "list-models") {
    for (const model of models) process.stdout.write(`${model.slug}\t${model.displayName}\n`);
    return;
  }

  const selectedModel = command.model ?? models[0]?.slug;
  if (!selectedModel || !models.some((m) => m.slug === selectedModel)) {
    throw new BridgeError(400, "model_unavailable", `Selected model "${selectedModel}" is not in the ChatGPT account model catalog (available: ${models.map((m) => m.slug).join(", ")}).`);
  }

  if (command.kind === "serve") {
    await serveStandalone(session, selectedModel, models, command.port, standalonePolicy(command.noAuth, process.env.CODEX2CC_TOKEN));
    return;
  }

  process.exitCode = await serveClaudeCli(session, selectedModel, models, command.claudeArgs);
}

main().catch((error: Error) => {
  const typed = error instanceof BridgeError ? error : new BridgeError(500, "startup_failed", error.message);
  process.stderr.write(`${JSON.stringify({ level: "error", operation: "startup", code: typed.code, message: typed.message })}\n`);
  process.exitCode = 1;
});
