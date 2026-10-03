import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import {
  AnthropicStream,
  completedMessage,
  estimateInputTokens,
  MessageAccumulator,
  MessageRequest,
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

test("maps a completed OpenAI function call to Anthropic tool_use", () => {
  const message = completedMessage({
    type: "response.completed",
    response: {
      id: "resp_1",
      usage: { input_tokens: 10, output_tokens: 5 },
      output: [{ type: "function_call", name: "Read", call_id: "call_1", arguments: '{"path":"main.ts"}' }],
    },
  }, "gpt-model", ["Read"]);
  assert.deepEqual(message, {
    id: "resp_1",
    type: "message",
    role: "assistant",
    model: "gpt-model",
    content: [{ type: "tool_use", id: "call_1", name: "Read", input: { path: "main.ts" } }],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  });
});

test("streams a complete Anthropic tool call with validated JSON arguments", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const stream = new AnthropicStream(response, "gpt-model", ["Read"]);
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
  const accumulator = new MessageAccumulator("gpt-model", ["Read"]);
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

test("maps completed refusal event to Anthropic assistant text block", () => {
  const message = completedMessage({
    type: "response.completed",
    response: {
      id: "resp_refusal_1",
      usage: { input_tokens: 10, output_tokens: 5 },
      output: [{ type: "message", content: [{ type: "refusal", refusal: "Cannot fulfill request" }] }],
    },
  }, "gpt-model", []);
  assert.deepEqual(message, {
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
    const stream = new AnthropicStream(response, "gpt-model", [], 42);
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
