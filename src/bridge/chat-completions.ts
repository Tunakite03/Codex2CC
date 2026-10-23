import { z } from "zod";
import { BridgeError, MessageRequest, toOpenAIRequest, type EffortLevel, type OpenAIEvent, type OpenAIUsage } from "./bridge.js";

const Json = z.json();
type JsonValue = z.infer<typeof Json>;
type JsonObject = { [key: string]: JsonValue };
export type ChatReasoning = "none" | "openai" | "openrouter";
export type ChatStreamScope = { provider: "openai" | "openrouter" | "opencode"; model: string };
type TextPart = { type: "text"; text: string };
type ImagePart = { type: "image_url"; image_url: { url: string } };
type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type ChatMessage =
  | { role: "system" | "developer" | "user"; content: string | Array<TextPart | ImagePart> }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[]; reasoning_details?: ReasoningDetail[]; reasoning_content?: string }
  | { role: "tool"; tool_call_id: string; content: string | TextPart[] };
export type ChatCompletionsRequest = {
  model: string;
  stream: true;
  stream_options: { include_usage: true };
  provider?: { require_parameters: true };
  messages: ChatMessage[];
  tools?: Array<{ type: "function"; function: { name: string; description: string; parameters: JsonObject } }>;
  tool_choice?: "none" | "auto" | "required" | { type: "function"; function: { name: string } };
  parallel_tool_calls?: boolean;
  max_completion_tokens?: number;
  max_tokens?: number;
  reasoning_effort?: "low" | "medium" | "high";
  reasoning?: { effort?: "low" | "medium" | "high" | "xhigh"; enabled?: boolean; exclude: false };
};

const SchemaKeywords = z.object({
  type: z.union([z.enum(["object", "array", "string", "number", "integer", "boolean", "null"]), z.array(z.enum(["object", "array", "string", "number", "integer", "boolean", "null"])).nonempty()]).optional(),
  properties: z.record(z.string(), Json).optional(),
  patternProperties: z.record(z.string(), Json).optional(),
  $defs: z.record(z.string(), Json).optional(),
  definitions: z.record(z.string(), Json).optional(),
  required: z.array(z.string()).refine((values) => new Set(values).size === values.length).optional(),
  enum: z.array(Json).nonempty().optional(),
  allOf: z.array(Json).nonempty().optional(),
  anyOf: z.array(Json).nonempty().optional(),
  oneOf: z.array(Json).nonempty().optional(),
  prefixItems: z.array(Json).optional(),
  $ref: z.string().min(1).optional(),
  $id: z.string().optional(),
  $schema: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  format: z.string().optional(),
  pattern: z.string().optional(),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
  exclusiveMinimum: z.union([z.number(), z.boolean()]).optional(),
  exclusiveMaximum: z.union([z.number(), z.boolean()]).optional(),
  multipleOf: z.number().positive().optional(),
  minLength: z.number().int().nonnegative().optional(),
  maxLength: z.number().int().nonnegative().optional(),
  minItems: z.number().int().nonnegative().optional(),
  maxItems: z.number().int().nonnegative().optional(),
  minProperties: z.number().int().nonnegative().optional(),
  maxProperties: z.number().int().nonnegative().optional(),
  minContains: z.number().int().nonnegative().optional(),
  maxContains: z.number().int().nonnegative().optional(),
  uniqueItems: z.boolean().optional(),
  readOnly: z.boolean().optional(),
  writeOnly: z.boolean().optional(),
  deprecated: z.boolean().optional(),
  examples: z.array(Json).optional(),
  dependentRequired: z.record(z.string(), z.array(z.string())).optional(),
}).catchall(Json);

function invalidRequest(code: string, message: string): never {
  throw new BridgeError(400, code, message);
}

function schemaObject(value: JsonValue, tool: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return invalidRequest("invalid_tool_schema", `Tool "${tool}" requires an object JSON Schema.`);
  }
  const visit = (schema: JsonValue, depth: number): void => {
    if (depth > 100) invalidRequest("invalid_tool_schema", `Tool "${tool}" JSON Schema exceeds nesting limits.`);
    if (typeof schema === "boolean") return;
    const parsed = SchemaKeywords.safeParse(schema);
    if (!parsed.success) invalidRequest("invalid_tool_schema", `Tool "${tool}" contains an invalid JSON Schema keyword.`);
    const node = parsed.data;
    for (const field of ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"] as const) {
      const children = node[field];
      if (children === undefined) continue;
      if (children === null || typeof children !== "object" || Array.isArray(children)) invalidRequest("invalid_tool_schema", `Tool "${tool}" has invalid ${field}.`);
      for (const child of Object.values(children)) visit(child, depth + 1);
    }
    for (const field of ["allOf", "anyOf", "oneOf", "prefixItems"] as const) {
      for (const child of node[field] ?? []) visit(child, depth + 1);
    }
    for (const field of ["additionalProperties", "unevaluatedProperties", "additionalItems", "unevaluatedItems", "contains", "propertyNames", "not", "if", "then", "else"] as const) {
      const child = node[field];
      if (child !== undefined) visit(child, depth + 1);
    }
    const items = node.items;
    if (items !== undefined) {
      if (Array.isArray(items)) items.forEach((child) => visit(child, depth + 1));
      else visit(items, depth + 1);
    }
    const dependencies = node.dependencies;
    if (dependencies !== undefined) {
      if (dependencies === null || typeof dependencies !== "object" || Array.isArray(dependencies)) invalidRequest("invalid_tool_schema", `Tool "${tool}" has invalid dependencies.`);
      for (const child of Object.values(dependencies)) {
        if (Array.isArray(child)) {
          if (!child.every((entry) => typeof entry === "string")) invalidRequest("invalid_tool_schema", `Tool "${tool}" has invalid property dependencies.`);
        } else visit(child, depth + 1);
      }
    }
  };
  visit(value, 0);
  if (value.type !== undefined && value.type !== "object") invalidRequest("invalid_tool_schema", `Tool "${tool}" parameters must describe an object.`);
  return value;
}

const ReasoningDetailSchema = z.object({
  type: z.enum(["reasoning.summary", "reasoning.text", "reasoning.encrypted"]),
  index: z.number().int().nonnegative().optional(),
  id: z.string().nullable().optional(),
  format: z.string().nullable().optional(),
  text: z.string().nullable().optional(),
  summary: z.string().nullable().optional(),
  data: z.string().nullable().optional(),
  signature: z.string().nullable().optional(),
}).catchall(Json);
type ReasoningDetail = z.infer<typeof ReasoningDetailSchema>;
const REASONING_PREFIX = "codex2cc.chat.reasoning.v1:";
const ReasoningEnvelope = z.object({
  provider: z.enum(["openrouter", "opencode"]), model: z.string().min(1),
  details: z.array(ReasoningDetailSchema).nonempty().optional(), content: z.string().min(1).optional(),
}).refine((state) => state.details !== undefined || state.content !== undefined);
type ReplayedReasoning = { details: ReasoningDetail[]; content: string };

function replayReasoning(content: MessageRequest["messages"][number]["content"], scope: ChatStreamScope): ReplayedReasoning {
  const result: ReplayedReasoning = { details: [], content: "" };
  if (typeof content === "string" || scope.provider === "openai") return result;
  for (const block of content) {
    if (block.type !== "thinking" && block.type !== "redacted_thinking") continue;
    const signature = block.type === "thinking" ? block.signature : block.data;
    if (typeof signature !== "string" || !signature.startsWith(REASONING_PREFIX)) continue;
    let envelope: z.infer<typeof ReasoningEnvelope>;
    try {
      const raw: unknown = JSON.parse(Buffer.from(signature.slice(REASONING_PREFIX.length), "base64url").toString("utf8"));
      const parsed = ReasoningEnvelope.safeParse(raw);
      if (!parsed.success) invalidRequest("invalid_reasoning_signature", "Chat reasoning signature has an invalid payload.");
      envelope = parsed.data;
    } catch (error) {
      if (error instanceof SyntaxError) invalidRequest("invalid_reasoning_signature", "Chat reasoning signature contains malformed JSON.");
      throw error;
    }
    if (envelope.model === scope.model && envelope.provider === scope.provider) {
      if (scope.provider === "openrouter") result.details.push(...envelope.details ?? []);
      if (scope.provider === "opencode") result.content += envelope.content ?? "";
    }
  }
  return result;
}

function parts(content: string | ReadonlyArray<{ type: "input_text"; text: string } | { type: "input_image"; image_url: string }>): string | Array<TextPart | ImagePart> {
  if (typeof content === "string") return content;
  return content.map((part) => part.type === "input_text" ? { type: "text", text: part.text } : { type: "image_url", image_url: { url: part.image_url } });
}

/** Reuses Responses content validation without replaying its Codex-specific encrypted reasoning. */
export function toChatCompletionsRequest(request: MessageRequest, model: string, reasoning: ChatReasoning, defaultEffort: EffortLevel | undefined, scope: ChatStreamScope): ChatCompletionsRequest {
  const parsed = MessageRequest.safeParse(request);
  if (!parsed.success) invalidRequest("invalid_request", "Invalid Messages request for Chat Completions.");
  if (!model.trim() || scope.model !== model) invalidRequest("invalid_model", "Chat Completions requires a nonempty model matching its replay scope.");
  const source = parsed.data;
  const converted = toOpenAIRequest(source, model);
  const messages: ChatMessage[] = [];
  let toolImages: Array<TextPart | ImagePart> = [];
  const flushToolImages = (): void => {
    if (toolImages.length) messages.push({ role: "user", content: toolImages });
    toolImages = [];
  };
  if (source.system !== undefined) messages.push({ role: "system", content: typeof source.system === "string" ? source.system : source.system.map((block) => block.text).join("\n\n") });
  for (const message of source.messages) {
    const input = toOpenAIRequest({ ...source, messages: [message] }, model).input;
    if (message.role === "assistant") {
      flushToolImages();
      const text: string[] = [];
      const calls: ToolCall[] = [];
      for (const item of input) {
        if ("role" in item && item.role === "assistant") text.push(...item.content.map((part) => part.type === "refusal" ? part.refusal : part.text));
        else if ("type" in item && item.type === "function_call") {
          let argumentsValue: unknown;
          try { argumentsValue = JSON.parse(item.arguments); } catch (error) {
            if (error instanceof SyntaxError) invalidRequest("invalid_tool_arguments", `Tool "${item.name}" history contains malformed JSON arguments.`);
            throw error;
          }
          if (!z.record(z.string(), Json).safeParse(argumentsValue).success) invalidRequest("invalid_tool_arguments", `Tool "${item.name}" history requires object arguments.`);
          calls.push({ id: item.call_id, type: "function", function: { name: item.name, arguments: item.arguments } });
        }
      }
      const replay = replayReasoning(message.content, scope);
      if (text.length || calls.length || replay.details.length || replay.content || typeof message.content === "string") {
        messages.push({ role: "assistant", content: text.length ? text.join("") : null, ...(calls.length ? { tool_calls: calls } : {}), ...(replay.details.length ? { reasoning_details: replay.details } : {}), ...(replay.content ? { reasoning_content: replay.content } : {}) });
      }
    } else {
      for (const item of input) {
        if ("role" in item && item.role !== "assistant") {
          flushToolImages();
          messages.push({ role: message.role === "system" ? "system" : item.role, content: parts(item.content) });
        } else if ("type" in item && item.type === "function_call_output") {
          const content = parts(item.output);
          if (typeof content === "string") messages.push({ role: "tool", tool_call_id: item.call_id, content });
          else {
            const text = content.filter((part): part is TextPart => part.type === "text");
            messages.push({ role: "tool", tool_call_id: item.call_id, content: text.length ? text : "" });
            const images = content.filter((part): part is ImagePart => part.type === "image_url");
            // Chat tool messages only accept text. Defer images until all adjacent tool results
            // have been answered, otherwise a user message would split parallel call results.
            if (images.length) toolImages.push({ type: "text", text: `Image output from tool call "${item.call_id}":` }, ...images);
          }
        }
      }
    }
  }
  flushToolImages();
  const result: ChatCompletionsRequest = { model, stream: true, stream_options: { include_usage: true }, messages };
  if (scope.provider === "openrouter") result.provider = { require_parameters: true };
  if (scope.provider === "openai") result.max_completion_tokens = source.max_tokens;
  else result.max_tokens = source.max_tokens;
  if (converted.tools) result.tools = converted.tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: schemaObject(tool.parameters, tool.name) } }));
  const choice = converted.tool_choice;
  if (typeof choice === "object") {
    if (!result.tools?.some((tool) => tool.function.name === choice.name)) invalidRequest("invalid_tool_choice", "The selected tool is not an available function tool.");
    result.tool_choice = { type: "function", function: { name: choice.name } };
  } else if (choice !== undefined) {
    if (choice === "required" && !result.tools?.length) invalidRequest("invalid_tool_choice", "Required tool choice needs at least one function tool.");
    result.tool_choice = choice;
  }
  if (converted.parallel_tool_calls !== undefined) result.parallel_tool_calls = converted.parallel_tool_calls;
  const effort = source.output_config?.effort ?? source.reasoning_effort ?? defaultEffort;
  if (reasoning === "openai" && effort !== undefined) result.reasoning_effort = effort === "max" || effort === "xhigh" ? "high" : effort;
  if (reasoning === "openrouter") result.reasoning = source.thinking?.type === "disabled"
    ? { enabled: false, exclude: false }
    : { ...(effort !== undefined ? { effort: effort === "max" ? "xhigh" : effort } : { enabled: true }), exclude: false };
  return result;
}

const UpstreamError = z.union([z.string(), z.object({ message: z.string(), code: z.union([z.string(), z.number()]).optional(), type: z.string().optional() })]);
const CallFragment = z.object({ index: z.number().int().nonnegative().optional(), id: z.string().nullable().optional(), type: z.literal("function").optional(), function: z.object({ name: z.string().optional(), arguments: z.string().optional() }).optional() });
const Delta = z.object({
  role: z.literal("assistant").optional(),
  content: z.string().nullable().optional(),
  refusal: z.string().nullable().optional(),
  reasoning: z.string().nullable().optional(),
  reasoning_content: z.string().nullable().optional(),
  reasoning_details: z.array(ReasoningDetailSchema).nullable().optional(),
  tool_calls: z.array(CallFragment).nullable().optional(),
  // These modalities cannot be silently translated to text or tool calls.
  function_call: z.null().optional(), audio: z.null().optional(), images: z.null().optional(),
});
const Usage = z.object({ prompt_tokens: z.number().int().nonnegative(), completion_tokens: z.number().int().nonnegative(), prompt_tokens_details: z.object({ cached_tokens: z.number().int().nonnegative().optional() }).nullable().optional() });
const Choice = z.object({ index: z.literal(0), delta: Delta.optional(), message: Delta.optional(), finish_reason: z.enum(["stop", "tool_calls", "function_call", "length", "content_filter", "error"]).nullable().optional(), error: UpstreamError.optional() });
const Chunk = z.object({ id: z.string().optional(), model: z.string().optional(), choices: z.array(Choice).max(1), usage: Usage.nullable().optional(), error: UpstreamError.optional() });
const ErrorFrame = z.object({ error: UpstreamError });
type CallState = { id: string; name: string; arguments: string };
type SignedEvent = OpenAIEvent & { item?: NonNullable<OpenAIEvent["item"]> & { signature?: string } };

function streamError(code: string, message: string): never { throw new BridgeError(502, code, message); }
function upstreamError(error: z.infer<typeof UpstreamError>): never {
  const code = typeof error === "string" ? "upstream_error" : String(error.code ?? error.type ?? "upstream_error");
  const message = typeof error === "string" ? error : error.message;
  if (/context_(length|window|limit)_exceeded/.test(code) || /prompt is too long|context (window|length)/i.test(message)) {
    throw new BridgeError(400, "context_length_exceeded", message);
  }
  const status = ["429", "rate_limit_exceeded", "rate_limit_error", "insufficient_quota"].includes(code) ? 429
    : ["401", "authentication_error", "invalid_api_key"].includes(code) ? 401 : 502;
  throw new BridgeError(status, code, message);
}
function parseFrame(data: string): z.infer<typeof Chunk> {
  let raw: unknown;
  try { raw = JSON.parse(data); } catch (error) {
    if (error instanceof SyntaxError) streamError("invalid_upstream_json", "Chat Completions sent malformed SSE JSON.");
    throw error;
  }
  const error = ErrorFrame.safeParse(raw);
  if (error.success) upstreamError(error.data.error);
  const parsed = Chunk.safeParse(raw);
  if (!parsed.success) streamError("invalid_upstream_event", "Chat Completions sent an invalid SSE chunk.");
  return parsed.data;
}

function appendIdentity(previous: string, fragment: string | null | undefined): string {
  if (!fragment) return previous;
  return previous + fragment;
}

/** Normalizes one completion choice, retaining final usage before emitting a terminal Responses event. */
export async function readChatCompletionsSse(body: ReadableStream<Uint8Array>, accept: (event: OpenAIEvent) => void, scope: ChatStreamScope): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const calls = new Map<number, CallState>();
  const details = new Map<string, ReasoningDetail>();
  let buffer = "";
  let id: string | undefined;
  let created = false;
  let finish: z.infer<typeof Choice>["finish_reason"];
  let usage: OpenAIUsage | undefined;
  let reasoningText = "";
  let reasoningContent = "";
  let outputText = "";
  let refusalText = "";
  let done = false;
  let eof = false;
  const emit = (event: SignedEvent): void => accept(event);
  const mergeDetails = (fragments: ReasoningDetail[], full: boolean): void => {
    if (scope.provider !== "openrouter") streamError("unsupported_reasoning_details", "OpenRouter reasoning_details require an explicit OpenRouter provider/model scope.");
    fragments.forEach((fragment, position) => {
      const key = `${fragment.index ?? position}:${fragment.type}`;
      const prior = details.get(key);
      if (!prior) { details.set(key, { ...fragment }); return; }
      if (fragment.id && prior.id && fragment.id !== prior.id) streamError("invalid_upstream_event", "Reasoning detail identity changed during streaming.");
      const merged: ReasoningDetail = { ...prior, ...fragment };
      for (const field of ["text", "summary", "data", "signature"] as const) {
        const next = fragment[field];
        const previous = prior[field];
        if (typeof next === "string" && typeof previous === "string") {
          if (full && !next.startsWith(previous)) streamError("invalid_upstream_event", "Final reasoning details conflict with streamed details.");
          merged[field] = full ? next : previous + next;
        }
      }
      details.set(key, merged);
    });
  };
  const textDelta = (next: string | null | undefined, previous: string, full: boolean, type: string): string => {
    if (!next) return previous;
    if (full && !next.startsWith(previous)) streamError("invalid_upstream_event", "Final message conflicts with streamed content.");
    const delta = full ? next.slice(previous.length) : next;
    if (delta) emit({ type, delta });
    return full ? next : previous + next;
  };
  const consume = (data: string): void => {
    if (data === "[DONE]") { done = true; return; }
    const chunk = parseFrame(data);
    if (!created) { id = chunk.id; emit({ type: "response.created", response: { ...(id !== undefined ? { id } : {}) } }); created = true; }
    else if (chunk.id && id && chunk.id !== id) streamError("invalid_upstream_event", "Chat completion ID changed during streaming.");
    if (chunk.usage) usage = { input_tokens: chunk.usage.prompt_tokens, output_tokens: chunk.usage.completion_tokens, ...(chunk.usage.prompt_tokens_details?.cached_tokens !== undefined ? { input_tokens_details: { cached_tokens: chunk.usage.prompt_tokens_details.cached_tokens } } : {}) };
    const choice = chunk.choices[0];
    if (!choice) return;
    if (choice.error !== undefined) upstreamError(choice.error);
    if (choice.finish_reason === "error") streamError("upstream_error", choice.delta?.content ?? "Chat Completions ended with an error choice.");
    if (finish) {
      // OpenRouter's final usage chunk repeats the terminal choice with an empty delta.
      const emptyDelta = choice.delta === undefined || Object.values(choice.delta).every((value) => value == null || value === "" || (Array.isArray(value) && value.length === 0));
      if (!choice.message && emptyDelta && (choice.finish_reason == null || choice.finish_reason === finish)) return;
      streamError("invalid_upstream_event", "Chat Completions sent content or a conflicting finish reason after completion.");
    }
    if (choice.delta && choice.message) streamError("invalid_upstream_event", "A completion choice cannot contain both delta and message.");
    const delta = choice.delta ?? choice.message;
    const full = choice.message !== undefined;
    if (delta) {
      const explicitReasoning = delta.reasoning_content ?? delta.reasoning;
      if (delta.reasoning_content) reasoningContent = full ? delta.reasoning_content : reasoningContent + delta.reasoning_content;
      reasoningText = textDelta(explicitReasoning, reasoningText, full, "response.reasoning_summary_text.delta");
      if (delta.reasoning_details?.length) {
        mergeDetails(delta.reasoning_details, full);
        if (!explicitReasoning) {
          const summary = delta.reasoning_details.map((detail) => detail.type === "reasoning.summary" ? detail.summary ?? "" : detail.type === "reasoning.text" ? detail.text ?? "" : "").join("");
          reasoningText = textDelta(summary, reasoningText, full, "response.reasoning_summary_text.delta");
        }
      }
      outputText = textDelta(delta.content, outputText, full, "response.output_text.delta");
      refusalText = textDelta(delta.refusal, refusalText, full, "response.refusal.delta");
      delta.tool_calls?.forEach((call, position) => {
        if (!full && call.index === undefined) streamError("invalid_upstream_event", "Streaming tool calls require an index.");
        const index = call.index ?? position;
        const prior = calls.get(index) ?? { id: "", name: "", arguments: "" };
        if (full) {
          if ((call.id && prior.id && call.id !== prior.id) || (call.function?.name && prior.name && call.function.name !== prior.name) || (call.function?.arguments !== undefined && !call.function.arguments.startsWith(prior.arguments))) streamError("invalid_upstream_event", "Final tool call conflicts with streamed fragments.");
          calls.set(index, { id: call.id ?? prior.id, name: call.function?.name ?? prior.name, arguments: call.function?.arguments ?? prior.arguments });
        } else calls.set(index, { id: appendIdentity(prior.id, call.id), name: appendIdentity(prior.name, call.function?.name), arguments: prior.arguments + (call.function?.arguments ?? "") });
      });
    }
    if (choice.finish_reason) finish = choice.finish_reason;
  };
  const decode = (bytes?: Uint8Array): string => {
    try { return bytes === undefined ? decoder.decode() : decoder.decode(bytes, { stream: true }); } catch (error) {
      if (error instanceof TypeError) streamError("invalid_upstream_encoding", "Chat Completions sent invalid UTF-8.");
      throw error;
    }
  };
  try {
    while (!done) {
      const chunk = await reader.read();
      if (chunk.done) { eof = true; buffer += decode(); break; }
      buffer += decode(chunk.value);
      for (;;) {
        const delimiter = /\r?\n\r?\n/.exec(buffer);
        if (!delimiter) break;
        const frame = buffer.slice(0, delimiter.index);
        buffer = buffer.slice(delimiter.index + delimiter[0].length);
        if (frame.length > 8 * 1024 * 1024) streamError("upstream_event_too_large", "Chat Completions SSE frame exceeds the size limit.");
        const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n");
        if (data.trim()) consume(data.trim());
        if (done) break;
      }
      if (!done && buffer.length > 8 * 1024 * 1024) streamError("upstream_event_too_large", "Chat Completions SSE frame exceeds the size limit.");
    }
    if (!done && buffer.trim()) streamError("truncated_upstream_event", "Chat Completions stream ended inside an SSE event.");
    if (!finish) streamError("upstream_truncated", "Chat Completions ended without a finish_reason.");
    if (finish === "function_call") streamError("unsupported_function_call", "Legacy function_call completions are unsupported; use tools instead.");
    if (finish === "tool_calls" && calls.size === 0) streamError("invalid_upstream_event", "Chat Completions finished with tool_calls but returned no calls.");
    if (outputText) emit({ type: "response.output_text.done", text: outputText });
    if (refusalText) emit({ type: "response.refusal.done", text: refusalText });
    if (reasoningText || details.size) {
      const state = details.size && scope.provider === "openrouter"
        ? { provider: scope.provider, model: scope.model, details: [...details.values()] }
        : reasoningContent && scope.provider === "opencode" ? { provider: scope.provider, model: scope.model, content: reasoningContent } : undefined;
      const signature = state ? REASONING_PREFIX + Buffer.from(JSON.stringify(state)).toString("base64url") : undefined;
      emit({ type: "response.output_item.done", item: { type: "reasoning", summary: reasoningText ? [{ type: "summary_text", text: reasoningText }] : [], signature: signature ?? "" } });
    }
    const ids = new Set<string>();
    for (const [index, call] of calls) {
      if (!call.id || !call.name) {
        if (finish === "length" || finish === "content_filter") continue;
        streamError("invalid_upstream_event", "Chat Completions returned a tool call without its ID or name.");
      }
      if (ids.has(call.id)) streamError("invalid_upstream_event", "Chat Completions returned duplicate tool call IDs.");
      ids.add(call.id);
      let parsedArguments: unknown;
      try { parsedArguments = JSON.parse(call.arguments); } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        if (finish === "length" || finish === "content_filter") continue;
        streamError("invalid_tool_arguments", `Chat Completions returned malformed arguments for tool "${call.name}".`);
      }
      if (!z.record(z.string(), Json).safeParse(parsedArguments).success) streamError("invalid_tool_arguments", `Chat Completions returned non-object arguments for tool "${call.name}".`);
      // Buffered headers avoid emitting a partial function name or inventing IDs. No tool is executed here.
      emit({ type: "response.output_item.added", output_index: index, item: { type: "function_call", call_id: call.id, name: call.name } });
      emit({ type: "response.function_call_arguments.delta", output_index: index, delta: call.arguments });
      emit({ type: "response.function_call_arguments.done", output_index: index, arguments: call.arguments });
      emit({ type: "response.output_item.done", output_index: index, item: { type: "function_call", call_id: call.id, name: call.name, arguments: call.arguments } });
    }
    const incomplete = finish === "length" ? "max_output_tokens" : finish === "content_filter" || refusalText ? "content_filter" : undefined;
    emit({ type: incomplete ? "response.incomplete" : "response.completed", response: { ...(id !== undefined ? { id } : {}), ...(usage ? { usage } : {}), ...(incomplete ? { incomplete_details: { reason: incomplete } } : {}) } });
  } finally {
    if (!eof) {
      try { await reader.cancel(); } catch (error) {
        console.warn("Chat Completions reader cancellation failed", { error: error instanceof Error ? error.name : "non_error_rejection" });
      }
    }
    reader.releaseLock();
  }
}
