import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { ServerResponse } from "node:http";
import { z } from "zod";
import { BridgeError, estimateTextTokens, type MessageRequest } from "./bridge.js";
import { recordLog } from "../telemetry/logger.js";
import { recordTokenUsage } from "../telemetry/usage.js";

export type AntigravityStreamEvent = {
  readonly event: string;
  readonly step_update?: {
    readonly step_index: number;
    readonly state: "ACTIVE" | "DONE" | "ERROR";
    readonly step_type: string;
    readonly text_delta?: string;
    readonly usage?: {
      readonly input_tokens: number;
      readonly output_tokens: number;
      readonly thinking_tokens: number;
      readonly cache_read_tokens?: number;
      readonly total_tokens: number;
    };
  };
  readonly result?: {
    readonly status: string;
    readonly response?: string;
    /** Tool invocations `agy` refused because headless mode cannot prompt for permission. */
    readonly denied_actions?: readonly object[];
    readonly usage?: {
      readonly input_tokens: number;
      readonly output_tokens: number;
      readonly thinking_tokens: number;
      readonly cache_read_tokens?: number;
      readonly total_tokens: number;
    };
  };
};

export type AntigravityRunOptions = {
  readonly model: string;
  readonly prompt: string;
  readonly effort?: string | undefined;
  readonly signal?: AbortSignal | undefined;
};

export type AntigravityRunner = (
  options: AntigravityRunOptions,
  onEvent: (event: AntigravityStreamEvent) => void,
) => Promise<void>;

const DEFAULT_AGY_TIMEOUT_MS = 120_000;
const DEFAULT_AGY_CONCURRENCY = 4;
const KILL_GRACE_MS = 3_000;
const STDERR_TAIL_BYTES = 4_096;
const MAX_DIAGNOSTIC_LINES = 20;
const AVAILABILITY_TTL_MS = 30_000;

/**
 * Gemini Flash model slugs encode effort in the slug itself (e.g. `-low`, `-medium`, `-high`).
 * Passing a separate `--effort` flag that conflicts with the embedded level causes `agy` to
 * reject the request. Returns `true` when the slug already carries its own effort level.
 */
const EMBEDDED_EFFORT_RE = /-(low|medium|high)$/;
export function modelHasEmbeddedEffort(slug: string): boolean {
  return EMBEDDED_EFFORT_RE.test(slug);
}

let availabilityCache: { readonly value: boolean; readonly checkedAt: number } | undefined;

/**
 * Resolves the agy CLI to run: CODEX2CC_AGY_BIN (a command name on PATH or an absolute path) when
 * set, otherwise `agy` looked up on PATH. Set it when the gateway's PATH cannot see agy.
 */
export function agyBinary(): string {
  return process.env.CODEX2CC_AGY_BIN?.trim() || "agy";
}

/**
 * Checks if the agy CLI (see agyBinary) is installed and executable. The probe spawns a
 * process synchronously, so the answer is cached briefly instead of blocking every status poll.
 */
export function isAntigravityAvailable(): boolean {
  const now = Date.now();
  if (availabilityCache !== undefined && now - availabilityCache.checkedAt < AVAILABILITY_TTL_MS) {
    return availabilityCache.value;
  }
  let value = false;
  try {
    value = spawnSync(agyBinary(), ["--help"], { stdio: "ignore" }).status === 0;
  } catch (error) {
    recordLog({
      level: "warn",
      operation: "antigravity_probe_failed",
      message: `Could not probe the agy CLI: ${(error as Error).message}`,
    });
  }
  availabilityCache = { value, checkedAt: now };
  return value;
}

const TOOL_PROTOCOL = [
  "[Tool Use Protocol]",
  "You are the model behind an external agent harness and you have NO native tools. Never use built-in",
  "tools, never read or modify files and never run commands yourself. The only tools you may use are the",
  "ones listed under [Available Tools]; the harness executes them for you.",
  "To call tools, end your reply with one or more blocks in exactly this form and then stop writing:",
  '<tool_call>{"name":"<tool name>","input":{<arguments matching the tool schema>}}</tool_call>',
  'The harness answers in a later message with <tool_result id="..."> blocks. When no tool is needed,',
  "answer normally without any <tool_call> block.",
].join("\n");

const TEXT_ONLY_PROTOCOL = [
  "[Execution Environment]",
  "You are answering through a text-only API. Do not use any built-in tools (files, shell, browser);",
  "reply directly in text.",
].join("\n");

function toolsOffered(request: MessageRequest): boolean {
  return (request.tools?.length ?? 0) > 0 && request.tool_choice?.type !== "none";
}

/**
 * Claude Code sends every connected MCP server tool as `mcp__<server>__<tool>`, and their schemas
 * can make up most of the prompt. agy is offered only the built-in tools, plus an MCP tool that
 * tool_choice forces, because dropping that one would make the forced call impossible.
 */
export function pruneToolsForAntigravity(request: MessageRequest): MessageRequest {
  const forced = request.tool_choice?.type === "tool" ? request.tool_choice.name : undefined;
  const tools = (request.tools ?? []).filter((tool) => !tool.name.startsWith("mcp__") || tool.name === forced);
  return { ...request, tools };
}

function toolChoiceInstruction(request: MessageRequest): string | undefined {
  const choice = request.tool_choice;
  if (choice?.type === "any") return "You must call at least one tool in this reply.";
  if (choice?.type === "tool") return `You must call the tool "${choice.name}" in this reply.`;
  return undefined;
}

/** Formats an Anthropic Messages request into the plain-text prompt sent to Antigravity. */
export function formatMessagesForAntigravity(request: MessageRequest): string {
  const parts: string[] = [];
  const withTools = toolsOffered(request);

  parts.push(withTools ? TOOL_PROTOCOL : TEXT_ONLY_PROTOCOL);

  if (request.system) {
    const sys = typeof request.system === "string"
      ? request.system
      : request.system.map((b) => b.text).join("\n");
    if (sys.trim().length > 0) {
      parts.push(`[System Instructions]\n${sys.trim()}`);
    }
  }

  if (withTools) {
    const toolList = (request.tools ?? [])
      .map((t) => {
        const desc = t.description ? `: ${t.description}` : "";
        const schema = t.input_schema ? ` | schema: ${JSON.stringify(t.input_schema)}` : "";
        return `- ${t.name}${desc}${schema}`;
      })
      .join("\n");
    parts.push(`[Available Tools]\n${toolList}`);
    const instruction = toolChoiceInstruction(request);
    if (instruction) parts.push(instruction);
  }

  for (const msg of request.messages) {
    const role = msg.role === "user" ? "Human" : msg.role === "assistant" ? "Assistant" : "System";
    let body = "";
    if (typeof msg.content === "string") {
      body = msg.content;
    } else if (Array.isArray(msg.content)) {
      body = (msg.content as readonly Record<string, unknown>[])
        .map((b): string => {
          if (b.type === "text" && typeof b.text === "string") return b.text;
          if (b.type === "image") return "[image omitted]";
          if (b.type === "tool_result") {
            const res = typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "");
            const errorAttr = b.is_error === true ? ' is_error="true"' : "";
            return `<tool_result id="${String(b.tool_use_id ?? "")}"${errorAttr}>${res}</tool_result>`;
          }
          if (b.type === "tool_use") {
            return `<tool_call id="${String(b.id ?? "")}">${JSON.stringify({ name: String(b.name ?? ""), input: b.input ?? {} })}</tool_call>`;
          }
          return "";
        })
        .filter((item: string): boolean => item.length > 0)
        .join("\n");
    }
    if (body.trim().length > 0) {
      parts.push(`${role}: ${body.trim()}`);
    }
  }

  if (withTools) {
    parts.push("[Protocol Directive: Output pure text or <tool_call> blocks only. Do NOT attempt to run native tools.]");
  }

  return parts.join("\n\n");
}

const ToolCallPayload = z.object({
  name: z.string().min(1),
  input: z.record(z.string(), z.json()).default({}),
});

export type AssistantBlock =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "tool_use"; readonly id: string; readonly name: string; readonly input: Readonly<Record<string, z.infer<ReturnType<typeof z.json>>>> };

export type ParsedAssistantOutput = {
  readonly blocks: readonly AssistantBlock[];
  /** Raw `<tool_call>` bodies that were not valid calls to an offered tool; they stay visible as text. */
  readonly rejected: readonly string[];
};

const TOOL_CALL_RE = /<tool_call(?:\s[^>]*)?>([\s\S]*?)<\/tool_call>/g;

function stripCodeFence(raw: string): string {
  return raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
}

/** Splits model output into text and `tool_use` blocks according to the `<tool_call>` protocol. */
export function parseAssistantOutput(
  text: string,
  toolNames: ReadonlySet<string>,
  newId: () => string,
): ParsedAssistantOutput {
  const blocks: AssistantBlock[] = [];
  const rejected: string[] = [];
  const pushText = (value: string): void => {
    if (value.trim().length === 0) return;
    const last = blocks.at(-1);
    if (last?.type === "text") {
      blocks[blocks.length - 1] = { type: "text", text: `${last.text}${value}` };
    } else {
      blocks.push({ type: "text", text: value.trim() });
    }
  };

  let cursor = 0;
  for (const match of text.matchAll(TOOL_CALL_RE)) {
    const start = match.index ?? 0;
    pushText(text.slice(cursor, start));
    cursor = start + match[0].length;
    let call: z.infer<typeof ToolCallPayload> | undefined;
    try {
      const parsed = ToolCallPayload.safeParse(JSON.parse(stripCodeFence(match[1] ?? "")));
      if (parsed.success && toolNames.has(parsed.data.name)) call = parsed.data;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    if (call === undefined) {
      rejected.push((match[1] ?? "").trim().slice(0, 200));
      pushText(match[0]);
    } else {
      blocks.push({ type: "tool_use", id: newId(), name: call.name, input: call.input });
    }
  }
  pushText(text.slice(cursor));
  if (blocks.length === 0) blocks.push({ type: "text", text: "" });
  return { blocks, rejected };
}

export function createLimiter(max: number): { acquire(signal?: AbortSignal | undefined): Promise<() => void> } {
  let active = 0;
  const waiters: Array<() => void> = [];
  return {
    acquire(signal?: AbortSignal | undefined): Promise<() => void> {
      return new Promise<() => void>((resolve, reject) => {
        if (signal?.aborted) {
          reject(new BridgeError(499, "client_disconnected", "Client disconnected before Antigravity started."));
          return;
        }
        const grant = (): void => {
          active++;
          let released = false;
          resolve(() => {
            if (released) return;
            released = true;
            active--;
            waiters.shift()?.();
          });
        };
        if (active < max) {
          grant();
          return;
        }
        const entry = (): void => {
          signal?.removeEventListener("abort", onAbort);
          grant();
        };
        const onAbort = (): void => {
          const index = waiters.indexOf(entry);
          if (index >= 0) waiters.splice(index, 1);
          reject(new BridgeError(499, "client_disconnected", "Client disconnected while waiting for an Antigravity slot."));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        waiters.push(entry);
      });
    },
  };
}

function positiveIntFromEnv(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const agyLimiter = createLimiter(positiveIntFromEnv(process.env.CODEX2CC_AGY_CONCURRENCY, DEFAULT_AGY_CONCURRENCY));

let sandboxDir: string | undefined;

/**
 * Empty throwaway working directory for `agy`, configured with strict tool denial so that
 * the model stays a pure text engine instead of attempting autonomous agent actions.
 */
function agySandboxDir(): string {
  if (sandboxDir === undefined) {
    const created = mkdtempSync(join(tmpdir(), "codex2cc-agy-"));
    sandboxDir = created;
    const geminiDir = join(created, ".gemini");
    mkdirSync(geminiDir, { recursive: true });
    writeFileSync(
      join(geminiDir, "settings.json"),
      JSON.stringify({
        toolPermission: "deny",
        permissions: {
          deny: ["*"],
        },
      }),
      "utf8",
    );
    process.once("exit", () => rmSync(created, { recursive: true, force: true }));
  }
  return sandboxDir;
}

function spawnAgy(options: AntigravityRunOptions, onEvent: (event: AntigravityStreamEvent) => void): Promise<void> {
  const timeoutMs = positiveIntFromEnv(process.env.CODEX2CC_AGY_TIMEOUT_MS, DEFAULT_AGY_TIMEOUT_MS);
  // No --dangerously-skip-permissions: in headless mode agy auto-denies tool use, which keeps the
  // model a pure text engine; tool calls are brokered through the <tool_call> protocol instead.
  const args = [
    "--model",
    options.model,
    "--input-format",
    "text",
    "--output-format",
    "stream-json",
    "--disable-slash-commands",
  ];
  if (options.effort && !modelHasEmbeddedEffort(options.model)) {
    args.push("--effort", options.effort);
  }

  return new Promise<void>((resolve, reject) => {
    const child = spawn(agyBinary(), args, { stdio: ["pipe", "pipe", "pipe"], cwd: agySandboxDir() });
    let stderrTail = "";
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    const diagnostics: string[] = [];

    const terminate = (): void => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
    };
    const onAbort = (): void => terminate();
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      // EPIPE means agy exited before reading the prompt; the exit handler reports the real cause.
      if (error.code !== "EPIPE") diagnostics.push(`stdin: ${error.message}`);
    });
    child.stdin.end(options.prompt);

    createInterface({ input: child.stdout }).on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        onEvent(JSON.parse(trimmed) as AntigravityStreamEvent);
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        if (diagnostics.length < MAX_DIAGNOSTIC_LINES) diagnostics.push(trimmed.slice(0, 200));
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrTail = `${stderrTail}${chunk.toString("utf8")}`.slice(-STDERR_TAIL_BYTES);
    });

    const settle = (outcome: () => void): void => {
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", onAbort);
      outcome();
    };

    child.once("error", (err) => {
      settle(() => reject(new BridgeError(502, "antigravity_spawn_failed", `Failed to run agy CLI: ${err.message}`)));
    });
    // "close" (not "exit") guarantees stdout was fully drained, so no trailing event is lost.
    child.once("close", (code, signal) => {
      settle(() => {
        if (options.signal?.aborted) {
          reject(new BridgeError(499, "client_disconnected", "Client disconnected; agy was stopped."));
        } else if (timedOut) {
          reject(new BridgeError(504, "antigravity_timeout", `agy did not finish within ${timeoutMs}ms and was stopped.`));
        } else if (signal) {
          reject(new BridgeError(500, "antigravity_aborted", `agy was terminated by signal ${signal}`));
        } else if (code !== 0) {
          const detail = stderrTail.trim() || diagnostics.join(" | ") || "no output";
          reject(new BridgeError(502, "antigravity_error", `agy failed (exit code ${code}): ${detail.slice(-500)}`));
        } else {
          resolve();
        }
      });
    });
  });
}

/** Default production runner: runs the local `agy` CLI in non-interactive stream-json mode. */
export const defaultAntigravityRunner: AntigravityRunner = async (
  options: AntigravityRunOptions,
  onEvent: (event: AntigravityStreamEvent) => void,
): Promise<void> => {
  const release = await agyLimiter.acquire(options.signal);
  try {
    await spawnAgy(options, onEvent);
  } finally {
    release();
  }
};

export type AntigravityHandlerOptions = {
  readonly model: string;
  readonly runner?: AntigravityRunner | undefined;
  readonly effort?: string | undefined;
};

type UsageTotals = { inputTokens: number; outputTokens: number; cachedTokens: number; reported: boolean };

function newMessageId(): string {
  return `msg_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

function newToolUseId(): string {
  return `toolu_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

function emitEvent(response: ServerResponse, eventType: string, data: object): void {
  response.write(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`);
}

function writeSseHead(response: ServerResponse): void {
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
}

function emitMessageStart(response: ServerResponse, msgId: string, model: string, inputTokens: number): void {
  emitEvent(response, "message_start", {
    type: "message_start",
    message: {
      id: msgId,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: 1 },
    },
  });
}

function emitMessageEnd(response: ServerResponse, stopReason: "end_turn" | "tool_use", outputTokens: number): void {
  emitEvent(response, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: outputTokens },
  });
  emitEvent(response, "message_stop", { type: "message_stop" });
  response.end();
}

function emitBlock(response: ServerResponse, index: number, block: AssistantBlock): void {
  if (block.type === "text") {
    emitEvent(response, "content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
    emitEvent(response, "content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
  } else {
    emitEvent(response, "content_block_start", {
      type: "content_block_start",
      index,
      content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
    });
    emitEvent(response, "content_block_delta", {
      type: "content_block_delta",
      index,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
    });
  }
  emitEvent(response, "content_block_stop", { type: "content_block_stop", index });
}

/**
 * Handles incoming Anthropic Messages requests using the Google Antigravity `agy` provider.
 * Translates NDJSON `step_update` events into Anthropic SSE streaming events or a standard JSON
 * message. Without tools the text is streamed live; with tools the reply is buffered so
 * `<tool_call>` blocks can be converted into Anthropic `tool_use` blocks.
 */
export async function handleAntigravityMessage(
  options: AntigravityHandlerOptions,
  clientRequest: MessageRequest,
  response: ServerResponse,
  clientGone: AbortSignal,
): Promise<void> {
  const startTime = Date.now();
  const activeModel = options.model;
  const inbound = pruneToolsForAntigravity(clientRequest);
  const toolsDropped = (clientRequest.tools?.length ?? 0) - (inbound.tools?.length ?? 0);
  const prompt = formatMessagesForAntigravity(inbound);
  const requestedEffort = inbound.output_config?.effort ?? inbound.reasoning_effort ?? options.effort;
  const runner = options.runner ?? defaultAntigravityRunner;
  const withTools = toolsOffered(inbound);
  const stream = Boolean(inbound.stream);
  const liveStream = stream && !withTools;

  recordLog({
    level: "info",
    operation: "antigravity_request",
    message: `Forwarding request to Google Antigravity (model: "${activeModel}", stream: ${stream}, tools: ${withTools}, effort: ${requestedEffort ?? "default"})`,
    details: { provider: "antigravity", model: activeModel, stream, tools: withTools, toolsDropped, effort: requestedEffort ?? "default" },
  });

  const msgId = newMessageId();
  // Count the gateway-authored prompt, including protocol text; agy's hidden context remains unknown.
  const estimatedInput = estimateTextTokens(prompt);
  const usage: UsageTotals = { inputTokens: estimatedInput, outputTokens: 0, cachedTokens: 0, reported: false };
  let text = "";
  let resultResponse = "";
  let resultStatus = "";
  let deniedActions = 0;
  let liveStarted = false;

  const startLive = (): void => {
    if (liveStarted) return;
    liveStarted = true;
    writeSseHead(response);
    emitMessageStart(response, msgId, activeModel, usage.inputTokens);
    emitEvent(response, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  };

  const applyUsage = (reported: NonNullable<NonNullable<AntigravityStreamEvent["result"]>["usage"]>): void => {
    usage.inputTokens = reported.input_tokens;
    usage.outputTokens = reported.output_tokens;
    usage.cachedTokens = reported.cache_read_tokens ?? 0;
    usage.reported = true;
  };

  let keepAliveTimer: NodeJS.Timeout | undefined;
  if (stream && !liveStream) {
    writeSseHead(response);
    keepAliveTimer = setInterval(() => {
      if (!response.writableEnded) {
        response.write(": keep-alive\n\n");
      }
    }, 5_000);
  }

  try {
    await runner(
      { model: activeModel, prompt, effort: requestedEffort, signal: clientGone },
      (ev) => {
        const delta = ev.step_update?.text_delta;
        if (delta) {
          text += delta;
          if (liveStream) {
            startLive();
            emitEvent(response, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: delta } });
          }
        }
        if (ev.step_update?.usage) applyUsage(ev.step_update.usage);
        if (ev.result) {
          resultStatus = ev.result.status;
          resultResponse = ev.result.response ?? "";
          deniedActions = ev.result.denied_actions?.length ?? 0;
          if (ev.result.usage) applyUsage(ev.result.usage);
        }
      },
    );
  } finally {
    if (keepAliveTimer) clearInterval(keepAliveTimer);
  }

  if (text.length === 0 && resultResponse.length > 0) {
    text = resultResponse;
    if (liveStream) {
      startLive();
      emitEvent(response, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
    }
  }
  if (text.trim().length === 0) {
    if (deniedActions > 0) {
      throw new BridgeError(502, "antigravity_tool_denied", `agy tried to use ${deniedActions} native tool(s) that headless mode denied, and returned no text.`);
    }
    if (resultStatus !== "" && resultStatus !== "SUCCESS") {
      throw new BridgeError(502, "antigravity_failed", `agy finished with status "${resultStatus}" and returned no text.`);
    }
  } else if (deniedActions > 0) {
    recordLog({
      level: "warn",
      operation: "antigravity_tool_denied",
      message: `agy attempted ${deniedActions} native tool call(s) that were auto-denied`,
      details: { provider: "antigravity", model: activeModel, denied: deniedActions },
    });
  }
  if (!usage.reported) usage.outputTokens = estimateTextTokens(text);

  const toolNames: ReadonlySet<string> = new Set((inbound.tools ?? []).map((tool) => tool.name));
  const parsed = withTools
    ? parseAssistantOutput(text, toolNames, newToolUseId)
    : { blocks: [{ type: "text", text }] as readonly AssistantBlock[], rejected: [] as readonly string[] };
  if (parsed.rejected.length > 0) {
    recordLog({
      level: "warn",
      operation: "antigravity_invalid_tool_call",
      message: `Model emitted ${parsed.rejected.length} malformed or unknown <tool_call> block(s); kept as plain text`,
      details: { provider: "antigravity", model: activeModel, sample: parsed.rejected[0] ?? "" },
    });
  }
  const stopReason = parsed.blocks.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn";

  if (liveStream) {
    startLive();
    emitEvent(response, "content_block_stop", { type: "content_block_stop", index: 0 });
    emitMessageEnd(response, stopReason, usage.outputTokens);
  } else if (stream) {
    if (!response.headersSent) writeSseHead(response);
    emitMessageStart(response, msgId, activeModel, usage.inputTokens);
    parsed.blocks.forEach((block, index) => emitBlock(response, index, block));
    emitMessageEnd(response, stopReason, usage.outputTokens);
  } else {
    const msg = {
      id: msgId,
      type: "message",
      role: "assistant",
      model: activeModel,
      content: parsed.blocks,
      stop_reason: stopReason,
      stop_sequence: null,
      usage: { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens },
    };
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(msg));
  }

  recordTokenUsage({
    model: activeModel,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedTokens: usage.cachedTokens,
  });
  recordLog({
    level: "info",
    operation: stream ? "antigravity_stream_complete" : "antigravity_message_complete",
    message: `Antigravity ${stream ? "stream" : "message"} completed for model "${activeModel}" in ${Date.now() - startTime}ms`,
    details: {
      provider: "antigravity",
      model: activeModel,
      durationMs: Date.now() - startTime,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cachedTokens: usage.cachedTokens,
      totalTokens: usage.inputTokens + usage.outputTokens + usage.cachedTokens,
      usageReported: usage.reported,
      stopReason,
    },
  });
}
