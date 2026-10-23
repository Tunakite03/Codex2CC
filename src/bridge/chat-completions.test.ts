import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { z } from "zod";
import { AnthropicStream, BridgeError, encodeReasoningSignature, MessageAccumulator, MessageRequest, type OpenAIEvent } from "./bridge.js";
import { readChatCompletionsSse, toChatCompletionsRequest, type ChatStreamScope } from "./chat-completions.js";

const scope: ChatStreamScope = { provider: "openai", model: "gpt-test" };
const router: ChatStreamScope = { provider: "openrouter", model: "vendor/model:free" };
const tool = { name: "Read", description: "Read a file", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } };
const basic = (): MessageRequest => MessageRequest.parse({ model: "client-model", max_tokens: 1200, messages: [{ role: "user", content: "Hello" }] });
const frame = (value: object): string => `data: ${JSON.stringify(value)}\n\n`;
const delta = (content: object, finish: string | null = null): string => frame({ id: "chat_1", choices: [{ index: 0, delta: content, finish_reason: finish }] });
const end = (): string => delta({}, "stop") + "data: [DONE]\n\n";
function body(text: string, chunkSize: number = 7): ReadableStream<Uint8Array> {
  const encoded = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({ start(controller) { for (let index = 0; index < encoded.length; index += chunkSize) controller.enqueue(encoded.slice(index, index + chunkSize)); controller.close(); } });
}
async function events(text: string, selected: ChatStreamScope = scope): Promise<OpenAIEvent[]> {
  const result: OpenAIEvent[] = [];
  await readChatCompletionsSse(body(text), (event) => result.push(event), selected);
  return result;
}
function errorCode(code: string): (error: unknown) => boolean {
  return (error: unknown): boolean => error instanceof BridgeError && error.code === code;
}
const BuiltMessage = z.object({ content: z.array(z.object({ type: z.string(), text: z.string().optional(), thinking: z.string().optional(), signature: z.string().optional(), data: z.string().optional(), id: z.string().optional(), name: z.string().optional(), input: z.json().optional() })), stop_reason: z.string(), usage: z.object({ input_tokens: z.number(), output_tokens: z.number(), cache_read_input_tokens: z.number().optional() }) });

test("chat request preserves system, developer, text and images without mutation", () => {
  const request = MessageRequest.parse({ model: "client", system: [{ type: "text", text: "First" }, { type: "text", text: "Second" }], messages: [
    { role: "system", content: "History system" }, { role: "developer", content: "Rules" },
    { role: "user", content: [{ type: "text", text: "Inspect" }, { type: "image", source: { type: "url", url: "https://example.com/image.png" } }, { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } }] },
  ] });
  const before = JSON.stringify(request);
  const converted = toChatCompletionsRequest(request, scope.model, "none", undefined, scope);
  assert.deepEqual(converted.messages, [
    { role: "system", content: "First\n\nSecond" }, { role: "system", content: "History system" }, { role: "developer", content: "Rules" },
    { role: "user", content: [{ type: "text", text: "Inspect" }, { type: "image_url", image_url: { url: "https://example.com/image.png" } }, { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } }] },
  ]);
  assert.equal(JSON.stringify(request), before);
  assert.equal(converted.stream, true);
  assert.deepEqual(converted.stream_options, { include_usage: true });
  assert.equal(converted.max_completion_tokens, 4096);
  assert.equal(converted.max_tokens, undefined);
});

test("chat request groups parallel tool calls and preserves multimodal/error results", () => {
  const request = MessageRequest.parse({ model: "client", tools: [tool], tool_choice: { type: "tool", name: "Read", disable_parallel_tool_use: true }, messages: [
    { role: "assistant", content: [{ type: "text", text: "Checking." }, { type: "tool_use", id: "a", name: "Read", input: { path: "a" } }, { type: "tool_use", id: "b", name: "HistoricalTool", input: {} }, { type: "text", text: "Again." }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "a", is_error: true, content: [{ type: "text", text: "Denied" }, { type: "image", source: { type: "url", url: "https://example.com/error.png" } }] }, { type: "tool_result", tool_use_id: "b", content: "OK" }, { type: "text", text: "Continue" }] },
  ] });
  const converted = toChatCompletionsRequest(request, scope.model, "openai", "medium", scope);
  assert.deepEqual(converted.messages, [
    { role: "assistant", content: "Checking.Again.", tool_calls: [{ id: "a", type: "function", function: { name: "Read", arguments: '{"path":"a"}' } }, { id: "b", type: "function", function: { name: "HistoricalTool", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "a", content: [{ type: "text", text: "Tool error:" }, { type: "text", text: "Denied" }] },
    { role: "tool", tool_call_id: "b", content: "OK" },
    { role: "user", content: [{ type: "text", text: 'Image output from tool call "a":' }, { type: "image_url", image_url: { url: "https://example.com/error.png" } }] },
    { role: "user", content: [{ type: "text", text: "Continue" }] },
  ]);
  assert.deepEqual(converted.tools, [{ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.input_schema } }]);
  assert.deepEqual(converted.tool_choice, { type: "function", function: { name: "Read" } });
  assert.equal(converted.parallel_tool_calls, false);
});

test("tool choices map none, auto and required without inventing tools", () => {
  for (const [type, expected] of [["none", "none"], ["auto", "auto"], ["any", "required"]] as const) {
    const request = MessageRequest.parse({ ...basic(), tools: [tool], tool_choice: { type } });
    const converted = toChatCompletionsRequest(request, scope.model, "none", undefined, scope);
    assert.equal(converted.tool_choice, expected);
    assert.equal(converted.parallel_tool_calls, type === "none" ? undefined : true);
  }
  for (const choice of [{ type: "any" }, { type: "tool", name: "Missing" }]) {
    assert.throws(() => toChatCompletionsRequest(MessageRequest.parse({ ...basic(), tool_choice: choice }), scope.model, "none", undefined, scope), errorCode("invalid_tool_choice"));
  }
});

test("reasoning policies normalize effort, respect precedence and omit fields for none", () => {
  const request = MessageRequest.parse({ ...basic(), output_config: { effort: "max" }, reasoning_effort: "low" });
  assert.equal(toChatCompletionsRequest(request, scope.model, "openai", "medium", scope).reasoning_effort, "high");
  assert.equal(toChatCompletionsRequest({ ...basic(), reasoning_effort: "xhigh" }, scope.model, "openai", undefined, scope).reasoning_effort, "high");
  assert.equal(toChatCompletionsRequest(basic(), scope.model, "openai", "low", scope).reasoning_effort, "low");
  assert.deepEqual(toChatCompletionsRequest(request, router.model, "openrouter", undefined, router).reasoning, { effort: "xhigh", exclude: false });
  const none = toChatCompletionsRequest(request, router.model, "none", "high", router);
  assert.equal(none.reasoning, undefined);
  assert.equal(none.reasoning_effort, undefined);
  assert.equal(none.max_tokens, 1200);
  assert.equal(none.max_completion_tokens, undefined);
  assert.deepEqual(toChatCompletionsRequest({ ...basic(), thinking: { type: "disabled" } }, router.model, "openrouter", "high", router).reasoning, { enabled: false, exclude: false });
});

test("Codex encrypted reasoning and foreign signatures never replay to chat", () => {
  const request = MessageRequest.parse({ ...basic(), messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "private", signature: encodeReasoningSignature(scope.model, "ciphertext") }, { type: "redacted_thinking", data: "foreign" }, { type: "text", text: "Answer" }] }] });
  const converted = toChatCompletionsRequest(request, scope.model, "openai", undefined, scope);
  assert.deepEqual(converted.messages, [{ role: "assistant", content: "Answer" }]);
  assert.doesNotMatch(JSON.stringify(converted), /ciphertext|private|codex2cc.reasoning/);
});

test("schema validation rejects malformed roots and nested schema keywords", () => {
  const invalid = [null, false, [], "object", { type: "array" }, { type: "object", properties: [] }, { type: "object", properties: { child: { type: "wrong" } } }, { type: "object", required: [1] }, { type: "object", required: ["x", "x"] }, { type: "object", additionalProperties: "yes" }, { type: "object", allOf: [{}, 2] }, { type: "object", properties: { list: { type: "array", items: { minLength: -1 } } } }];
  for (const input_schema of invalid) {
    const request = MessageRequest.parse({ ...basic(), tools: [{ name: "Bad", input_schema }] });
    assert.throws(() => toChatCompletionsRequest(request, scope.model, "none", undefined, scope), errorCode("invalid_tool_schema"));
  }
});

test("schema validation preserves refs, boolean subschemas and extension annotations", () => {
  const input_schema = { type: "object", $defs: { value: { anyOf: [{ type: "string" }, { type: "null" }] } }, properties: { value: { $ref: "#/$defs/value" }, forbidden: false }, additionalProperties: false, "x-annotation": { value: 1 } };
  const converted = toChatCompletionsRequest(MessageRequest.parse({ ...basic(), tools: [{ name: "Valid", input_schema }] }), scope.model, "none", undefined, scope);
  assert.deepEqual(converted.tools?.[0]?.function.parameters, input_schema);
});

test("invalid roles and malformed historical arguments fail loudly", () => {
  for (const input of ["not json", "[]", 42, null]) {
    const request = MessageRequest.parse({ ...basic(), messages: [{ role: "assistant", content: [{ type: "tool_use", id: "x", name: "Read", input }] }] });
    assert.throws(() => toChatCompletionsRequest(request, scope.model, "none", undefined, scope), errorCode("invalid_tool_arguments"));
  }
  const image = { type: "image", source: { type: "url", url: "https://example.com/a.png" } };
  assert.throws(() => toChatCompletionsRequest(MessageRequest.parse({ ...basic(), messages: [{ role: "assistant", content: [image] }] }), scope.model, "none", undefined, scope), errorCode("unsupported_image"));
  assert.throws(() => toChatCompletionsRequest(MessageRequest.parse({ ...basic(), messages: [{ role: "assistant", content: [{ type: "tool_result", tool_use_id: "x" }] }] }), scope.model, "none", undefined, scope), errorCode("invalid_tool_role"));
});

test("unsupported content remains visible and tool errors keep their semantics", () => {
  const request = MessageRequest.parse({ ...basic(), messages: [{ role: "user", content: [{ type: "document" }, { type: "tool_result", tool_use_id: "x", is_error: true }, { type: "tool_result", tool_use_id: "y", content: "failure", is_error: true }] }] });
  const converted = toChatCompletionsRequest(request, scope.model, "none", undefined, scope);
  assert.match(JSON.stringify(converted.messages[0]), /Unsupported content block/);
  assert.deepEqual(converted.messages.slice(1), [{ role: "tool", tool_call_id: "x", content: "Tool error." }, { role: "tool", tool_call_id: "y", content: "Tool error: failure" }]);
});

test("SSE preserves split UTF-8, CRLF, comments, multiline data and late usage", async () => {
  const text = ": heartbeat\r\n\r\n" + delta({ content: "Hello 🌍 世界" }).replaceAll("\n", "\r\n")
    + 'event: message\r\ndata: {"choices":\r\ndata: [{"index":0,"delta":{},"finish_reason":"stop"}]}\r\n\r\n'
    + frame({ choices: [], usage: { prompt_tokens: 50, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 20 } } }) + "data: [DONE]\n\n";
  const result: OpenAIEvent[] = [];
  const accumulator = new MessageAccumulator(scope.model);
  const stream = body(text, 1);
  await readChatCompletionsSse(stream, (event) => { result.push(event); accumulator.accept(event); }, scope);
  accumulator.assertCompleted();
  assert.equal(stream.locked, false);
  const message = BuiltMessage.parse(accumulator.buildMessage());
  assert.deepEqual(message.content, [{ type: "text", text: "Hello 🌍 世界" }]);
  assert.deepEqual(message.usage, { input_tokens: 30, output_tokens: 7, cache_read_input_tokens: 20 });
  assert.equal(result.at(-1)?.type, "response.completed");
  assert.equal(message.stop_reason, "end_turn");
});

test("parallel call fragments assemble complete names, IDs and arguments for another round", async () => {
  const text = delta({ tool_calls: [{ index: 0, id: "call_", type: "function", function: { name: "Re", arguments: '{"path":' } }, { index: 1, id: "call_b", function: { name: "List", arguments: "{" } }] })
    + delta({ tool_calls: [{ index: 1, function: { arguments: "}" } }, { index: 0, id: "a", function: { name: "ad", arguments: '"a.ts"}' } }] }) + delta({}, "tool_calls") + "data: [DONE]\n\n";
  const accumulator = new MessageAccumulator(scope.model);
  await readChatCompletionsSse(body(text), (event) => accumulator.accept(event), scope);
  accumulator.assertCompleted();
  const message = BuiltMessage.parse(accumulator.buildMessage());
  assert.deepEqual(message.content, [{ type: "tool_use", id: "call_a", name: "Read", input: { path: "a.ts" } }, { type: "tool_use", id: "call_b", name: "List", input: {} }]);
  assert.equal(message.stop_reason, "tool_use");
  const round = MessageRequest.parse({ ...basic(), messages: [{ role: "assistant", content: message.content }, { role: "user", content: [{ type: "tool_result", tool_use_id: "call_a", content: "file" }, { type: "tool_result", tool_use_id: "call_b", content: "list" }] }] });
  const converted = toChatCompletionsRequest(round, scope.model, "none", undefined, scope);
  assert.equal(converted.messages.length, 3);
  const assistant = converted.messages[0];
  assert.ok(assistant?.role === "assistant");
  assert.equal(assistant.tool_calls?.length, 2);
});

test("full tool arguments and final message snapshots do not duplicate deltas", async () => {
  const text = delta({ content: "Hel", tool_calls: [{ index: 0, id: "a", function: { name: "Read", arguments: '{"path":' } }] })
    + frame({ choices: [{ index: 0, message: { role: "assistant", content: "Hello", tool_calls: [{ id: "a", type: "function", function: { name: "Read", arguments: '{"path":"a"}' } }] }, finish_reason: "tool_calls" }] });
  const result = await events(text);
  assert.equal(result.filter((event) => event.type === "response.output_text.delta").map((event) => event.delta).join(""), "Hello");
  assert.equal(result.find((event) => event.type === "response.function_call_arguments.done")?.arguments, '{"path":"a"}');
  assert.equal(result.at(-1)?.type, "response.completed");
});

test("Anthropic SSE encoder consumes normalized tools and final usage", async () => {
  const source = delta({ content: "Inspecting." }) + delta({ tool_calls: [{ index: 0, id: "a", function: { name: "Read", arguments: "{}" } }] }, "tool_calls")
    + frame({ choices: [], usage: { prompt_tokens: 8, completion_tokens: 4 } }) + "data: [DONE]\n\n";
  const server = createServer((_request, response) => {
    const encoder = new AnthropicStream(response, scope.model);
    void readChatCompletionsSse(body(source), (event) => encoder.accept(event), scope).then(() => { encoder.assertCompleted(); response.end(); }, (error: Error) => response.destroy(error));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const response = await fetch(`http://127.0.0.1:${address.port}`);
    const encoded = await response.text();
    assert.match(encoded, /"type":"tool_use","id":"a","name":"Read"/);
    assert.match(encoded, /"partial_json":"\{\}"/);
    assert.match(encoded, /"stop_reason":"tool_use"/);
    assert.match(encoded, /"input_tokens":8,"output_tokens":4/);
    assert.match(encoded, /event: message_stop/);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("OpenRouter reasoning details round-trip in provider/model-scoped signatures", async () => {
  const source = delta({ reasoning: "Think ", reasoning_details: [{ type: "reasoning.text", index: 0, id: "r", text: "Think ", signature: "sig" }, { type: "reasoning.encrypted", index: 1, data: "part" }] })
    + delta({ reasoning: "more", reasoning_details: [{ type: "reasoning.text", index: 0, text: "more" }, { type: "reasoning.encrypted", index: 1, data: "two" }] })
    + delta({ tool_calls: [{ index: 0, id: "a", function: { name: "Read", arguments: "{}" } }] }, "tool_calls") + "data: [DONE]\n\n";
  const result = await events(source, router);
  const reasoning = z.object({ item: z.object({ signature: z.string(), summary: z.array(z.object({ text: z.string() })) }) }).parse(result.find((event) => event.item?.type === "reasoning"));
  assert.match(reasoning.item.signature, /^codex2cc\.chat\.reasoning\.v1:/);
  assert.equal(reasoning.item.summary[0]?.text, "Think more");
  const request = MessageRequest.parse({ ...basic(), messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "Think more", signature: reasoning.item.signature }, { type: "tool_use", id: "a", name: "Read", input: {} }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "OK" }] }] });
  const converted = toChatCompletionsRequest(request, router.model, "openrouter", undefined, router);
  const assistant = converted.messages[0];
  assert.ok(assistant?.role === "assistant");
  assert.deepEqual(assistant.reasoning_details, [{ type: "reasoning.text", index: 0, id: "r", text: "Think more", signature: "sig" }, { type: "reasoning.encrypted", index: 1, data: "parttwo" }]);
  assert.doesNotMatch(JSON.stringify(toChatCompletionsRequest(request, "different", "openrouter", undefined, { ...router, model: "different" })), /reasoning_details/);
  assert.doesNotMatch(JSON.stringify(toChatCompletionsRequest(request, router.model, "none", undefined, { provider: "opencode", model: router.model })), /reasoning_details/);
  assert.doesNotMatch(JSON.stringify(result), /encrypted_content/);
});

test("reasoning_content emits a summary without fabricating encrypted replay", async () => {
  const result = await events(delta({ reasoning_content: "Internal reasoning" }) + delta({ content: "Answer" }) + end());
  assert.ok(result.some((event) => event.type === "response.reasoning_summary_text.delta" && event.delta === "Internal reasoning"));
  assert.deepEqual(result.find((event) => event.item?.type === "reasoning")?.item, { type: "reasoning", summary: [{ type: "summary_text", text: "Internal reasoning" }], signature: "" });
});

test("refusal and content filtering map to refusal stop reason", async () => {
  for (const source of [delta({ refusal: "Cannot comply" }, "stop"), delta({}, "content_filter")]) {
    const accumulator = new MessageAccumulator(scope.model);
    await readChatCompletionsSse(body(source), (event) => accumulator.accept(event), scope);
    accumulator.assertCompleted();
    assert.equal(BuiltMessage.parse(accumulator.buildMessage()).stop_reason, "refusal");
  }
});

test("length cutoffs exclude incomplete tool calls and map to max_tokens", async () => {
  const accumulator = new MessageAccumulator(scope.model);
  const source = delta({ content: "Partial", tool_calls: [{ index: 0, id: "a", function: { name: "Read", arguments: '{"path":' } }] }, "length");
  await readChatCompletionsSse(body(source), (event) => accumulator.accept(event), scope);
  const message = BuiltMessage.parse(accumulator.buildMessage());
  assert.equal(message.stop_reason, "max_tokens");
  assert.deepEqual(message.content, [{ type: "text", text: "Partial" }]);
});

test("clean EOF with finish reason succeeds but premature EOF and DONE cannot invent success", async () => {
  assert.equal((await events(delta({ content: "OK" }, "stop"))).at(-1)?.type, "response.completed");
  for (const source of ["", delta({ content: "Partial" }), delta({ content: "Partial" }) + "data: [DONE]\n\n", "data: [DONE]\n\n"]) {
    const result: OpenAIEvent[] = [];
    await assert.rejects(readChatCompletionsSse(body(source), (event) => result.push(event), scope), errorCode("upstream_truncated"));
    assert.equal(result.some((event) => event.type === "response.completed"), false);
  }
  await assert.rejects(events(delta({}, "stop") + 'data: {"choices":'), errorCode("truncated_upstream_event"));
});

test("malformed JSON, invalid frames, unsupported modalities and late errors fail", async () => {
  await assert.rejects(events("data: {bad}\n\n"), errorCode("invalid_upstream_json"));
  for (const invalid of [[], {}, { choices: [{ index: 1, delta: {} }] }, { choices: [{ index: 0, delta: { content: 1 } }] }, { choices: [], usage: { prompt_tokens: -1, completion_tokens: 2 } }, { choices: [{ index: 0, delta: { audio: { data: "x" } } }] }, { choices: [{ index: 0, delta: { tool_calls: [{ function: { name: "X", arguments: "{}" } }] } }] }]) {
    await assert.rejects(events(frame(invalid)), errorCode("invalid_upstream_event"));
  }
  await assert.rejects(events(delta({}, "stop") + frame({ error: { code: "late_error", message: "Failed after finish" } })), errorCode("late_error"));
  await assert.rejects(events(frame({ choices: [{ index: 0, error: { message: "Choice failed", code: 429 } }] })), errorCode("429"));
  await assert.rejects(events(delta({}, "error")), errorCode("upstream_error"));
  await assert.rejects(events(delta({}, "tool_calls")), errorCode("invalid_upstream_event"));
});

test("malformed and non-object completed tool arguments never produce success", async () => {
  for (const argumentsText of ["", "{", "[]", "null", "3"]) {
    const source = delta({ tool_calls: [{ index: 0, id: "a", function: { name: "Read", arguments: argumentsText } }] }, "tool_calls");
    await assert.rejects(events(source), errorCode("invalid_tool_arguments"));
  }
  await assert.rejects(events(delta({ tool_calls: [{ index: 0, function: { name: "Read", arguments: "{}" } }] }, "tool_calls")), errorCode("invalid_upstream_event"));
});

test("reader is cancelled and released on malformed input, DONE and callback errors", async () => {
  for (const source of ["data: invalid\n\n", delta({ content: "text" }) + end()]) {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(source)); }, cancel() { cancelled = true; } });
    if (source.startsWith("data: invalid")) await assert.rejects(readChatCompletionsSse(stream, () => {}, scope), errorCode("invalid_upstream_json"));
    else await readChatCompletionsSse(stream, () => {}, scope);
    assert.equal(cancelled, true);
    assert.equal(stream.locked, false);
  }
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(delta({ content: "text" }))); }, cancel() { cancelled = true; } });
  const failure = new Error("consumer disconnected");
  await assert.rejects(readChatCompletionsSse(stream, () => { throw failure; }, scope), (error) => error === failure);
  assert.equal(cancelled, true);
  assert.equal(stream.locked, false);
});

test("invalid UTF-8 and wrong-provider reasoning details are rejected", async () => {
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([0xff])); controller.close(); } });
  await assert.rejects(readChatCompletionsSse(stream, () => {}, scope), errorCode("invalid_upstream_encoding"));
  assert.equal(stream.locked, false);
  await assert.rejects(events(delta({ reasoning_details: [{ type: "reasoning.encrypted", data: "secret" }] }) + end()), errorCode("unsupported_reasoning_details"));
});

test("live accumulator preserves OpenRouter signatures through a complete tool round", async () => {
  const source = delta({ reasoning_details: [{ type: "reasoning.text", index: 0, text: "Need a tool", signature: "signed" }, { type: "reasoning.encrypted", index: 1, data: "encrypted" }] })
    + delta({ tool_calls: [{ index: 0, id: "a", function: { name: "Read", arguments: "{}" } }] }, "tool_calls") + "data: [DONE]\n\n";
  const accumulator = new MessageAccumulator(router.model);
  await readChatCompletionsSse(body(source), (event) => accumulator.accept(event), router);
  accumulator.assertCompleted();
  const message = BuiltMessage.parse(accumulator.buildMessage());
  assert.equal(message.content[0]?.type, "thinking");
  assert.equal(message.content[0]?.thinking, "Need a tool");
  assert.match(message.content[0]?.signature ?? "", /^codex2cc\.chat\.reasoning\.v1:/);
  const next = MessageRequest.parse({ ...basic(), messages: [{ role: "assistant", content: message.content }, { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "OK" }] }] });
  const converted = toChatCompletionsRequest(next, router.model, "openrouter", undefined, router);
  const assistant = converted.messages[0];
  assert.ok(assistant?.role === "assistant");
  assert.equal(assistant.reasoning_details?.length, 2);
  assert.equal(assistant.tool_calls?.[0]?.id, "a");
  const plain = new MessageAccumulator(scope.model);
  await readChatCompletionsSse(body(delta({ reasoning_content: "Visible thought" }) + end()), (event) => plain.accept(event), scope);
  assert.deepEqual(BuiltMessage.parse(plain.buildMessage()).content, [{ type: "thinking", thinking: "Visible thought", signature: "" }]);
});

test("live SSE encoder preserves scoped thinking and redacted signatures", async () => {
  const server = createServer((_request, response) => {
    const encoder = new AnthropicStream(response, router.model);
    const source = delta({ reasoning_details: [{ type: "reasoning.text", text: "Thinking", index: 0 }, { type: "reasoning.encrypted", data: "encrypted", index: 1 }] }) + end();
    void readChatCompletionsSse(body(source), (event) => encoder.accept(event), router).then(() => { encoder.assertCompleted(); response.end(); }, (error: Error) => response.destroy(error));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const encoded = await (await fetch(`http://127.0.0.1:${address.port}`)).text();
    assert.match(encoded, /"type":"thinking_delta","thinking":"Thinking"/);
    assert.match(encoded, /"type":"signature_delta","signature":"codex2cc\.chat\.reasoning\.v1:/);
    assert.doesNotMatch(encoded, /codex2cc\.reasoning\.v1:/);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  const encrypted = new MessageAccumulator(router.model);
  await readChatCompletionsSse(body(delta({ reasoning_details: [{ type: "reasoning.encrypted", data: "opaque", index: 0 }] }) + end()), (event) => encrypted.accept(event), router);
  const message = BuiltMessage.parse(encrypted.buildMessage());
  assert.equal(message.content[0]?.type, "redacted_thinking");
  const request = MessageRequest.parse({ ...basic(), messages: [{ role: "assistant", content: message.content }] });
  const assistant = toChatCompletionsRequest(request, router.model, "openrouter", undefined, router).messages[0];
  assert.ok(assistant?.role === "assistant");
  assert.equal(assistant.reasoning_details?.[0]?.data, "opaque");
});

test("identical identity fragments remain deltas, and malformed replay signatures fail", async () => {
  const result = await events(delta({ tool_calls: [{ index: 0, id: "a", function: { name: "Re", arguments: "{" } }] })
    + delta({ tool_calls: [{ index: 0, id: "a", function: { name: "Re", arguments: "}" } }] }, "tool_calls"));
  assert.equal(result.find((event) => event.item?.type === "function_call")?.item?.name, "ReRe");
  assert.equal(result.find((event) => event.item?.type === "function_call")?.item?.call_id, "aa");
  const bad = MessageRequest.parse({ ...basic(), messages: [{ role: "assistant", content: [{ type: "redacted_thinking", data: "codex2cc.chat.reasoning.v1:not-json" }] }] });
  assert.throws(() => toChatCompletionsRequest(bad, router.model, "openrouter", undefined, router), errorCode("invalid_reasoning_signature"));
});

test("OpenRouter final usage may repeat the finish reason with an empty choice", async () => {
  const source = delta({ content: "hello" }) + delta({}, "stop") + frame({
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 22, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 7 } },
  }) + "data: [DONE]\n\n";
  const accumulator = new MessageAccumulator(router.model);
  await readChatCompletionsSse(body(source), (event) => accumulator.accept(event), router);
  accumulator.assertCompleted();
  assert.deepEqual(accumulator.getUsage(), { input_tokens: 15, output_tokens: 5, cache_read_input_tokens: 7 });
  await assert.rejects(events(delta({}, "stop") + delta({ content: "late" }, "stop")), errorCode("invalid_upstream_event"));
  await assert.rejects(events(delta({}, "stop") + delta({}, "length")), errorCode("invalid_upstream_event"));
});

test("streamed provider rate, auth and context errors retain actionable status codes", async () => {
  for (const [code, status] of [[429, 429], [401, 401], ["context_length_exceeded", 400]] as const) {
    await assert.rejects(events(frame({ error: { code, message: "provider error" } })), (error: unknown) => error instanceof BridgeError && error.status === status);
  }
});

test("OpenCode reasoning_content is preserved for reasoning model tool continuations", async () => {
  const selected: ChatStreamScope = { provider: "opencode", model: "kimi-k3" };
  const source = delta({ reasoning_content: "Need to read the file." })
    + delta({ tool_calls: [{ index: 0, id: "r", function: { name: "Read", arguments: "{}" } }] }, "tool_calls") + "data: [DONE]\n\n";
  const accumulator = new MessageAccumulator(selected.model);
  await readChatCompletionsSse(body(source), (event) => accumulator.accept(event), selected);
  const message = BuiltMessage.parse(accumulator.buildMessage());
  const next = MessageRequest.parse({ ...basic(), messages: [{ role: "assistant", content: message.content }, { role: "user", content: [{ type: "tool_result", tool_use_id: "r", content: "file" }] }] });
  const assistant = toChatCompletionsRequest(next, selected.model, "none", undefined, selected).messages[0];
  assert.ok(assistant?.role === "assistant");
  assert.equal(assistant.reasoning_content, "Need to read the file.");
  assert.doesNotMatch(JSON.stringify(toChatCompletionsRequest(next, selected.model, "none", undefined, { ...selected, provider: "openai" })), /reasoning_content/);
  assert.doesNotMatch(JSON.stringify(toChatCompletionsRequest(next, "other", "none", undefined, { ...selected, model: "other" })), /reasoning_content/);
});
