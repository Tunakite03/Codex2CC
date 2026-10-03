#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { z } from "zod";
import { ChatGPTSession } from "./auth.js";
import {
  AnthropicStream,
  BridgeError,
  MessageAccumulator,
  MessageRequest,
  readSse,
  toOpenAIRequest,
} from "./bridge.js";
import { checkClient, checkHost, MIN_TOKEN_LENGTH, requestPathname, type GuardPolicy, type GuardResult } from "./guard.js";

const MAX_BODY_BYTES = 16 * 1024 * 1024;
const CHATGPT_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";

function sendError(response: ServerResponse, error: BridgeError): void {
  const body = {
    type: "error",
    error: {
      type: error.status === 400 ? "invalid_request_error" : error.status === 429 ? "rate_limit_error" : "api_error",
      message: error.message,
    },
  };
  if (response.headersSent) {
    response.write(`event: error\ndata: ${JSON.stringify(body)}\n\n`);
    response.end();
  } else {
    response.writeHead(error.status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
  }
}

async function readBody(request: IncomingMessage): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new BridgeError(413, "request_too_large", "Claude Code request exceeds 16 MiB.");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseRequest(raw: string): MessageRequest {
  try {
    const result = MessageRequest.safeParse(JSON.parse(raw));
    if (!result.success) {
      throw new BridgeError(400, "invalid_message", `Claude Code request failed validation: ${result.error.issues[0]?.path.join(".") ?? "body"}.`);
    }
    return result.data;
  } catch (error) {
    if (error instanceof SyntaxError) throw new BridgeError(400, "invalid_json", "Claude Code sent malformed JSON.");
    throw error;
  }
}

function sendGuardFailure(response: ServerResponse, failure: Extract<GuardResult, { ok: false }>): void {
  response.writeHead(failure.status, { "Content-Type": "application/json" }).end(
    JSON.stringify({ type: "error", error: { type: failure.type, message: failure.message } }),
  );
}

async function openInference(session: ChatGPTSession, body: object): Promise<Response> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const response = await fetch(CHATGPT_RESPONSES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${await session.accessToken()}`,
        "ChatGPT-Account-Id": session.accountId(),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(600_000),
    });
    if ((response.status === 429 || response.status === 503) && attempt < 3) {
      process.stderr.write(`${JSON.stringify({ level: "warn", operation: "inference", attempt, status: response.status })}\n`);
      await response.body?.cancel();
      await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
      continue;
    }
    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new BridgeError(
        response.status === 429 ? 429 : 502,
        "inference_failed",
        `ChatGPT inference returned HTTP ${response.status}: ${errText.slice(0, 200)}`,
      );
    }
    if (!response.body) throw new BridgeError(502, "missing_stream", "ChatGPT inference returned no stream.");
    return response;
  }
  throw new BridgeError(502, "retry_exhausted", "ChatGPT inference failed after bounded retries.");
}

function resolveModelSlug(
  inboundModel: string | undefined,
  defaultModel: string,
  modelSlugs: Set<string>,
): string {
  if (!inboundModel) return defaultModel;
  if (modelSlugs.has(inboundModel)) return inboundModel;
  const lower = inboundModel.toLowerCase();
  if (lower.includes("opus") && modelSlugs.has("gpt-6.1-sol")) return "gpt-6.1-sol";
  if (lower.includes("haiku") && modelSlugs.has("gpt-5.6-sol")) return "gpt-5.6-sol";
  if (lower.includes("sonnet") && modelSlugs.has("gpt-6-sol")) return "gpt-6-sol";
  return defaultModel;
}

async function handleMessage(
  request: IncomingMessage,
  response: ServerResponse,
  session: ChatGPTSession,
  defaultModel: string,
  modelSlugs: Set<string>,
): Promise<void> {
  const inbound = parseRequest(await readBody(request));
  const activeModel = resolveModelSlug(inbound.model, defaultModel, modelSlugs);
  const outgoing = toOpenAIRequest(inbound, activeModel);
  const upstream = await openInference(session, outgoing);
  const toolNames = (inbound.tools ?? []).map((tool) => tool.name);
  if (inbound.stream) {
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    const encoder = new AnthropicStream(response, activeModel, toolNames);
    await readSse(upstream.body!, (event) => encoder.accept(event));
    encoder.assertCompleted();
    response.end();
  } else {
    const accumulator = new MessageAccumulator(activeModel, toolNames);
    await readSse(upstream.body!, (event) => accumulator.accept(event));
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(accumulator.buildMessage()));
  }
}

function createGatewayServer(
  session: ChatGPTSession,
  defaultModel: string,
  availableModels: Array<{ slug: string; displayName: string }>,
  policy: GuardPolicy,
) {
  const modelSlugs = new Set(availableModels.map((m) => m.slug));

  return createServer((request, response) => {
    const hostCheck = checkHost(request.headers);
    if (!hostCheck.ok) {
      sendGuardFailure(response, hostCheck);
      return;
    }
    const path = requestPathname(request.url);
    if (path === undefined) {
      response.writeHead(400).end();
      return;
    }
    if (request.method === "HEAD" && path === "/api/hello") {
      response.writeHead(200).end();
      return;
    }
    const clientCheck = checkClient(request.headers, policy);
    if (!clientCheck.ok) {
      sendGuardFailure(response, clientCheck);
      return;
    }
    if (request.method === "GET" && path === "/v1/models") {
      const list = availableModels.map((m) => ({
        id: m.slug,
        type: "model",
        display_name: `${m.displayName} (ChatGPT Plus)`,
      }));
      list.push(
        { id: "claude-3-7-sonnet-20250219", type: "model", display_name: "Claude 3.7 Sonnet (via ChatGPT)" },
        { id: "claude-3-5-sonnet-20241022", type: "model", display_name: "Claude 3.5 Sonnet (via ChatGPT)" },
        { id: "claude-3-5-haiku-20241022", type: "model", display_name: "Claude 3.5 Haiku (via ChatGPT)" },
      );
      response.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({ data: list, has_more: false, first_id: defaultModel, last_id: defaultModel }),
      );
      return;
    }
    if (request.method !== "POST" || path !== "/v1/messages") {
      response.writeHead(404).end();
      return;
    }
    handleMessage(request, response, session, defaultModel, modelSlugs).catch((error: Error) => {
      const typed = error instanceof BridgeError
        ? error
        : error instanceof z.ZodError
          ? new BridgeError(502, "invalid_upstream_shape", "OpenAI returned data outside the documented schema.")
          : new BridgeError(500, "internal_error", `Codex2CC failed while translating the request: ${error.message}`);
      process.stderr.write(`${JSON.stringify({ level: "error", operation: "bridge_request", code: typed.code, status: typed.status, message: typed.message })}\n`);
      sendError(response, typed);
    });
  });
}

async function serveStandalone(
  session: ChatGPTSession,
  defaultModel: string,
  availableModels: Array<{ slug: string; displayName: string }>,
  requestedPort: number,
  policy: GuardPolicy,
): Promise<void> {
  const server = createGatewayServer(session, defaultModel, availableModels, policy);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, "127.0.0.1", resolve);
  });

  process.stdout.write(`\n🚀 Codex2CC Standalone Gateway is RUNNING!\n`);
  process.stdout.write(`   Base URL: http://127.0.0.1:${requestedPort}\n`);
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
  availableModels: Array<{ slug: string; displayName: string }>,
  args: string[],
): Promise<number> {
  const secret = randomBytes(32).toString("base64url");
  const server = createGatewayServer(session, selectedModel, availableModels, { mode: "token", token: secret });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new BridgeError(500, "gateway_bind_failed", "Could not bind the local gateway.");

  const modelSlugs = new Set(availableModels.map((m) => m.slug));
  const opusModel = modelSlugs.has("gpt-6.1-sol") ? "gpt-6.1-sol" : selectedModel;
  const sonnetModel = modelSlugs.has("gpt-6-sol") ? "gpt-6-sol" : selectedModel;
  const haikuModel = modelSlugs.has("gpt-5.6-sol") ? "gpt-5.6-sol" : selectedModel;

  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
    ANTHROPIC_AUTH_TOKEN: secret,
    ANTHROPIC_MODEL: selectedModel,
    ANTHROPIC_DEFAULT_OPUS_MODEL: opusModel,
    ANTHROPIC_DEFAULT_SONNET_MODEL: sonnetModel,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: haikuModel,
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
    CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: "1",
  };
  delete environment.ANTHROPIC_API_KEY;

  process.stdout.write(`Codex2CC gateway running on http://127.0.0.1:${address.port}\n`);
  process.stdout.write(`Using ChatGPT Plus model "${selectedModel}" in Claude Code CLI.\n`);
  process.stdout.write(`Models mapped: Opus -> ${opusModel}, Sonnet -> ${sonnetModel}, Haiku -> ${haikuModel}\n`);

  try {
    return await new Promise<number>((resolve, reject) => {
      const child = spawn("claude", args, { stdio: "inherit", shell: false, env: environment });
      child.once("error", reject);
      child.once("exit", (code, signal) => signal ? reject(new BridgeError(500, "claude_terminated", `Claude Code ended with signal ${signal}.`)) : resolve(code ?? 0));
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function standalonePolicy(noAuth: boolean, configuredToken: string | undefined): GuardPolicy {
  if (noAuth) return { mode: "open" };
  const token = configuredToken?.trim();
  if (token === undefined || token.length === 0) return { mode: "token", token: randomBytes(32).toString("base64url") };
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new BridgeError(400, "weak_gateway_token", `CODEX2CC_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters.`);
  }
  return { mode: "token", token };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const separator = argv.indexOf("--");
  const options = separator < 0 ? argv : argv.slice(0, separator);
  const claudeArgs = separator < 0 ? [] : argv.slice(separator + 1);

  const isListModels = options.includes("--list-models");
  const isServe = options.includes("--serve");
  const isMcp = options.includes("--mcp");
  const isNoAuth = options.includes("--no-auth");
  const isSkipPermissions = options.includes("--dangerously-skip-permissions") || options.includes("-y") || options.includes("--skip-permissions");
  const modelIndex = options.indexOf("--model");
  const portIndex = options.indexOf("--port");
  const permIndex = options.indexOf("--permission-mode");
  const printIndex = options.indexOf("-p");
  const continueFlag = options.includes("--continue") || options.includes("-c");

  if (isMcp) {
    const { runMcpServer } = await import("./mcp.js");
    await runMcpServer();
    return;
  }

  const session = await ChatGPTSession.open();
  const models = await session.listModels();

  if (isListModels) {
    for (const model of models) process.stdout.write(`${model.slug}\t${model.displayName}\n`);
    return;
  }

  const selectedModel = modelIndex >= 0 && options[modelIndex + 1] ? options[modelIndex + 1] : models[0]?.slug;
  if (!selectedModel || !models.some((m) => m.slug === selectedModel)) {
    throw new BridgeError(400, "model_unavailable", `Selected model "${selectedModel}" is not in the ChatGPT account model catalog.`);
  }

  if (isServe) {
    const port = portIndex >= 0 && options[portIndex + 1] ? parseInt(options[portIndex + 1]!, 10) : 3456;
    await serveStandalone(session, selectedModel, models, port, standalonePolicy(isNoAuth, process.env.CODEX2CC_TOKEN));
    return;
  }

  if (isSkipPermissions && !claudeArgs.includes("--dangerously-skip-permissions")) {
    claudeArgs.unshift("--dangerously-skip-permissions");
  }
  if (permIndex >= 0 && options[permIndex + 1] && !claudeArgs.includes("--permission-mode")) {
    claudeArgs.unshift("--permission-mode", options[permIndex + 1]!);
  }
  if (printIndex >= 0 && options[printIndex + 1] && !claudeArgs.includes("-p")) {
    claudeArgs.push("-p", options[printIndex + 1]!);
  }
  if (continueFlag && !claudeArgs.includes("--continue") && !claudeArgs.includes("-c")) {
    claudeArgs.push("--continue");
  }

  process.exitCode = await serveClaudeCli(session, selectedModel, models, claudeArgs);
}

main().catch((error: Error) => {
  const typed = error instanceof BridgeError ? error : new BridgeError(500, "startup_failed", error.message);
  process.stderr.write(`${JSON.stringify({ level: "error", operation: "startup", code: typed.code, message: typed.message })}\n`);
  process.exitCode = 1;
});
