import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type ServerResponse } from "node:http";
import {
  AnthropicStream,
  BridgeError,
  decodeReasoningSignature,
  encodeReasoningSignature,
  estimateInputTokens,
  MessageAccumulator,
  MessageRequest,
  readSse,
  toAnthropicUsage,
  toOpenAIRequest,
  unsupportedBlockTypes,
  unsupportedToolNames,
} from "./bridge.js";

test("converts Claude Code tool history and definitions to standard Responses input", () => {
  const request = MessageRequest.parse({
    model: "claude-sonnet",
    max_tokens: 1024,
    stream: true,
    system: "Work in the repository.",
    tools: [
      {
        name: "Read",
        description: "Read a file",
        input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      },
    ],
    messages: [
      { role: "user", content: "Read main.ts" },
      { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "Read", input: { path: "main.ts" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "file contents" }] },
    ],
  });
  const converted = toOpenAIRequest(request, "gpt-model");
  assert.equal(converted.model, "gpt-model");
  assert.equal(converted.store, false);
  assert.equal(converted.stream, true);
  assert.equal(converted.instructions, "Work in the repository.");
  assert.deepEqual(converted.input[1], {
    type: "function_call",
    call_id: "call_1",
    name: "Read",
    arguments: '{"path":"main.ts"}',
  });
  assert.deepEqual(converted.input[2], {
    type: "function_call_output",
    call_id: "call_1",
    output: "file contents",
  });
  assert.equal(converted.tools?.[0]?.name, "Read");
  assert.equal(converted.tools?.[0]?.description, "Read a file");
});

test("preserves previous tool calls even when tool is absent from current request tools", () => {
  const request = MessageRequest.parse({
    model: "claude-sonnet",
    max_tokens: 1024,
    messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "Bash", input: { command: "ls" } }] },
    ],
  });
  const converted = toOpenAIRequest(request, "gpt-model");
  assert.deepEqual(converted.input[0], {
    type: "function_call",
    call_id: "call_1",
    name: "Bash",
    arguments: '{"command":"ls"}',
  });
});

test("maps system and developer history to supported developer messages", () => {
  const request = MessageRequest.parse({
    model: "claude-sonnet",
    max_tokens: 1024,
    messages: [
      { role: "system", content: "Follow repository rules." },
      { role: "developer", content: "Use the Read tool." },
      { role: "user", content: "Inspect package.json" },
    ],
  });
  assert.deepEqual(toOpenAIRequest(request, "gpt-model").input, [
    { role: "developer", content: "Follow repository rules." },
    { role: "developer", content: "Use the Read tool." },
    { role: "user", content: "Inspect package.json" },
  ]);
});

test("streams a complete Anthropic tool call with validated JSON arguments", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const stream = new AnthropicStream(response, "gpt-model");
    stream.accept({ type: "response.created", response: { id: "resp_1" } });
    stream.accept({ type: "response.output_item.added", output_index: 0, item: { type: "function_call", name: "Read", call_id: "call_1" } });
    stream.accept({ type: "response.function_call_arguments.delta", output_index: 0, delta: '{"path":"main.ts"}' });
    stream.accept({ type: "response.function_call_arguments.done", output_index: 0, arguments: '{"path":"main.ts"}' });
    stream.accept({ type: "response.output_item.done", output_index: 0, item: { type: "function_call", name: "Read", call_id: "call_1", arguments: '{"path":"main.ts"}' } });
    stream.accept({ type: "response.completed", response: { id: "resp_1", usage: { output_tokens: 7 } } });
    stream.assertCompleted();
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}`);
    const events = await response.text();
    assert.match(events, /event: content_block_start\ndata: \{"type":"content_block_start","index":0,"content_block":\{"type":"tool_use","id":"call_1","name":"Read","input":\{\}\}\}/);
    assert.match(events, /"partial_json":"\{\\"path\\":\\"main.ts\\"\}"/);
    assert.match(events, /"stop_reason":"tool_use"/);
    assert.match(events, /event: message_stop/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("MessageAccumulator collects text and tool calls for non-streaming requests", () => {
  const accumulator = new MessageAccumulator("gpt-model");
  accumulator.accept({ type: "response.created", response: { id: "resp_acc_1" } });
  accumulator.accept({ type: "response.output_text.delta", delta: "Here is the result." });
  accumulator.accept({ type: "response.output_text.done" });
  accumulator.accept({
    type: "response.output_item.added",
    output_index: 0,
    item: { type: "function_call", name: "Read", call_id: "call_read_1" },
  });
  accumulator.accept({
    type: "response.function_call_arguments.delta",
    output_index: 0,
    delta: '{"path":"README.md"}',
  });
  accumulator.accept({
    type: "response.output_item.done",
    output_index: 0,
    item: { type: "function_call", name: "Read", call_id: "call_read_1" },
  });
  accumulator.accept({
    type: "response.completed",
    response: {
      id: "resp_acc_1",
      usage: { input_tokens: 15, output_tokens: 22 },
    },
  });

  const message = accumulator.buildMessage() as {
    id: string;
    type: string;
    role: string;
    model: string;
    content: Array<{ type: string; [key: string]: unknown }>;
    stop_reason: string;
    usage: { input_tokens: number; output_tokens: number };
  };

  assert.equal(message.id, "resp_acc_1");
  assert.equal(message.role, "assistant");
  assert.equal(message.model, "gpt-model");
  assert.equal(message.stop_reason, "tool_use");
  assert.equal(message.content.length, 2);
  assert.deepEqual(message.content[0], { type: "text", text: "Here is the result." });
  assert.deepEqual(message.content[1], {
    type: "tool_use",
    id: "call_read_1",
    name: "Read",
    input: { path: "README.md" },
  });
  assert.deepEqual(message.usage, { input_tokens: 15, output_tokens: 22 });
});

test("maps assistant text to output_text rather than input_text", () => {
  const request = MessageRequest.parse({
    model: "claude-sonnet",
    max_tokens: 1024,
    messages: [
      { role: "user", content: "Review code" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I will check the repository." },
          { type: "tool_use", id: "call_check", name: "Read", input: { path: "main.ts" } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_check", content: "ok" }] },
      { role: "assistant", content: "All tests pass." },
    ],
  });

  const converted = toOpenAIRequest(request, "gpt-model");
  assert.equal(converted.input.length, 5);
  assert.deepEqual(converted.input[0], { role: "user", content: "Review code" });
  assert.deepEqual(converted.input[1], {
    role: "assistant",
    content: [{ type: "output_text", text: "I will check the repository." }],
  });
  assert.deepEqual(converted.input[2], {
    type: "function_call",
    call_id: "call_check",
    name: "Read",
    arguments: '{"path":"main.ts"}',
  });
  assert.deepEqual(converted.input[3], {
    type: "function_call_output",
    call_id: "call_check",
    output: "ok",
  });
  assert.deepEqual(converted.input[4], {
    role: "assistant",
    content: [{ type: "output_text", text: "All tests pass." }],
  });
});

test("MessageAccumulator turns a refusal into an assistant text block", () => {
  const accumulator = new MessageAccumulator("gpt-model");
  accumulator.accept({ type: "response.created", response: { id: "resp_refusal_1" } });
  accumulator.accept({ type: "response.refusal.delta", delta: "Cannot fulfill request" });
  accumulator.accept({ type: "response.refusal.done" });
  accumulator.accept({ type: "response.completed", response: { id: "resp_refusal_1", usage: { input_tokens: 10, output_tokens: 5 } } });
  assert.deepEqual(accumulator.buildMessage(), {
    id: "resp_refusal_1",
    type: "message",
    role: "assistant",
    model: "gpt-model",
    content: [{ type: "text", text: "Cannot fulfill request" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  });
});

test("tool names are forwarded verbatim, including names that look like internal placeholders", () => {
  const accumulator = new MessageAccumulator("gpt-model");
  accumulator.accept({ type: "response.output_item.added", output_index: 0, item: { type: "function_call", name: "tool_1", call_id: "call_1" } });
  accumulator.accept({ type: "response.function_call_arguments.delta", delta: "{}" });
  accumulator.accept({ type: "response.output_item.done", item: { type: "function_call", name: "tool_1", call_id: "call_1" } });
  accumulator.accept({ type: "response.completed", response: { id: "resp_1" } });
  const message = accumulator.buildMessage() as { content: unknown[] };
  assert.deepEqual(message.content, [{ type: "tool_use", id: "call_1", name: "tool_1", input: {} }]);
});

test("toAnthropicUsage reports cached tokens separately from fresh input", () => {
  assert.deepEqual(toAnthropicUsage(undefined), { input_tokens: 0, output_tokens: 0 });
  assert.deepEqual(toAnthropicUsage({ input_tokens: 100, output_tokens: 7 }), { input_tokens: 100, output_tokens: 7 });
  assert.deepEqual(
    toAnthropicUsage({ input_tokens: 100, output_tokens: 7, input_tokens_details: { cached_tokens: 40 } }),
    { input_tokens: 60, output_tokens: 7, cache_read_input_tokens: 40 },
  );
  assert.deepEqual(
    toAnthropicUsage({ input_tokens: 10, output_tokens: 1, input_tokens_details: { cached_tokens: 99 } }),
    { input_tokens: 0, output_tokens: 1, cache_read_input_tokens: 10 },
  );
});

test("unknown content blocks are replaced by a visible note instead of failing validation", () => {
  const request = MessageRequest.parse({
    model: "claude-sonnet",
    messages: [
      { role: "user", content: [{ type: "text", text: "see doc" }, { type: "document", source: { type: "base64", data: "AAAA" } }] },
      { role: "assistant", content: [{ type: "server_tool_use", id: "s1", name: "web_search", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: [{ type: "tool_reference", tool_name: "X" }] }] },
    ],
  });
  assert.deepEqual(unsupportedBlockTypes(request).sort(), ["document", "server_tool_use", "tool_reference"]);
  const input = toOpenAIRequest(request, "gpt-model").input;
  assert.deepEqual(input[0], {
    role: "user",
    content: [
      { type: "input_text", text: "see doc" },
      { type: "input_text", text: '[Unsupported content block "document" omitted by Codex2CC]' },
    ],
  });
  assert.deepEqual(input[1], {
    role: "assistant",
    content: [{ type: "output_text", text: '[Unsupported content block "server_tool_use" omitted by Codex2CC]' }],
  });
  assert.deepEqual(input[2], {
    type: "function_call_output",
    call_id: "call_1",
    output: [{ type: "input_text", text: '[Unsupported content block "tool_reference" omitted by Codex2CC]' }],
  });
});

test("a known block type with an invalid shape is still rejected", () => {
  assert.throws(() => MessageRequest.parse({
    model: "claude-sonnet",
    messages: [{ role: "assistant", content: [{ type: "tool_use", name: "Read", input: {} }] }],
  }));
  assert.throws(() => MessageRequest.parse({
    model: "claude-sonnet",
    messages: [{ role: "user", content: [{ type: "text" }] }],
  }));
});

test("url image sources pass through and tools without input_schema are dropped", () => {
  const request = MessageRequest.parse({
    model: "claude-sonnet",
    tools: [
      { name: "Read", description: "Read a file", input_schema: { type: "object" } },
      { type: "web_search_20250305", name: "web_search", max_uses: 3 },
    ],
    messages: [{ role: "user", content: [{ type: "image", source: { type: "url", url: "https://example.com/a.png" } }] }],
  });
  const converted = toOpenAIRequest(request, "gpt-model");
  assert.deepEqual(converted.input[0], { role: "user", content: [{ type: "input_image", image_url: "https://example.com/a.png" }] });
  assert.deepEqual(converted.tools?.map((tool) => tool.name), ["Read"]);
  assert.deepEqual(unsupportedToolNames(request), ["web_search"]);
});

test("estimateInputTokens approximates four characters per token plus a fixed cost per image", () => {
  const text = MessageRequest.parse({ model: "m", system: "abcd", messages: [{ role: "user", content: "abcdefgh" }] });
  assert.equal(estimateInputTokens(text), 3);
  const withImage = MessageRequest.parse({
    model: "m",
    messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "x".repeat(50_000) } }] }],
  });
  assert.equal(estimateInputTokens(withImage), 1_500);
  const withTool = MessageRequest.parse({
    model: "m",
    tools: [{ name: "Read", description: "abcd", input_schema: { type: "object" } }],
    messages: [{ role: "assistant", content: [{ type: "tool_use", id: "c", name: "Read", input: { a: 1 } }] }],
  });
  assert.equal(estimateInputTokens(withTool), Math.ceil((4 + 4 + 17 + 4 + 7) / 4));
});

test("AnthropicStream reports usage from the completed event and the estimate at message_start", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const stream = new AnthropicStream(response, "gpt-model", 42);
    stream.accept({ type: "response.created", response: { id: "resp_1" } });
    stream.accept({ type: "response.output_text.delta", delta: "ok" });
    stream.accept({ type: "response.completed", response: { id: "resp_1", usage: { input_tokens: 100, output_tokens: 7, input_tokens_details: { cached_tokens: 40 } } } });
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const events = await (await fetch(`http://127.0.0.1:${address.port}`)).text();
    assert.match(events, /event: message_start\ndata: .*"usage":\{"input_tokens":42,"output_tokens":0\}/);
    assert.match(events, /event: message_delta\ndata: .*"usage":\{"input_tokens":60,"output_tokens":7,"cache_read_input_tokens":40\}/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

type SseEvent = { event: string; data: Record<string, unknown> };

function captureStream(estimatedInputTokens = 0): { stream: AnthropicStream; events: () => SseEvent[] } {
  const writes: string[] = [];
  const response = { write: (chunk: string): boolean => { writes.push(chunk); return true; } } as unknown as ServerResponse;
  return {
    stream: new AnthropicStream(response, "gpt-model", estimatedInputTokens),
    events: () => writes.map((chunk) => {
      const match = /^event: (.+)\ndata: (.+)\n\n$/s.exec(chunk);
      assert.ok(match, `unexpected SSE frame: ${chunk}`);
      return { event: match[1]!, data: JSON.parse(match[2]!) as Record<string, unknown> };
    }),
  };
}

function sseStream(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collectEvents(...chunks: string[]): Promise<Array<{ type: string }>> {
  const received: Array<{ type: string }> = [];
  await readSse(sseStream(...chunks), (event) => received.push(event));
  return received;
}

async function rejectsWithBridgeCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => error instanceof BridgeError && error.status === 502 && error.code === code);
}

test("readSse reassembles frames split across chunks and accepts CRLF line endings", async () => {
  const events = await collectEvents('data: {"type":"a"}\r\n\r\nda', 'ta: {"type":"b"}\n', '\ndata: {"type":"c"}\n\n');
  assert.deepEqual(events.map((event) => event.type), ["a", "b", "c"]);
});

test("readSse ignores comments, event names and the [DONE] sentinel, and joins multi-line data", async () => {
  const events = await collectEvents(
    ': keep-alive\n\n',
    'event: response.created\ndata: {"type":"created"}\n\n',
    'data: {"type":\ndata: "multi"}\n\n',
    'data: [DONE]\n\n',
  );
  assert.deepEqual(events.map((event) => event.type), ["created", "multi"]);
});

test("readSse reports malformed JSON, events without a type, and a truncated final frame", async () => {
  await rejectsWithBridgeCode(collectEvents("data: {not json}\n\n"), "invalid_upstream_json");
  await rejectsWithBridgeCode(collectEvents('data: {"no":"type"}\n\n'), "invalid_upstream_event");
  await rejectsWithBridgeCode(collectEvents('data: {"type":"a"}\n\ndata: {"type":"cut'), "truncated_upstream_event");
});

test("tool_choice maps to the Responses API values", () => {
  const convert = (toolChoice: object | undefined) => toOpenAIRequest(MessageRequest.parse({
    model: "m",
    messages: [{ role: "user", content: "hi" }],
    ...(toolChoice ? { tool_choice: toolChoice } : {}),
  }), "gpt-model").tool_choice;
  assert.equal(convert(undefined), undefined);
  assert.equal(convert({ type: "none" }), "none");
  assert.equal(convert({ type: "any" }), "required");
  assert.equal(convert({ type: "auto" }), "auto");
  assert.deepEqual(convert({ type: "tool", name: "Read" }), { type: "function", name: "Read" });
});

test("images: user and tool_result images are forwarded, assistant images are rejected", () => {
  const png = { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } };
  const converted = toOpenAIRequest(MessageRequest.parse({
    model: "m",
    messages: [
      { role: "user", content: [{ type: "text", text: "look" }, png] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: [{ type: "text", text: "shot" }, png] }] },
    ],
  }), "gpt-model");
  assert.deepEqual(converted.input[0], {
    role: "user",
    content: [{ type: "input_text", text: "look" }, { type: "input_image", image_url: "data:image/png;base64,QUJD" }],
  });
  assert.deepEqual(converted.input[1], {
    type: "function_call_output",
    call_id: "c1",
    output: [{ type: "input_text", text: "shot" }, { type: "input_image", image_url: "data:image/png;base64,QUJD" }],
  });
  assert.throws(
    () => toOpenAIRequest(MessageRequest.parse({ model: "m", messages: [{ role: "assistant", content: [png] }] }), "gpt-model"),
    (error: unknown) => error instanceof BridgeError && error.code === "unsupported_image",
  );
});

test("tool errors, array system prompts and misplaced tool blocks are handled explicitly", () => {
  const converted = toOpenAIRequest(MessageRequest.parse({
    model: "m",
    system: [{ type: "text", text: "Rule one." }, { type: "text", text: "Rule two." }],
    messages: [
      { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "boom", is_error: true }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "c2", is_error: true }] },
    ],
  }), "gpt-model");
  assert.equal(converted.instructions, "Rule one.\n\nRule two.");
  assert.deepEqual(converted.input, [
    { type: "function_call_output", call_id: "c1", output: "Tool error: boom" },
    { type: "function_call_output", call_id: "c2", output: "Tool error." },
  ]);
  const invalidRole = (message: object): unknown => toOpenAIRequest(MessageRequest.parse({ model: "m", messages: [message] }), "gpt-model");
  assert.throws(() => invalidRole({ role: "assistant", content: [{ type: "tool_result", tool_use_id: "c", content: "x" }] }),
    (error: unknown) => error instanceof BridgeError && error.code === "invalid_tool_role");
  assert.throws(() => invalidRole({ role: "user", content: [{ type: "tool_use", id: "c", name: "Read", input: {} }] }),
    (error: unknown) => error instanceof BridgeError && error.code === "invalid_tool_role");
});

test("AnthropicStream keeps interleaved parallel tool calls on separate content blocks", () => {
  const { stream, events } = captureStream();
  stream.accept({ type: "response.created", response: { id: "resp_1" } });
  stream.accept({ type: "response.output_item.added", output_index: 0, item: { type: "function_call", name: "Read", call_id: "call_a" } });
  stream.accept({ type: "response.output_item.added", output_index: 1, item: { type: "function_call", name: "Grep", call_id: "call_b" } });
  stream.accept({ type: "response.function_call_arguments.delta", output_index: 1, delta: '{"p":' });
  stream.accept({ type: "response.function_call_arguments.delta", output_index: 0, delta: '{"path":"a"}' });
  stream.accept({ type: "response.function_call_arguments.delta", output_index: 1, delta: '"x"}' });
  stream.accept({ type: "response.function_call_arguments.done", output_index: 0, arguments: '{"path":"a"}' });
  stream.accept({ type: "response.output_item.done", output_index: 0, item: { type: "function_call", name: "Read", call_id: "call_a" } });
  stream.accept({ type: "response.output_item.done", output_index: 1, item: { type: "function_call", name: "Grep", call_id: "call_b" } });
  stream.accept({ type: "response.completed", response: { id: "resp_1" } });
  stream.assertCompleted();

  const all = events();
  const starts = all.filter((e) => e.event === "content_block_start").map((e) => ({ index: e.data.index, block: e.data.content_block }));
  assert.deepEqual(starts, [
    { index: 0, block: { type: "tool_use", id: "call_a", name: "Read", input: {} } },
    { index: 1, block: { type: "tool_use", id: "call_b", name: "Grep", input: {} } },
  ]);
  const jsonFor = (index: number): string => all
    .filter((e) => e.event === "content_block_delta" && e.data.index === index)
    .map((e) => (e.data.delta as { partial_json: string }).partial_json).join("");
  assert.equal(jsonFor(0), '{"path":"a"}', "done event must not duplicate already streamed arguments");
  assert.equal(jsonFor(1), '{"p":"x"}');
  assert.deepEqual(all.filter((e) => e.event === "content_block_stop").map((e) => e.data.index), [0, 1]);
  assert.equal((all.find((e) => e.event === "message_delta")!.data.delta as { stop_reason: string }).stop_reason, "tool_use");
  assert.equal(all.at(-1)!.event, "message_stop");
});

test("AnthropicStream closes a text block before starting a tool call and backfills arguments from the done event", () => {
  const { stream, events } = captureStream();
  stream.accept({ type: "response.created", response: { id: "resp_1" } });
  stream.accept({ type: "response.output_text.delta", delta: "Let me look." });
  stream.accept({ type: "response.output_item.added", output_index: 1, item: { type: "function_call", name: "Read", call_id: "call_a" } });
  stream.accept({ type: "response.function_call_arguments.done", output_index: 1, arguments: '{"path":"a"}' });
  stream.accept({ type: "response.output_item.done", output_index: 1, item: { type: "function_call", name: "Read", call_id: "call_a" } });
  stream.accept({ type: "response.completed", response: { id: "resp_1" } });
  const sequence = events().map((e) => `${e.event}${e.data.index === undefined ? "" : `#${e.data.index}`}`);
  assert.deepEqual(sequence, [
    "message_start", "content_block_start#0", "content_block_delta#0", "content_block_stop#0",
    "content_block_start#1", "content_block_delta#1", "content_block_stop#1", "message_delta", "message_stop",
  ]);
});

test("AnthropicStream emits an empty text block when the response has no content, and throws on upstream failure", () => {
  const empty = captureStream();
  empty.stream.accept({ type: "response.created", response: { id: "resp_1" } });
  empty.stream.accept({ type: "response.completed", response: { id: "resp_1" } });
  assert.deepEqual(empty.events().map((e) => e.event), ["message_start", "content_block_start", "content_block_stop", "message_delta", "message_stop"]);

  const failing = captureStream();
  assert.throws(
    () => failing.stream.accept({ type: "response.failed", response: { error: { code: "rate_limit_exceeded", message: "slow down" } } }),
    (error: unknown) => error instanceof BridgeError && error.code === "rate_limit_exceeded" && error.message === "slow down",
  );
  assert.throws(() => failing.stream.assertCompleted(), (error: unknown) => error instanceof BridgeError && error.code === "upstream_truncated");
});

test("MessageAccumulator returns every parallel tool call and rejects malformed arguments", () => {
  const accumulator = new MessageAccumulator("gpt-model");
  accumulator.accept({ type: "response.output_item.added", output_index: 0, item: { type: "function_call", name: "Read", call_id: "call_a" } });
  accumulator.accept({ type: "response.output_item.added", output_index: 1, item: { type: "function_call", name: "Grep", call_id: "call_b" } });
  accumulator.accept({ type: "response.function_call_arguments.delta", output_index: 1, delta: '{"p":"b"}' });
  accumulator.accept({ type: "response.function_call_arguments.delta", output_index: 0, delta: '{"path":"a"}' });
  accumulator.accept({ type: "response.output_item.done", output_index: 0, item: { type: "function_call", name: "Read", call_id: "call_a" } });
  accumulator.accept({ type: "response.output_item.done", output_index: 1, item: { type: "function_call", name: "Grep", call_id: "call_b" } });
  accumulator.accept({ type: "response.completed", response: { id: "resp_1" } });
  const message = accumulator.buildMessage() as { content: unknown[]; stop_reason: string };
  assert.deepEqual(message.content, [
    { type: "tool_use", id: "call_a", name: "Read", input: { path: "a" } },
    { type: "tool_use", id: "call_b", name: "Grep", input: { p: "b" } },
  ]);
  assert.equal(message.stop_reason, "tool_use");

  const malformed = new MessageAccumulator("gpt-model");
  malformed.accept({ type: "response.output_item.added", output_index: 0, item: { type: "function_call", name: "Bash", call_id: "call_c" } });
  malformed.accept({ type: "response.function_call_arguments.delta", output_index: 0, delta: '{"command": "rm -' });
  malformed.accept({ type: "response.output_item.done", output_index: 0, item: { type: "function_call", name: "Bash", call_id: "call_c" } });
  assert.throws(
    () => malformed.accept({ type: "response.completed", response: { id: "resp_1" } }),
    (error: unknown) => error instanceof BridgeError && error.code === "invalid_tool_arguments" && error.status === 502,
    "a completed response with unparseable arguments is an upstream defect",
  );
});

test("a tool call cut off by the output limit ends with max_tokens and is never returned for execution", () => {
  const accumulator = new MessageAccumulator("gpt-model");
  accumulator.accept({ type: "response.output_text.delta", delta: "Running it." });
  accumulator.accept({ type: "response.output_text.done" });
  accumulator.accept({ type: "response.output_item.added", output_index: 1, item: { type: "function_call", name: "Bash", call_id: "call_cut" } });
  accumulator.accept({ type: "response.function_call_arguments.delta", output_index: 1, delta: '{"command": "rm -' });
  accumulator.accept({ type: "response.output_item.done", output_index: 1, item: { type: "function_call", name: "Bash", call_id: "call_cut" } });
  accumulator.accept({ type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" }, usage: { input_tokens: 4, output_tokens: 64 } } });
  accumulator.assertCompleted();
  const message = accumulator.buildMessage() as { content: unknown[]; stop_reason: string; usage: unknown };
  assert.equal(message.stop_reason, "max_tokens");
  assert.deepEqual(message.content, [{ type: "text", text: "Running it." }]);
  assert.deepEqual(message.usage, { input_tokens: 4, output_tokens: 64 });

  const filtered = new MessageAccumulator("gpt-model");
  filtered.accept({ type: "response.output_item.added", output_index: 0, item: { type: "function_call", name: "Bash", call_id: "call_f" } });
  filtered.accept({ type: "response.function_call_arguments.delta", output_index: 0, delta: "{bad" });
  filtered.accept({ type: "response.output_item.done", output_index: 0, item: { type: "function_call", name: "Bash", call_id: "call_f" } });
  assert.throws(
    () => filtered.accept({ type: "response.incomplete", response: { incomplete_details: { reason: "content_filter" } } }),
    (error: unknown) => error instanceof BridgeError && error.code === "invalid_tool_arguments",
    "only the output limit excuses unparseable arguments",
  );
});

test("toOpenAIRequest translates output_config.effort and reasoning_effort into reasoning object", () => {
  const req1 = MessageRequest.parse({
    model: "claude-3-7-sonnet-20250219",
    messages: [{ role: "user", content: "hello" }],
    output_config: { effort: "high" },
  });
  const converted1 = toOpenAIRequest(req1, "gpt-6.1-sol");
  assert.deepEqual(converted1.reasoning, { effort: "high", summary: "auto" });

  const req2 = MessageRequest.parse({
    model: "claude-3-7-sonnet-20250219",
    messages: [{ role: "user", content: "solve this" }],
    output_config: { effort: "max" },
  });
  const converted2 = toOpenAIRequest(req2, "gpt-6.1-sol");
  assert.deepEqual(converted2.reasoning, { effort: "max", summary: "auto" });

  const req3 = MessageRequest.parse({
    model: "claude-3-7-sonnet-20250219",
    messages: [{ role: "user", content: "simple task" }],
    reasoning_effort: "low",
  });
  const converted3 = toOpenAIRequest(req3, "gpt-6-sol");
  assert.deepEqual(converted3.reasoning, { effort: "low", summary: "auto" });

  assert.throws(() => MessageRequest.parse({
    model: "claude-sonnet-5-5",
    messages: [{ role: "user", content: "hello" }],
    output_config: { effort: "invalid" },
  }));
});

test("non-streaming upstream failures and truncation raise instead of returning an empty message", () => {
  const failed = new MessageAccumulator("gpt-model");
  failed.accept({ type: "response.created", response: { id: "resp_1" } });
  assert.throws(
    () => failed.accept({ type: "response.failed", response: { error: { code: "server_error", message: "boom" } } }),
    (error: unknown) => error instanceof BridgeError && error.status === 502 && error.code === "server_error",
  );
  const bareError = new MessageAccumulator("gpt-model");
  assert.throws(
    () => bareError.accept({ type: "error", code: "rate_limit_exceeded", message: "slow down" }),
    (error: unknown) => error instanceof BridgeError && error.status === 429 && error.message === "slow down",
  );
  const truncated = new MessageAccumulator("gpt-model");
  truncated.accept({ type: "response.output_text.delta", delta: "partial" });
  assert.throws(() => truncated.assertCompleted(), (error: unknown) => error instanceof BridgeError && error.code === "upstream_truncated");
});

test("response.incomplete at the output limit ends with stop_reason max_tokens in both modes", () => {
  const incomplete = { type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" }, usage: { input_tokens: 5, output_tokens: 9 } } };
  const { stream, events } = captureStream();
  stream.accept({ type: "response.created", response: { id: "resp_1" } });
  stream.accept({ type: "response.output_text.delta", delta: "half an ans" });
  stream.accept(incomplete);
  stream.assertCompleted();
  const delta = events().find((e) => e.event === "message_delta");
  assert.deepEqual((delta?.data as { delta: unknown }).delta, { stop_reason: "max_tokens", stop_sequence: null });

  const accumulator = new MessageAccumulator("gpt-model");
  accumulator.accept({ type: "response.output_text.delta", delta: "half an ans" });
  accumulator.accept(incomplete);
  accumulator.assertCompleted();
  const message = accumulator.buildMessage() as { content: unknown[]; stop_reason: string; usage: unknown };
  assert.equal(message.stop_reason, "max_tokens");
  assert.deepEqual(message.content, [{ type: "text", text: "half an ans" }]);
  assert.deepEqual(message.usage, { input_tokens: 5, output_tokens: 9 });

  assert.throws(
    () => captureStream().stream.accept({ type: "response.incomplete", response: { incomplete_details: { reason: "something_new" } } }),
    (error: unknown) => error instanceof BridgeError && error.code === "upstream_incomplete" && /something_new/.test(error.message),
  );
});

test("AnthropicStream holds message_start until content and keepAlive emits pings after it", () => {
  const { stream, events } = captureStream();
  stream.accept({ type: "response.created", response: { id: "resp_9" } });
  assert.deepEqual(events(), [], "nothing is written before the first content or ping");
  stream.keepAlive();
  stream.keepAlive();
  assert.deepEqual(events().map((e) => e.event), ["message_start", "ping", "ping"]);
  assert.equal((events()[0]!.data as { message: { id: string } }).message.id, "resp_9");
  stream.accept({ type: "response.completed", response: { id: "resp_9" } });
  stream.keepAlive();
  assert.equal(events().filter((e) => e.event === "ping").length, 2, "no ping after message_stop");
});

test("Codex reasoning streams as a thinking block whose signature carries the encrypted content", () => {
  const { stream, events } = captureStream();
  stream.accept({ type: "response.created", response: { id: "resp_1" } });
  stream.accept({ type: "response.output_item.added", output_index: 0, item: { type: "reasoning" } });
  stream.accept({ type: "response.reasoning_summary_text.delta", output_index: 0, summary_index: 0, delta: "Plan the " });
  stream.accept({ type: "response.reasoning_summary_text.delta", output_index: 0, summary_index: 0, delta: "edit." });
  stream.accept({ type: "response.reasoning_summary_text.delta", output_index: 0, summary_index: 1, delta: "Then test." });
  stream.accept({ type: "response.output_item.done", output_index: 0, item: { type: "reasoning", encrypted_content: "gAAAA-enc-1", summary: [] } });
  stream.accept({ type: "response.output_item.done", output_index: 1, item: { type: "reasoning", encrypted_content: "gAAAA-enc-2", summary: [] } });
  stream.accept({ type: "response.output_text.delta", delta: "Done." });
  stream.accept({ type: "response.completed", response: { id: "resp_1" } });

  const frames = events();
  const signature = encodeReasoningSignature("gpt-model", "gAAAA-enc-1");
  assert.deepEqual(frames.map((e) => `${e.event}#${String((e.data as { index?: number }).index ?? "")}`), [
    "message_start#", "content_block_start#0", "content_block_delta#0", "content_block_delta#0", "content_block_delta#0",
    "content_block_delta#0", "content_block_delta#0", "content_block_stop#0",
    "content_block_start#1", "content_block_stop#1",
    "content_block_start#2", "content_block_delta#2", "content_block_stop#2", "message_delta#", "message_stop#",
  ]);
  assert.deepEqual((frames[1]!.data as { content_block: unknown }).content_block, { type: "thinking", thinking: "", signature: "" });
  const thinking = frames.slice(2, 6).map((e) => (e.data as { delta: { thinking: string } }).delta.thinking).join("");
  assert.equal(thinking, "Plan the edit.\n\nThen test.");
  assert.deepEqual((frames[6]!.data as { delta: unknown }).delta, { type: "signature_delta", signature });
  assert.deepEqual((frames[8]!.data as { content_block: unknown }).content_block, {
    type: "redacted_thinking",
    data: encodeReasoningSignature("gpt-model", "gAAAA-enc-2"),
  });
});

test("MessageAccumulator keeps reasoning as thinking or redacted_thinking blocks in order", () => {
  const accumulator = new MessageAccumulator("gpt-model");
  accumulator.accept({ type: "response.output_item.done", output_index: 0, item: { type: "reasoning", encrypted_content: "enc-a", summary: [{ type: "summary_text", text: "Look first." }] } });
  accumulator.accept({ type: "response.output_item.done", output_index: 1, item: { type: "reasoning", encrypted_content: "enc-b", summary: [] } });
  accumulator.accept({ type: "response.output_item.done", output_index: 2, item: { type: "reasoning", summary: [{ type: "summary_text", text: "no content" }] } });
  accumulator.accept({ type: "response.output_text.delta", delta: "Answer" });
  accumulator.accept({ type: "response.completed", response: { id: "resp_1" } });
  assert.deepEqual((accumulator.buildMessage() as { content: unknown[] }).content, [
    { type: "thinking", thinking: "Look first.", signature: encodeReasoningSignature("gpt-model", "enc-a") },
    { type: "redacted_thinking", data: encodeReasoningSignature("gpt-model", "enc-b") },
    { type: "text", text: "Answer" },
  ]);
});

test("toOpenAIRequest replays only reasoning this gateway issued for the same model", () => {
  assert.equal(decodeReasoningSignature(encodeReasoningSignature("gpt-6-sol", "enc"), "gpt-6-sol"), "enc");
  assert.equal(decodeReasoningSignature(encodeReasoningSignature("gpt-6-sol", "enc"), "gpt-6-luna"), undefined);
  assert.equal(decodeReasoningSignature("EqQBCkgIBhABGAIiQ...anthropic", "gpt-6-sol"), undefined);

  const request = MessageRequest.parse({
    model: "claude-sonnet-5-5",
    messages: [
      { role: "user", content: "fix it" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Read the file.", signature: encodeReasoningSignature("gpt-6-sol", "enc-1") },
          { type: "redacted_thinking", data: encodeReasoningSignature("gpt-6-sol", "enc-2") },
          { type: "thinking", thinking: "real Claude thought", signature: "anthropic-signature" },
          { type: "thinking", thinking: "other model", signature: encodeReasoningSignature("gpt-6-luna", "enc-3") },
          { type: "text", text: "Reading." },
          { type: "tool_use", id: "call_1", name: "Read", input: { path: "a" } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "ok" }] },
    ],
  });
  const converted = toOpenAIRequest(request, "gpt-6-sol");
  assert.deepEqual(converted.include, ["reasoning.encrypted_content"]);
  assert.deepEqual(converted.reasoning, { summary: "auto" });
  assert.deepEqual(converted.input.slice(1), [
    { type: "reasoning", summary: [{ type: "summary_text", text: "Read the file." }], encrypted_content: "enc-1" },
    { type: "reasoning", summary: [], encrypted_content: "enc-2" },
    { role: "assistant", content: [{ type: "output_text", text: "Reading." }] },
    { type: "function_call", call_id: "call_1", name: "Read", arguments: '{"path":"a"}' },
    { type: "function_call_output", call_id: "call_1", output: "ok" },
  ]);

  const disabled = toOpenAIRequest(MessageRequest.parse({ model: "m", messages: [{ role: "user", content: "hi" }], thinking: { type: "disabled" } }), "gpt-6-sol");
  assert.equal(disabled.reasoning, undefined);
});

test("parallel tool calls follow Anthropic's disable_parallel_tool_use and need tools", () => {
  const tools = [{ name: "Read", description: "", input_schema: { type: "object" } }];
  const base = { model: "m", messages: [{ role: "user", content: "hi" }] };
  assert.equal(toOpenAIRequest(MessageRequest.parse({ ...base, tools }), "g").parallel_tool_calls, true);
  assert.equal(toOpenAIRequest(MessageRequest.parse({ ...base, tools, tool_choice: { type: "auto", disable_parallel_tool_use: true } }), "g").parallel_tool_calls, false);
  assert.equal(toOpenAIRequest(MessageRequest.parse({ ...base, tools, tool_choice: { type: "none" } }), "g").parallel_tool_calls, undefined);
  assert.equal(toOpenAIRequest(MessageRequest.parse(base), "g").parallel_tool_calls, undefined);
});
