import { z } from "zod";
import { BridgeError, type EffortLevel, type MessageRequest, type OpenAIEvent, type OpenAIUsage } from "./bridge.js";
import { decodeProviderReasoning, encodeProviderReasoning, type ReasoningScope } from "../providers/reasoning.js";
import type { ApiProvider } from "../providers/config.js";

const Text = z.object({ type: z.literal("text"), text: z.string() });
const Image = z.object({ type: z.literal("image"), source: z.discriminatedUnion("type", [
  z.object({ type: z.literal("url"), url: z.string().url() }),
  z.object({ type: z.literal("base64"), media_type: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]), data: z.string() }),
]) });
const ToolUse = z.object({ type: z.literal("tool_use"), id: z.string().min(1), name: z.string().min(1), input: z.record(z.string(), z.json()) });
const ToolResult = z.object({ type: z.literal("tool_result"), tool_use_id: z.string().min(1), content: z.union([z.string(), z.array(z.union([Text, Image]))]).optional(), is_error: z.boolean().optional() });
const Thinking = z.object({ type: z.literal("thinking"), thinking: z.string(), signature: z.string() });
const Redacted = z.object({ type: z.literal("redacted_thinking"), data: z.string() });
const Block = z.discriminatedUnion("type", [Text, Image, ToolUse, ToolResult, Thinking, Redacted]);
type NativeBlock = z.infer<typeof Block>;
type NativeMessage = { role: "user" | "assistant"; content: string | NativeBlock[] };
const ThinkingConfig = z.discriminatedUnion("type", [
  z.object({ type: z.literal("disabled") }),
  z.object({ type: z.literal("adaptive") }),
  z.object({ type: z.literal("enabled"), budget_tokens: z.number().int().min(1024) }),
]);
const ToolSchema = z.record(z.string(), z.json());
export type NativeMessagesRequest = {
  model: string;
  max_tokens: number;
  stream: true;
  messages: NativeMessage[];
  system?: string;
  tools?: Array<{ name: string; description: string; input_schema: z.infer<typeof ToolSchema> }>;
  tool_choice?: { type: "auto" | "any" | "none" | "tool"; name?: string; disable_parallel_tool_use?: boolean };
  thinking?: z.infer<typeof ThinkingConfig>;
  output_config?: { effort: "low" | "medium" | "high" };
};

function nativeBlock(block: { type: string }, scope: ReasoningScope): NativeBlock[] {
  if (!["text", "image", "tool_use", "tool_result", "thinking", "redacted_thinking"].includes(block.type)) {
    return [{ type: "text", text: `[Unsupported content block "${block.type}" omitted by Codex2CC]` }];
  }
  const parsed = Block.safeParse(block);
  if (!parsed.success) throw new BridgeError(400, "invalid_message", `Invalid Anthropic ${block.type} block.`);
  const value = parsed.data;
  if (value.type === "thinking" || value.type === "redacted_thinking") {
    const signature = decodeProviderReasoning(scope, value.type === "thinking" ? value.signature : value.data);
    if (signature === undefined) return [];
    return [value.type === "thinking" ? { ...value, signature } : { ...value, data: signature }];
  }
  return [value];
}

/** Native Messages preserves tool IDs and signed reasoning, without forwarding arbitrary client fields. */
export function toAnthropicRequest(request: MessageRequest, provider: ApiProvider, model: string, defaultEffort: EffortLevel | undefined): NativeMessagesRequest {
  const scope: ReasoningScope = { provider, protocol: "anthropic-messages", model };
  const system: string[] = typeof request.system === "string" ? [request.system] : (request.system ?? []).map((block) => block.text);
  const messages: NativeMessage[] = [];
  for (const message of request.messages) {
    if (message.role === "system" || message.role === "developer") {
      if (typeof message.content === "string") system.push(message.content);
      else for (const block of message.content) {
        const text = Text.safeParse(block);
        if (!text.success) throw new BridgeError(400, "invalid_system_block", "System and developer messages must contain text for Anthropic Messages.");
        system.push(text.data.text);
      }
      continue;
    }
    const content = typeof message.content === "string" ? message.content : message.content.flatMap((block) => nativeBlock(block, scope));
    if (Array.isArray(content)) {
      if (content.some((block) => block.type === "tool_use" && message.role !== "assistant" || block.type === "tool_result" && message.role !== "user")) {
        throw new BridgeError(400, "invalid_tool_role", "Tool calls require assistant role and tool results require user role.");
      }
      if (content.length === 0) continue;
    }
    messages.push({ role: message.role, content });
  }
  if (messages.length === 0) throw new BridgeError(400, "invalid_message", "Anthropic Messages requires user or assistant content.");
  const tools = (request.tools ?? []).filter((tool) => tool.input_schema !== undefined).map((tool) => {
    const schema = ToolSchema.safeParse(tool.input_schema);
    if (!schema.success) throw new BridgeError(400, "invalid_tool_schema", `Tool "${tool.name}" requires a JSON object schema.`);
    return { name: tool.name, description: tool.description, input_schema: schema.data };
  });
  const thinking = request.thinking === undefined ? undefined : ThinkingConfig.safeParse(request.thinking);
  if (thinking && !thinking.success) throw new BridgeError(400, "invalid_thinking", "Anthropic thinking must be disabled, adaptive, or enabled with a valid budget_tokens.");
  if (thinking?.success && thinking.data.type === "enabled" && thinking.data.budget_tokens >= request.max_tokens) {
    throw new BridgeError(400, "invalid_thinking", "Thinking budget_tokens must be less than max_tokens.");
  }
  const choice = request.tool_choice;
  const effort = request.output_config?.effort ?? request.reasoning_effort ?? defaultEffort;
  return {
    model, max_tokens: request.max_tokens, stream: true, messages,
    ...(system.length ? { system: system.join("\n\n") } : {}),
    ...(tools.length ? { tools } : {}),
    ...(choice ? { tool_choice: { type: choice.type, ...(choice.type === "tool" ? { name: choice.name } : {}), ...(choice.type !== "none" && choice.disable_parallel_tool_use !== undefined ? { disable_parallel_tool_use: choice.disable_parallel_tool_use } : {}) } } : {}),
    ...(thinking?.success ? { thinking: thinking.data } : {}),
    ...(effort ? { output_config: { effort: effort === "xhigh" || effort === "max" ? "high" : effort } } : {}),
  };
}

const Usage = z.object({ input_tokens: z.number().nonnegative().optional(), output_tokens: z.number().nonnegative().optional(), cache_read_input_tokens: z.number().nonnegative().optional(), cache_creation_input_tokens: z.number().nonnegative().optional() });
const Index = z.number().int().nonnegative();
const Event = z.discriminatedUnion("type", [
  z.object({ type: z.literal("message_start"), message: z.object({ id: z.string().min(1), usage: Usage }) }),
  z.object({ type: z.literal("content_block_start"), index: Index, content_block: Block }),
  z.object({ type: z.literal("content_block_delta"), index: Index, delta: z.discriminatedUnion("type", [
    z.object({ type: z.literal("text_delta"), text: z.string() }),
    z.object({ type: z.literal("input_json_delta"), partial_json: z.string() }),
    z.object({ type: z.literal("thinking_delta"), thinking: z.string() }),
    z.object({ type: z.literal("signature_delta"), signature: z.string() }),
  ]) }),
  z.object({ type: z.literal("content_block_stop"), index: Index }),
  z.object({ type: z.literal("message_delta"), delta: z.object({ stop_reason: z.string().nullable().optional() }), usage: Usage.optional() }),
  z.object({ type: z.literal("message_stop") }),
  z.object({ type: z.literal("ping") }),
  z.object({ type: z.literal("error"), error: z.object({ type: z.string(), message: z.string() }) }),
]);
type BlockState = { readonly kind: "text" | "thinking" | "tool_use" | "redacted_thinking"; text: string; signature: string; arguments: string; id: string; name: string };

class NativeEventAdapter {
  private started = false;
  private completed = false;
  private reason: string | undefined;
  private usage: z.infer<typeof Usage> = {};
  private readonly blocks = new Map<number, BlockState>();
  private readonly usedIndices = new Set<number>();

  constructor(private readonly scope: ReasoningScope, private readonly emit: (event: OpenAIEvent) => void) {}

  accept(input: unknown): void {
    const result = Event.safeParse(input);
    if (!result.success) throw new BridgeError(502, "invalid_upstream_event", "Anthropic provider returned an invalid stream event.");
    const event = result.data;
    if (event.type === "ping") return;
    if (this.completed) throw new BridgeError(502, "invalid_upstream_event", "Anthropic provider sent data after message_stop.");
    if (event.type === "error") {
      const status = event.error.type === "rate_limit_error" ? 429 : event.error.type === "authentication_error" ? 401 : 502;
      if (/prompt is too long|context (window|length)/i.test(event.error.message)) throw new BridgeError(400, "context_length_exceeded", event.error.message);
      throw new BridgeError(status, "provider_stream_error", event.error.message);
    }
    if (event.type === "message_start") {
      if (this.started) throw new BridgeError(502, "invalid_upstream_event", "Anthropic provider started the message twice.");
      this.started = true;
      this.usage = event.message.usage;
      this.emit({ type: "response.created", response: { id: event.message.id } });
      return;
    }
    if (!this.started) throw new BridgeError(502, "invalid_upstream_event", "Anthropic provider omitted message_start.");
    if (event.type === "content_block_start") {
      if (this.usedIndices.has(event.index)) throw new BridgeError(502, "invalid_upstream_event", "Anthropic provider reused a content block index.");
      this.usedIndices.add(event.index);
      const block = event.content_block;
      if (block.type === "image" || block.type === "tool_result") throw new BridgeError(502, "unsupported_upstream_block", `Unsupported assistant response block: ${block.type}.`);
      const state: BlockState = { kind: block.type, text: "", signature: "", arguments: "", id: "", name: "" };
      this.blocks.set(event.index, state);
      if (block.type === "text") {
        state.text = block.text;
        if (block.text) this.emit({ type: "response.output_text.delta", delta: block.text, output_index: event.index });
      } else if (block.type === "tool_use") {
        state.id = block.id;
        state.name = block.name;
        state.arguments = Object.keys(block.input).length ? JSON.stringify(block.input) : "";
        this.emit({ type: "response.output_item.added", output_index: event.index, item: { type: "function_call", call_id: block.id, name: block.name } });
        if (state.arguments) this.emit({ type: "response.function_call_arguments.delta", output_index: event.index, delta: state.arguments });
      } else if (block.type === "thinking") {
        state.text = block.thinking;
        state.signature = block.signature;
        if (block.thinking) this.emit({ type: "response.reasoning_summary_text.delta", output_index: event.index, delta: block.thinking });
      } else state.signature = block.data;
    } else if (event.type === "content_block_delta") {
      const state = this.blocks.get(event.index);
      if (!state) throw new BridgeError(502, "invalid_upstream_event", "Anthropic delta references an unopened block.");
      const delta = event.delta;
      if (delta.type === "text_delta" && state.kind === "text") {
        this.emit({ type: "response.output_text.delta", output_index: event.index, delta: delta.text });
      } else if (delta.type === "thinking_delta" && state.kind === "thinking") {
        state.text += delta.thinking;
        this.emit({ type: "response.reasoning_summary_text.delta", output_index: event.index, delta: delta.thinking });
      } else if (delta.type === "signature_delta" && state.kind === "thinking") state.signature += delta.signature;
      else if (delta.type === "input_json_delta" && state.kind === "tool_use") {
        state.arguments += delta.partial_json;
        this.emit({ type: "response.function_call_arguments.delta", output_index: event.index, delta: delta.partial_json });
      } else throw new BridgeError(502, "invalid_upstream_event", "Anthropic delta does not match its content block type.");
    } else if (event.type === "content_block_stop") {
      const state = this.blocks.get(event.index);
      if (!state) throw new BridgeError(502, "invalid_upstream_event", "Anthropic stop references an unopened block.");
      this.blocks.delete(event.index);
      if (state.kind === "text") this.emit({ type: "response.output_text.done", output_index: event.index });
      else if (state.kind === "tool_use") {
        const args = state.arguments || "{}";
        this.emit({ type: "response.function_call_arguments.done", output_index: event.index, arguments: args });
        this.emit({ type: "response.output_item.done", output_index: event.index, item: { type: "function_call", call_id: state.id, name: state.name, arguments: args } });
      } else {
        this.emit({ type: "response.output_item.done", output_index: event.index, item: {
          type: "reasoning", summary: state.text ? [{ type: "summary_text", text: state.text }] : [],
          signature: state.signature ? encodeProviderReasoning(this.scope, state.signature) : "",
        } });
      }
    } else if (event.type === "message_delta") {
      this.reason = event.delta.stop_reason ?? this.reason;
      this.usage = { ...this.usage, ...event.usage };
    } else if (event.type === "message_stop") {
      if (this.blocks.size || !this.reason) throw new BridgeError(502, "upstream_truncated", "Anthropic provider ended with unfinished content or no stop reason.");
      const cached = this.usage.cache_read_input_tokens ?? 0;
      const usage: OpenAIUsage = { input_tokens: (this.usage.input_tokens ?? 0) + cached + (this.usage.cache_creation_input_tokens ?? 0), output_tokens: this.usage.output_tokens ?? 0, input_tokens_details: { cached_tokens: cached } };
      if (this.reason === "max_tokens" || this.reason === "refusal") {
        this.emit({ type: "response.incomplete", response: { usage, incomplete_details: { reason: this.reason === "max_tokens" ? "max_output_tokens" : "content_filter" } } });
      } else if (["end_turn", "stop_sequence", "tool_use"].includes(this.reason)) {
        this.emit({ type: "response.completed", response: { usage } });
      } else throw new BridgeError(502, "unsupported_stop_reason", `Anthropic provider stopped with unsupported reason: ${this.reason}.`);
      this.completed = true;
    }
  }

  finish(): void {
    if (!this.completed) throw new BridgeError(502, "upstream_truncated", "Anthropic stream ended without message_stop.");
  }
}

export async function readAnthropicSse(body: ReadableStream<Uint8Array>, accept: (event: OpenAIEvent) => void, provider: ApiProvider, model: string): Promise<void> {
  const adapter = new NativeEventAdapter({ provider, protocol: "anthropic-messages", model }, accept);
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      buffer += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
      for (;;) {
        const boundary = /\r?\n\r?\n/.exec(buffer);
        if (!boundary) break;
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
        if (!data) continue;
        try { adapter.accept(JSON.parse(data)); }
        catch (error) {
          if (error instanceof SyntaxError) throw new BridgeError(502, "invalid_upstream_json", "Anthropic provider returned malformed SSE JSON.");
          throw error;
        }
      }
      if (buffer.length > 2 * 1024 * 1024) throw new BridgeError(502, "upstream_event_too_large", "Anthropic provider SSE event exceeds the size limit.");
      if (chunk.done) break;
    }
    if (buffer.trim()) throw new BridgeError(502, "truncated_upstream_event", "Anthropic stream ended inside an SSE event.");
    adapter.finish();
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}
