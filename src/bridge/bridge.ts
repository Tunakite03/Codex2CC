import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import { z } from "zod";

const JsonValue = z.json();
const TextBlock = z.object({ type: z.literal("text"), text: z.string() }).loose();
const ImageBlock = z.object({
  type: z.literal("image"),
  source: z.discriminatedUnion("type", [
    z.object({ type: z.literal("base64"), media_type: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]), data: z.string() }),
    z.object({ type: z.literal("url"), url: z.string().min(1) }),
  ]),
}).loose();
const ToolUseBlock = z.object({ type: z.literal("tool_use"), id: z.string().min(1), name: z.string().min(1), input: JsonValue }).loose();
const KNOWN_BLOCK_TYPES: readonly string[] = ["text", "image", "tool_use", "tool_result", "thinking", "redacted_thinking"];
// Block types Claude Code may send that the Responses API cannot take (document, server_tool_use, ...).
// They pass validation and are replaced by a visible note instead of failing the whole request.
const UnknownBlock = z.object({ type: z.string().refine((type) => !KNOWN_BLOCK_TYPES.includes(type)) }).loose();
const ToolResultBlock = z.object({
  type: z.literal("tool_result"), tool_use_id: z.string().min(1),
  content: z.union([z.string(), z.array(z.union([TextBlock, ImageBlock, UnknownBlock]))]).optional(),
  is_error: z.boolean().optional(),
}).loose();
const ThinkingBlock = z.object({
  type: z.enum(["thinking", "redacted_thinking"]),
  thinking: z.string().optional(),
  signature: z.string().optional(),
  data: z.string().optional(),
}).loose();
const Block = z.discriminatedUnion("type", [TextBlock, ImageBlock, ToolUseBlock, ToolResultBlock, ThinkingBlock]);
type KnownBlock = z.infer<typeof Block>;
const Message = z.object({ role: z.enum(["user", "assistant", "system", "developer"]), content: z.union([z.string(), z.array(z.union([Block, UnknownBlock]))]) }).loose();
// Server-side tools (for example web_search) have no input_schema and cannot be offered as function tools.
const Tool = z.object({ name: z.string().min(1), description: z.string().default(""), input_schema: JsonValue.optional() }).loose();
const ParallelToolUse = { disable_parallel_tool_use: z.boolean().optional() };
const ToolChoice = z.discriminatedUnion("type", [
  z.object({ type: z.literal("auto"), ...ParallelToolUse }).loose(),
  z.object({ type: z.literal("any"), ...ParallelToolUse }).loose(),
  z.object({ type: z.literal("none") }).loose(),
  z.object({ type: z.literal("tool"), name: z.string().min(1), ...ParallelToolUse }).loose(),
]);
const Effort = z.enum(["low", "medium", "high", "xhigh", "max"]);
export const MessageRequest = z.object({
  model: z.string().min(1),
  max_tokens: z.number().int().positive().optional().default(4096),
  messages: z.array(Message).min(1),
  system: z.union([z.string(), z.array(TextBlock)]).optional(),
  tools: z.array(Tool).optional(),
  tool_choice: ToolChoice.optional(),
  output_config: z.object({ effort: Effort.optional() }).optional(),
  reasoning_effort: Effort.optional(),
  thinking: z.object({ type: z.string() }).loose().optional(),
  stream: z.boolean().default(false),
}).loose();
export type MessageRequest = z.infer<typeof MessageRequest>;

export class BridgeError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly retryAfterSeconds?: number) {
    super(message);
    this.name = "BridgeError";
  }
}

type InputText = { type: "input_text"; text: string };
type InputImage = { type: "input_image"; image_url: string };
type OutputText = { type: "output_text"; text: string };
type Refusal = { type: "refusal"; refusal: string };
type SummaryText = { type: "summary_text"; text: string };
export type ReasoningItem = { type: "reasoning"; summary: SummaryText[]; encrypted_content: string };
type InputItem =
  | { role: "user" | "developer"; content: string | Array<InputText | InputImage> }
  | { role: "assistant"; content: Array<OutputText | Refusal> }
  | ReasoningItem
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string | Array<InputText | InputImage> };
export type FunctionTool = { type: "function"; name: string; description: string; parameters: z.infer<typeof JsonValue> };
export type EffortLevel = z.infer<typeof Effort>;
export type OpenAIRequest = {
  model: string;
  input: InputItem[];
  instructions?: string;
  tools?: FunctionTool[];
  tool_choice?: "none" | "auto" | "required" | { type: "function"; name: string };
  parallel_tool_calls?: boolean;
  store: false;
  stream: true;
  include: ["reasoning.encrypted_content"];
  reasoning?: { effort?: EffortLevel; summary?: "auto" };
  prompt_cache_key?: string;
};

/**
 * Codex reasoning travels through Claude Code as the signature of a thinking block. The prefix marks
 * signatures this gateway issued (a conversation may also hold real Anthropic signatures), and the
 * model slug keeps encrypted reasoning from being replayed to a model that cannot decrypt it.
 */
const REASONING_SIGNATURE_PREFIX = "codex2cc.reasoning.v1:";

export function encodeReasoningSignature(model: string, encryptedContent: string): string {
  return `${REASONING_SIGNATURE_PREFIX}${model}:${encryptedContent}`;
}

/** The encrypted reasoning carried by `signature` when this gateway issued it for `model`. */
export function decodeReasoningSignature(signature: string | undefined, model: string): string | undefined {
  if (signature === undefined || !signature.startsWith(REASONING_SIGNATURE_PREFIX)) return undefined;
  const rest = signature.slice(REASONING_SIGNATURE_PREFIX.length);
  const separator = rest.indexOf(":");
  if (separator < 0 || rest.slice(0, separator) !== model) return undefined;
  const encrypted = rest.slice(separator + 1);
  return encrypted.length > 0 ? encrypted : undefined;
}

function reasoningItem(block: z.infer<typeof ThinkingBlock>, model: string): ReasoningItem | undefined {
  const encrypted = decodeReasoningSignature(block.type === "thinking" ? block.signature : block.data, model);
  if (encrypted === undefined) return undefined;
  const summary: SummaryText[] = block.type === "thinking" && block.thinking ? [{ type: "summary_text", text: block.thinking }] : [];
  return { type: "reasoning", summary, encrypted_content: encrypted };
}

/** Removes replayed reasoning, for an upstream that rejected its encrypted content. */
export function withoutReasoningItems(request: OpenAIRequest): OpenAIRequest {
  return { ...request, input: request.input.filter((item) => !("type" in item && item.type === "reasoning")) };
}

export function hasReasoningItems(request: OpenAIRequest): boolean {
  return request.input.some((item) => "type" in item && item.type === "reasoning");
}

function imageContent(block: z.infer<typeof ImageBlock>): InputImage {
  const { source } = block;
  return { type: "input_image", image_url: source.type === "url" ? source.url : `data:${source.media_type};base64,${source.data}` };
}

function isKnownBlock(block: { type: string }): block is KnownBlock {
  return KNOWN_BLOCK_TYPES.includes(block.type);
}

function isTextBlock(block: { type: string }): block is z.infer<typeof TextBlock> {
  return block.type === "text";
}

function isImageBlock(block: { type: string }): block is z.infer<typeof ImageBlock> {
  return block.type === "image";
}

function unsupportedText(type: string): string {
  return `[Unsupported content block "${type}" omitted by Codex2CC]`;
}

function toolOutput(content: z.infer<typeof ToolResultBlock>["content"], isError: boolean): string | Array<InputText | InputImage> {
  if (content === undefined) return isError ? "Tool error." : "";
  if (typeof content === "string") return isError ? `Tool error: ${content}` : content;
  const parts = content.map((block): InputText | InputImage => {
    if (isTextBlock(block)) return { type: "input_text", text: block.text };
    if (isImageBlock(block)) return imageContent(block);
    return { type: "input_text", text: unsupportedText(block.type) };
  });
  return isError ? [{ type: "input_text", text: "Tool error:" }, ...parts] : parts;
}

export function toOpenAIRequest(request: MessageRequest, model: string): OpenAIRequest {
  const tools = request.tools ?? [];
  const input: InputItem[] = [];
  for (const message of request.messages) {
    const role = message.role === "system" ? "developer" : message.role;
    if (typeof message.content === "string") {
      if (role === "assistant") {
        input.push({ role: "assistant", content: [{ type: "output_text", text: message.content }] });
      } else {
        input.push({ role, content: message.content });
      }
      continue;
    }
    if (role === "assistant") {
      let pending: OutputText[] = [];
      const flush = (): void => {
        if (pending.length > 0) input.push({ role: "assistant", content: pending });
        pending = [];
      };
      for (const block of message.content) {
        if (!isKnownBlock(block)) {
          pending.push({ type: "output_text", text: unsupportedText(block.type) });
          continue;
        }
        if (block.type === "text") {
          pending.push({ type: "output_text", text: block.text });
        } else if (block.type === "image") {
          throw new BridgeError(400, "unsupported_image", "Assistant image history is unsupported.");
        } else if (block.type === "tool_use") {
          flush();
          input.push({
            type: "function_call",
            call_id: block.id,
            name: block.name,
            arguments: typeof block.input === "string" ? block.input : JSON.stringify(block.input),
          });
        } else if (block.type === "tool_result") {
          throw new BridgeError(400, "invalid_tool_role", "tool_result requires user role.");
        } else if (block.type === "thinking" || block.type === "redacted_thinking") {
          const reasoning = reasoningItem(block, model);
          if (reasoning !== undefined) {
            flush();
            input.push(reasoning);
          }
        }
      }
      flush();
    } else {
      let pending: Array<InputText | InputImage> = [];
      const flush = (): void => {
        if (pending.length > 0) input.push({ role, content: pending });
        pending = [];
      };
      for (const block of message.content) {
        if (!isKnownBlock(block)) {
          pending.push({ type: "input_text", text: unsupportedText(block.type) });
          continue;
        }
        if (block.type === "text") {
          pending.push({ type: "input_text", text: block.text });
        } else if (block.type === "image") {
          if (role !== "user") throw new BridgeError(400, "unsupported_image", "Assistant image history is unsupported.");
          pending.push(imageContent(block));
        } else if (block.type === "tool_use") {
          throw new BridgeError(400, "invalid_tool_role", "tool_use requires assistant role.");
        } else if (block.type === "tool_result") {
          if (role !== "user") throw new BridgeError(400, "invalid_tool_role", "tool_result requires user role.");
          flush();
          input.push({
            type: "function_call_output",
            call_id: block.tool_use_id,
            output: toolOutput(block.content, block.is_error ?? false),
          });
        }
      }
      flush();
    }
  }
  const instructions = typeof request.system === "string"
    ? request.system
    : request.system?.map((block) => block.text).join("\n\n");
  const result: OpenAIRequest = { model, input, store: false, stream: true, include: ["reasoning.encrypted_content"] };
  if (instructions) result.instructions = instructions;
  const functionTools = tools.flatMap((tool): FunctionTool[] => tool.input_schema === undefined
    ? []
    : [{ type: "function", name: tool.name, description: tool.description, parameters: tool.input_schema }]);
  if (functionTools.length > 0) result.tools = functionTools;
  const choice = request.tool_choice;
  if (choice?.type === "none") result.tool_choice = "none";
  else if (choice?.type === "any") result.tool_choice = "required";
  else if (choice?.type === "auto") result.tool_choice = "auto";
  else if (choice?.type === "tool") result.tool_choice = { type: "function", name: choice.name };
  if (functionTools.length > 0 && choice?.type !== "none") {
    result.parallel_tool_calls = choice?.disable_parallel_tool_use !== true;
  }

  const effort = request.output_config?.effort ?? request.reasoning_effort;
  const summarize = request.thinking?.type !== "disabled";
  if (effort || summarize) {
    result.reasoning = { ...(effort ? { effort } : {}), ...(summarize ? { summary: "auto" as const } : {}) };
  }

  return result;
}

/** Content block types in the request that the Responses API cannot represent. */
export function unsupportedBlockTypes(request: MessageRequest): string[] {
  const found = new Set<string>();
  for (const message of request.messages) {
    if (typeof message.content === "string") continue;
    for (const block of message.content) {
      if (!isKnownBlock(block)) {
        found.add(block.type);
      } else if (block.type === "tool_result" && Array.isArray(block.content)) {
        for (const inner of block.content) {
          if (!isTextBlock(inner) && !isImageBlock(inner)) found.add(inner.type);
        }
      }
    }
  }
  return [...found];
}

/** Names of tools that cannot be offered upstream because they have no input_schema. */
export function unsupportedToolNames(request: MessageRequest): string[] {
  return (request.tools ?? []).filter((tool) => tool.input_schema === undefined).map((tool) => tool.name);
}

const IMAGE_TOKEN_ESTIMATE = 1_500;
// Approximate framing allowances, not model-specific tokenizer constants.
const ITEM_TOKEN_OVERHEAD = 4;
const TOOL_TOKEN_OVERHEAD = 8;

/** Local heuristic only; neither a tokenizer count nor an upper bound on model usage. */
export function estimateTextTokens(text: string): number {
  let tokens = 0;
  for (const character of text) {
    tokens += character.charCodeAt(0) < 128 ? 0.25 : Buffer.byteLength(character, "utf8") / 2;
  }
  return Math.ceil(tokens);
}

function estimateContentTokens(content: string | readonly (InputText | InputImage | OutputText | Refusal)[]): number {
  if (typeof content === "string") return estimateTextTokens(content);
  return content.reduce((total, block) => {
    if (block.type === "input_image") return total + IMAGE_TOKEN_ESTIMATE;
    return total + estimateTextTokens(block.type === "refusal" ? block.refusal : block.text);
  }, 0);
}

/**
 * Estimates the converted Codex payload, excluding transport fields and encoded image bytes.
 * Image cost and framing remain heuristic; encrypted reasoning's hidden token cost is unknown.
 * Count only its visible summary rather than treating ciphertext as prompt text.
 */
export function estimateCodexInputTokens(request: OpenAIRequest): number {
  let tokens = request.instructions === undefined ? 0 : ITEM_TOKEN_OVERHEAD + estimateTextTokens(request.instructions);
  for (const tool of request.tools ?? []) {
    tokens += TOOL_TOKEN_OVERHEAD + estimateTextTokens(tool.name) + estimateTextTokens(tool.description)
      + estimateTextTokens(JSON.stringify(tool.parameters));
  }
  for (const item of request.input) {
    tokens += ITEM_TOKEN_OVERHEAD;
    if ("role" in item) {
      tokens += estimateContentTokens(item.content);
    } else if (item.type === "function_call") {
      tokens += estimateTextTokens(item.call_id) + estimateTextTokens(item.name) + estimateTextTokens(item.arguments);
    } else if (item.type === "function_call_output") {
      tokens += estimateTextTokens(item.call_id) + estimateContentTokens(item.output);
    } else {
      tokens += item.summary.reduce((total, part) => total + estimateTextTokens(part.text), 0);
    }
  }
  if (typeof request.tool_choice === "object") {
    tokens += ITEM_TOKEN_OVERHEAD + estimateTextTokens(request.tool_choice.name);
  }
  return tokens;
}

export type OpenAIUsage = { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } };
export type AnthropicUsage = { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number };

/** OpenAI counts cached tokens inside input_tokens; Anthropic reports them separately. */
export function toAnthropicUsage(usage: OpenAIUsage | undefined): AnthropicUsage {
  const total = usage?.input_tokens ?? 0;
  const cached = Math.min(usage?.input_tokens_details?.cached_tokens ?? 0, total);
  const result: AnthropicUsage = { input_tokens: total - cached, output_tokens: usage?.output_tokens ?? 0 };
  if (cached > 0) result.cache_read_input_tokens = cached;
  return result;
}

export type OpenAIEvent = {
  type: string;
  response?: {
    id?: string;
    usage?: OpenAIUsage;
    error?: { code?: string; message?: string };
    incomplete_details?: { reason?: string };
    output?: Array<{
      type?: string;
      content?: Array<{ type?: string; text?: string; refusal?: string }>;
      call_id?: string;
      name?: string;
      arguments?: string;
    }>;
  };
  output_index?: number;
  summary_index?: number;
  item?: {
    type?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
    summary?: Array<{ type?: string; text?: string }>;
    encrypted_content?: string;
    /** Opaque provider-scoped reasoning state supplied by another protocol adapter. */
    signature?: string;
  };
  delta?: string;
  arguments?: string;
  text?: string;
  /** Top-level fields of a bare `error` event. */
  code?: string;
  message?: string;
};

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "refusal";

const RATE_LIMIT_CODES: readonly string[] = ["rate_limit_exceeded", "usage_limit_reached", "insufficient_quota"];

/** Maps a `response.failed` or `error` event to the status Claude Code acts on. */
export function upstreamFailure(event: OpenAIEvent): BridgeError {
  const code = event.response?.error?.code ?? event.code;
  const message = event.response?.error?.message ?? event.message ?? "OpenAI did not complete the response.";
  if (code === "context_length_exceeded") return new BridgeError(400, code, message);
  if (code !== undefined && RATE_LIMIT_CODES.includes(code)) return new BridgeError(429, code, message);
  return new BridgeError(502, code ?? "upstream_failed", message);
}

/** The Anthropic stop reason for a `response.incomplete` event; reasons with no Anthropic equivalent fail. */
function incompleteStopReason(event: OpenAIEvent): StopReason {
  const reason = event.response?.incomplete_details?.reason;
  if (reason === "max_output_tokens") return "max_tokens";
  if (reason === "content_filter") return "refusal";
  throw new BridgeError(502, "upstream_incomplete", `OpenAI ended the response as incomplete (${reason ?? "no reason given"}).`);
}

function summaryText(item: OpenAIEvent["item"]): string {
  return (item?.summary ?? []).map((part) => part.text ?? "").filter((text) => text.length > 0).join("\n\n");
}

function isFailure(event: OpenAIEvent): boolean {
  return event.type === "response.failed" || event.type === "error";
}

/** Responses events normally carry output_index; without one the oldest open call is meant. */
function resolveOutputIndex(event: OpenAIEvent, open: ReadonlyMap<number, unknown>): number {
  return event.output_index ?? open.keys().next().value ?? 0;
}

function writeEvent(response: ServerResponse, event: string, data: object): void {
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * Translates Responses stream events into Anthropic SSE. `message_start` is held back until the first
 * content, so an upstream failure that arrives first can still be answered with a real HTTP status.
 */
export class AnthropicStream {
  private messageId: string | undefined;
  private started = false;
  private stopped = false;
  private nextBlock = 0;
  private textBlock: number | undefined;
  private textOutput = "";
  private thinkingBlock: { readonly index: number; summaryIndex: number } | undefined;
  private readonly functionBlocks = new Map<number, number>();
  private readonly functionArguments = new Map<number, string>();
  private usedTool = false;
  private finalUsage: AnthropicUsage | undefined;

  constructor(
    private readonly response: ServerResponse,
    private readonly model: string,
    private readonly estimatedInputTokens: number = 0,
  ) {}

  private start(): void {
    if (this.started) return;
    this.started = true;
    writeEvent(this.response, "message_start", {
      type: "message_start",
      message: {
        id: this.messageId ?? `resp_${randomUUID()}`,
        type: "message",
        role: "assistant",
        model: this.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: this.estimatedInputTokens, output_tokens: 0 },
      },
    });
  }

  private closeText(): void {
    if (this.textBlock === undefined) return;
    writeEvent(this.response, "content_block_stop", { type: "content_block_stop", index: this.textBlock });
    this.textBlock = undefined;
    this.textOutput = "";
  }

  private closeThinking(signature: string | undefined): void {
    if (this.thinkingBlock === undefined) return;
    const { index } = this.thinkingBlock;
    if (signature !== undefined) {
      writeEvent(this.response, "content_block_delta", { type: "content_block_delta", index, delta: { type: "signature_delta", signature } });
    }
    writeEvent(this.response, "content_block_stop", { type: "content_block_stop", index });
    this.thinkingBlock = undefined;
  }

  private thinkingDelta(event: OpenAIEvent): void {
    if (typeof event.delta !== "string" || event.delta.length === 0) return;
    this.start();
    this.closeText();
    const summaryIndex = event.summary_index ?? 0;
    if (this.thinkingBlock === undefined) {
      const index = this.nextBlock++;
      this.thinkingBlock = { index, summaryIndex };
      writeEvent(this.response, "content_block_start", { type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } });
    } else if (summaryIndex !== this.thinkingBlock.summaryIndex) {
      this.thinkingBlock.summaryIndex = summaryIndex;
      writeEvent(this.response, "content_block_delta", { type: "content_block_delta", index: this.thinkingBlock.index, delta: { type: "thinking_delta", thinking: "\n\n" } });
    }
    writeEvent(this.response, "content_block_delta", { type: "content_block_delta", index: this.thinkingBlock.index, delta: { type: "thinking_delta", thinking: event.delta } });
  }

  /** Ends the reasoning item; its encrypted content becomes the signature Claude Code sends back. */
  private reasoningDone(item: OpenAIEvent["item"]): void {
    const signature = item?.signature ?? (item?.encrypted_content ? encodeReasoningSignature(this.model, item.encrypted_content) : undefined);
    if (this.thinkingBlock !== undefined) {
      this.closeThinking(signature);
      return;
    }
    if (!signature) return;
    this.start();
    this.closeText();
    const index = this.nextBlock++;
    writeEvent(this.response, "content_block_start", { type: "content_block_start", index, content_block: { type: "redacted_thinking", data: signature } });
    writeEvent(this.response, "content_block_stop", { type: "content_block_stop", index });
  }

  private finish(event: OpenAIEvent, stopReason: StopReason): void {
    this.start();
    this.closeThinking(undefined);
    this.closeText();
    for (const [outputIndex, index] of this.functionBlocks.entries()) {
      writeEvent(this.response, "content_block_stop", { type: "content_block_stop", index });
      this.functionBlocks.delete(outputIndex);
    }
    if (this.nextBlock === 0) {
      const index = this.nextBlock++;
      writeEvent(this.response, "content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
      writeEvent(this.response, "content_block_stop", { type: "content_block_stop", index });
    }
    const usage = toAnthropicUsage(event.response?.usage);
    this.finalUsage = usage;
    writeEvent(this.response, "message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage,
    });
    writeEvent(this.response, "message_stop", { type: "message_stop" });
    this.stopped = true;
  }

  accept(event: OpenAIEvent): void {
    if (this.stopped) return;
    if (event.type === "response.created") {
      this.messageId ??= event.response?.id;
    } else if (event.type === "response.reasoning_summary_text.delta") {
      this.thinkingDelta(event);
    } else if (event.type === "response.output_item.done" && event.item?.type === "reasoning") {
      this.reasoningDone(event.item);
    } else if (event.type === "response.output_text.delta" || event.type === "response.refusal.delta") {
      if (typeof event.delta === "string" && event.delta.length > 0) {
        this.start();
        this.closeThinking(undefined);
        if (this.textBlock === undefined) {
          const index = this.nextBlock++;
          this.textBlock = index;
          writeEvent(this.response, "content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
        }
        this.textOutput += event.delta;
        writeEvent(this.response, "content_block_delta", { type: "content_block_delta", index: this.textBlock, delta: { type: "text_delta", text: event.delta } });
      }
    } else if (event.type === "response.output_text.done" || event.type === "response.refusal.done") {
      this.closeText();
    } else if (event.type === "response.output_item.added" && event.item?.type === "function_call") {
      this.start();
      this.closeThinking(undefined);
      this.closeText();
      const outputIndex = event.output_index ?? this.functionBlocks.size;
      const callId = event.item.call_id ?? `call_${randomUUID()}`;
      const name = event.item.name ?? "tool";
      const index = this.nextBlock++;
      this.usedTool = true;
      this.functionBlocks.set(outputIndex, index);
      this.functionArguments.set(outputIndex, "");
      writeEvent(this.response, "content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "tool_use", id: callId, name, input: {} },
      });
    } else if (event.type === "response.function_call_arguments.delta") {
      const outputIndex = resolveOutputIndex(event, this.functionBlocks);
      const index = this.functionBlocks.get(outputIndex);
      if (index !== undefined && typeof event.delta === "string") {
        this.functionArguments.set(outputIndex, (this.functionArguments.get(outputIndex) ?? "") + event.delta);
        writeEvent(this.response, "content_block_delta", {
          type: "content_block_delta",
          index,
          delta: { type: "input_json_delta", partial_json: event.delta },
        });
      }
    } else if (event.type === "response.function_call_arguments.done") {
      const outputIndex = resolveOutputIndex(event, this.functionBlocks);
      const index = this.functionBlocks.get(outputIndex);
      if (index !== undefined && typeof event.arguments === "string" && (this.functionArguments.get(outputIndex) ?? "") === "") {
        this.functionArguments.set(outputIndex, event.arguments);
        writeEvent(this.response, "content_block_delta", {
          type: "content_block_delta",
          index,
          delta: { type: "input_json_delta", partial_json: event.arguments },
        });
      }
    } else if (event.type === "response.output_item.done" && event.item?.type === "function_call") {
      const outputIndex = resolveOutputIndex(event, this.functionBlocks);
      const index = this.functionBlocks.get(outputIndex);
      if (index !== undefined) {
        writeEvent(this.response, "content_block_stop", { type: "content_block_stop", index });
        this.functionBlocks.delete(outputIndex);
        this.functionArguments.delete(outputIndex);
      }
    } else if (event.type === "response.completed") {
      this.finish(event, this.usedTool ? "tool_use" : "end_turn");
    } else if (event.type === "response.incomplete") {
      this.finish(event, incompleteStopReason(event));
    } else if (isFailure(event)) {
      throw upstreamFailure(event);
    }
  }

  /** Sends an Anthropic `ping` so Claude Code's idle watchdog sees bytes while the model reasons silently. */
  keepAlive(): void {
    if (this.stopped) return;
    this.start();
    writeEvent(this.response, "ping", { type: "ping" });
  }

  getUsage(): AnthropicUsage | undefined {
    return this.finalUsage;
  }

  assertCompleted(): void {
    if (!this.stopped) throw new BridgeError(502, "upstream_truncated", "OpenAI stream ended without response.completed.");
  }
}

type AccumulatedBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };

export class MessageAccumulator {
  private id = `resp_${randomUUID()}`;
  private textBuffer = "";
  private readonly toolCalls = new Map<number, { id: string; name: string; args: string }>();
  private content: AccumulatedBlock[] = [];
  private usage: AnthropicUsage = { input_tokens: 0, output_tokens: 0 };
  private stopReason: StopReason | undefined;
  /** A call whose arguments did not parse; only an output-limit cut-off excuses it, decided at the end. */
  private unparsedToolCall: string | undefined;

  constructor(private readonly model: string) {}

  private flushText(): void {
    if (this.textBuffer.length === 0) return;
    this.content.push({ type: "text", text: this.textBuffer });
    this.textBuffer = "";
  }

  accept(event: OpenAIEvent): void {
    if (this.stopReason !== undefined) return;
    if (event.type === "response.created" && event.response?.id) {
      this.id = event.response.id;
    } else if ((event.type === "response.output_text.delta" || event.type === "response.refusal.delta") && typeof event.delta === "string") {
      this.textBuffer += event.delta;
    } else if (event.type === "response.output_text.done" || event.type === "response.refusal.done") {
      this.flushText();
    } else if (event.type === "response.output_item.done" && event.item?.type === "reasoning") {
      if (event.item.signature !== undefined || event.item.encrypted_content) {
        const signature = event.item.signature ?? (event.item.encrypted_content ? encodeReasoningSignature(this.model, event.item.encrypted_content) : "");
        const thinking = summaryText(event.item);
        this.flushText();
        this.content.push(thinking.length > 0 ? { type: "thinking", thinking, signature } : { type: "redacted_thinking", data: signature });
      }
    } else if (event.type === "response.output_item.added" && event.item?.type === "function_call") {
      const outputIndex = event.output_index ?? this.toolCalls.size;
      const name = event.item.name ?? "tool";
      this.toolCalls.set(outputIndex, {
        id: event.item.call_id ?? `call_${randomUUID()}`,
        name,
        args: "",
      });
    } else if (event.type === "response.function_call_arguments.delta") {
      const outputIndex = resolveOutputIndex(event, this.toolCalls);
      const existing = this.toolCalls.get(outputIndex);
      if (existing && typeof event.delta === "string") {
        existing.args += event.delta;
      }
    } else if (event.type === "response.output_item.done" && event.item?.type === "function_call") {
      const outputIndex = resolveOutputIndex(event, this.toolCalls);
      const existing = this.toolCalls.get(outputIndex);
      if (existing) {
        const rawArgs = existing.args || event.item.arguments || "{}";
        this.toolCalls.delete(outputIndex);
        let input: unknown;
        try {
          input = JSON.parse(rawArgs);
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
          // Never returned as tool_use: a call with cut-off arguments must not run.
          this.unparsedToolCall ??= existing.name;
          return;
        }
        this.flushText();
        this.content.push({ type: "tool_use", id: existing.id, name: existing.name, input });
      }
    } else if (event.type === "response.completed" || event.type === "response.incomplete") {
      const stopReason: StopReason = event.type === "response.incomplete"
        ? incompleteStopReason(event)
        : this.content.some((c) => c.type === "tool_use") ? "tool_use" : "end_turn";
      if (this.unparsedToolCall !== undefined && stopReason !== "max_tokens") {
        throw new BridgeError(502, "invalid_tool_arguments", `OpenAI returned arguments for tool "${this.unparsedToolCall}" that are not valid JSON.`);
      }
      this.flushText();
      this.usage = toAnthropicUsage(event.response?.usage);
      this.stopReason = stopReason;
    } else if (isFailure(event)) {
      throw upstreamFailure(event);
    }
  }

  getUsage(): AnthropicUsage {
    return this.usage;
  }

  assertCompleted(): void {
    if (this.stopReason === undefined) throw new BridgeError(502, "upstream_truncated", "OpenAI stream ended without response.completed.");
  }

  buildMessage(): object {
    return {
      id: this.id,
      type: "message",
      role: "assistant",
      model: this.model,
      content: this.content,
      stop_reason: this.stopReason ?? "end_turn",
      stop_sequence: null,
      usage: this.usage,
    };
  }
}

export async function readSse(body: ReadableStream<Uint8Array>, accept: (event: OpenAIEvent) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      for (;;) {
        const match = /\r?\n\r?\n/.exec(buffer);
        if (!match) break;
        const frame = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
        if (data && data !== "[DONE]") {
          try {
            const parsed = z.object({ type: z.string() }).loose().safeParse(JSON.parse(data));
            if (!parsed.success) throw new BridgeError(502, "invalid_upstream_event", "OpenAI sent an invalid SSE event.");
            accept(parsed.data as OpenAIEvent);
          } catch (error) {
            if (error instanceof SyntaxError) throw new BridgeError(502, "invalid_upstream_json", "OpenAI sent malformed SSE JSON.");
            throw error;
          }
        }
      }
    }
    if (buffer.trim()) throw new BridgeError(502, "truncated_upstream_event", "OpenAI SSE stream ended inside an event.");
  } catch (error) {
    await reader.cancel();
    throw error;
  } finally {
    reader.releaseLock();
  }
}
