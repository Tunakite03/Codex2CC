import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import { z } from "zod";

const JsonValue = z.json();
const TextBlock = z.object({ type: z.literal("text"), text: z.string() }).passthrough();
const ImageBlock = z.object({
  type: z.literal("image"),
  source: z.discriminatedUnion("type", [
    z.object({ type: z.literal("base64"), media_type: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]), data: z.string() }),
    z.object({ type: z.literal("url"), url: z.string().min(1) }),
  ]),
}).passthrough();
const ToolUseBlock = z.object({ type: z.literal("tool_use"), id: z.string().min(1), name: z.string().min(1), input: JsonValue }).passthrough();
const KNOWN_BLOCK_TYPES: readonly string[] = ["text", "image", "tool_use", "tool_result", "thinking", "redacted_thinking"];
// Block types Claude Code may send that the Responses API cannot take (document, server_tool_use, ...).
// They pass validation and are replaced by a visible note instead of failing the whole request.
const UnknownBlock = z.object({ type: z.string().refine((type) => !KNOWN_BLOCK_TYPES.includes(type)) }).passthrough();
const ToolResultBlock = z.object({
  type: z.literal("tool_result"), tool_use_id: z.string().min(1),
  content: z.union([z.string(), z.array(z.union([TextBlock, ImageBlock, UnknownBlock]))]).optional(),
  is_error: z.boolean().optional(),
}).passthrough();
const ThinkingBlock = z.object({ type: z.enum(["thinking", "redacted_thinking"]), thinking: z.string().optional() }).passthrough();
const Block = z.discriminatedUnion("type", [TextBlock, ImageBlock, ToolUseBlock, ToolResultBlock, ThinkingBlock]);
type KnownBlock = z.infer<typeof Block>;
const Message = z.object({ role: z.enum(["user", "assistant", "system", "developer"]), content: z.union([z.string(), z.array(z.union([Block, UnknownBlock]))]) }).passthrough();
// Server-side tools (for example web_search) have no input_schema and cannot be offered as function tools.
const Tool = z.object({ name: z.string().min(1), description: z.string().default(""), input_schema: JsonValue.optional() }).passthrough();
const ToolChoice = z.discriminatedUnion("type", [
  z.object({ type: z.literal("auto") }).passthrough(),
  z.object({ type: z.literal("any") }).passthrough(),
  z.object({ type: z.literal("none") }).passthrough(),
  z.object({ type: z.literal("tool"), name: z.string().min(1) }).passthrough(),
]);
export const MessageRequest = z.object({
  model: z.string().min(1),
  max_tokens: z.number().int().positive().optional().default(4096),
  messages: z.array(Message).min(1),
  system: z.union([z.string(), z.array(TextBlock)]).optional(),
  tools: z.array(Tool).optional(),
  tool_choice: ToolChoice.optional(),
  stream: z.boolean().default(false),
}).passthrough();
export type MessageRequest = z.infer<typeof MessageRequest>;

export class BridgeError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "BridgeError";
  }
}

type InputText = { type: "input_text"; text: string };
type InputImage = { type: "input_image"; image_url: string };
type OutputText = { type: "output_text"; text: string };
type Refusal = { type: "refusal"; refusal: string };
type InputItem =
  | { role: "user" | "developer"; content: string | Array<InputText | InputImage> }
  | { role: "assistant"; content: Array<OutputText | Refusal> }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string | Array<InputText | InputImage> };
export type FunctionTool = { type: "function"; name: string; description: string; parameters: z.infer<typeof JsonValue> };
export type OpenAIRequest = {
  model: string;
  input: InputItem[];
  instructions?: string;
  tools?: FunctionTool[];
  tool_choice?: "none" | "auto" | "required" | { type: "function"; name: string };
  store: false;
  stream: true;
};

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
  const result: OpenAIRequest = { model, input, store: false, stream: true };
  if (instructions) result.instructions = instructions;
  const functionTools = tools.flatMap((tool): FunctionTool[] => tool.input_schema === undefined
    ? []
    : [{ type: "function", name: tool.name, description: tool.description, parameters: tool.input_schema }]);
  if (functionTools.length > 0) result.tools = functionTools;
  if (request.tool_choice?.type === "none") result.tool_choice = "none";
  else if (request.tool_choice?.type === "any") result.tool_choice = "required";
  else if (request.tool_choice?.type === "auto") result.tool_choice = "auto";
  else if (request.tool_choice?.type === "tool") result.tool_choice = { type: "function", name: request.tool_choice.name };
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

const CHARS_PER_TOKEN = 4;
const IMAGE_TOKEN_ESTIMATE = 1_500;

function blockWeight(block: { type: string }): { chars: number; images: number } {
  if (isTextBlock(block)) return { chars: block.text.length, images: 0 };
  if (isImageBlock(block)) return { chars: 0, images: 1 };
  if (!isKnownBlock(block)) return { chars: JSON.stringify(block).length, images: 0 };
  if (block.type === "tool_use") return { chars: block.name.length + JSON.stringify(block.input).length, images: 0 };
  if (block.type === "tool_result") {
    if (block.content === undefined) return { chars: 0, images: 0 };
    if (typeof block.content === "string") return { chars: block.content.length, images: 0 };
    return block.content.reduce((total, inner) => {
      const weight = blockWeight(inner);
      return { chars: total.chars + weight.chars, images: total.images + weight.images };
    }, { chars: 0, images: 0 });
  }
  if (block.type === "thinking") return { chars: (block.thinking ?? "").length, images: 0 };
  return { chars: 0, images: 0 };
}

/**
 * Heuristic input size (about 4 characters per token, a fixed cost per image). The Responses API has
 * no token-counting endpoint, so this only has to be good enough for Claude Code's context accounting.
 */
export function estimateInputTokens(request: MessageRequest): number {
  let chars = typeof request.system === "string" ? request.system.length : (request.system ?? []).reduce((sum, block) => sum + block.text.length, 0);
  let images = 0;
  for (const tool of request.tools ?? []) {
    chars += tool.name.length + tool.description.length + JSON.stringify(tool.input_schema ?? {}).length;
  }
  for (const message of request.messages) {
    if (typeof message.content === "string") {
      chars += message.content.length;
      continue;
    }
    for (const block of message.content) {
      const weight = blockWeight(block);
      chars += weight.chars;
      images += weight.images;
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN) + images * IMAGE_TOKEN_ESTIMATE;
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
    output?: Array<{
      type?: string;
      content?: Array<{ type?: string; text?: string; refusal?: string }>;
      call_id?: string;
      name?: string;
      arguments?: string;
    }>;
  };
  output_index?: number;
  item?: {
    type?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
  };
  delta?: string;
  arguments?: string;
  text?: string;
};

/** Responses events normally carry output_index; without one the oldest open call is meant. */
function resolveOutputIndex(event: OpenAIEvent, open: ReadonlyMap<number, unknown>): number {
  return event.output_index ?? open.keys().next().value ?? 0;
}

function writeEvent(response: ServerResponse, event: string, data: object): void {
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export class AnthropicStream {
  private started = false;
  private stopped = false;
  private nextBlock = 0;
  private textBlock: number | undefined;
  private textOutput = "";
  private readonly functionBlocks = new Map<number, number>();
  private readonly functionArguments = new Map<number, string>();
  private usedTool = false;

  constructor(
    private readonly response: ServerResponse,
    private readonly model: string,
    private readonly estimatedInputTokens: number = 0,
  ) {}

  private start(id: string): void {
    if (this.started) return;
    this.started = true;
    writeEvent(this.response, "message_start", {
      type: "message_start",
      message: {
        id,
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

  accept(event: OpenAIEvent): void {
    if (this.stopped) return;
    if (event.type === "response.created") {
      const id = event.response?.id ?? `resp_${randomUUID()}`;
      this.start(id);
    } else if (event.type === "response.output_text.delta" || event.type === "response.refusal.delta") {
      if (!this.started) this.start(`resp_${randomUUID()}`);
      if (typeof event.delta === "string" && event.delta.length > 0) {
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
      if (!this.started) this.start(`resp_${randomUUID()}`);
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
      if (!this.started) this.start(`resp_${randomUUID()}`);
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
      writeEvent(this.response, "message_delta", {
        type: "message_delta",
        delta: { stop_reason: this.usedTool ? "tool_use" : "end_turn", stop_sequence: null },
        usage: toAnthropicUsage(event.response?.usage),
      });
      writeEvent(this.response, "message_stop", { type: "message_stop" });
      this.stopped = true;
    } else if (["response.failed", "response.incomplete", "error"].includes(event.type)) {
      throw new BridgeError(502, event.response?.error?.code ?? "upstream_incomplete", event.response?.error?.message ?? "OpenAI did not complete the response.");
    }
  }

  assertCompleted(): void {
    if (!this.stopped) throw new BridgeError(502, "upstream_truncated", "OpenAI stream ended without response.completed.");
  }
}

export class MessageAccumulator {
  private id = `resp_${randomUUID()}`;
  private textBuffer = "";
  private readonly toolCalls = new Map<number, { id: string; name: string; args: string }>();
  private content: Array<
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: unknown }
  > = [];
  private usage: AnthropicUsage = { input_tokens: 0, output_tokens: 0 };

  constructor(private readonly model: string) {}

  accept(event: OpenAIEvent): void {
    if (event.type === "response.created" && event.response?.id) {
      this.id = event.response.id;
    } else if ((event.type === "response.output_text.delta" || event.type === "response.refusal.delta") && typeof event.delta === "string") {
      this.textBuffer += event.delta;
    } else if (event.type === "response.output_text.done" || event.type === "response.refusal.done") {
      if (this.textBuffer.length > 0) {
        this.content.push({ type: "text", text: this.textBuffer });
        this.textBuffer = "";
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
        let input: unknown = {};
        const rawArgs = existing.args || event.item.arguments || "{}";
        try { input = JSON.parse(rawArgs); } catch { input = {}; }
        this.content.push({
          type: "tool_use",
          id: existing.id,
          name: existing.name,
          input,
        });
        this.toolCalls.delete(outputIndex);
      }
    } else if (event.type === "response.completed") {
      if (this.textBuffer.length > 0) {
        this.content.push({ type: "text", text: this.textBuffer });
        this.textBuffer = "";
      }
      this.usage = toAnthropicUsage(event.response?.usage);
    }
  }

  buildMessage(): object {
    const stopReason = this.content.some((c) => c.type === "tool_use") ? "tool_use" : "end_turn";
    return {
      id: this.id,
      type: "message",
      role: "assistant",
      model: this.model,
      content: this.content,
      stop_reason: stopReason,
      stop_sequence: null,
      usage: this.usage,
    };
  }
}

export async function readSse(body: ReadableStream<Uint8Array>, accept: (event: OpenAIEvent) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
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
          const parsed = z.object({ type: z.string() }).passthrough().safeParse(JSON.parse(data));
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
}
