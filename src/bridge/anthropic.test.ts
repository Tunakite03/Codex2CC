import assert from "node:assert/strict";
import test from "node:test";
import { BridgeError, MessageAccumulator, MessageRequest, type OpenAIEvent } from "./bridge.js";
import { readAnthropicSse, toAnthropicRequest } from "./anthropic.js";
import { decodeProviderReasoning, encodeProviderReasoning } from "../providers/reasoning.js";

const MODEL = "claude-sonnet-4-6";
const scope = { provider: "opencode" as const, protocol: "anthropic-messages" as const, model: MODEL };
function stream(events: readonly object[]): ReadableStream<Uint8Array> {
  const encoded = new TextEncoder().encode(events.map((event) => `event: ignored\r\ndata: ${JSON.stringify(event)}\r\n\r\n`).join(""));
  return new ReadableStream({ start(controller) { for (let i = 0; i < encoded.length; i += 7) controller.enqueue(encoded.subarray(i, i + 7)); controller.close(); } });
}
const start = { type: "message_start", message: { id: "native-id", usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 5, cache_creation_input_tokens: 2 } } };
const end = [{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } }, { type: "message_stop" }];

test("native Messages converts text, images, tools and results without arbitrary request properties", () => {
  const request = MessageRequest.parse({ model: "claude-sonnet", max_tokens: 100, system: "brief", temperature: 0.1,
    tools: [{ name: "read", description: "read", input_schema: { type: "object", properties: { path: { type: "string" } } } }],
    tool_choice: { type: "auto", disable_parallel_tool_use: true },
    messages: [
      { role: "developer", content: "system addition" },
      { role: "assistant", content: [{ type: "tool_use", id: "call-1", name: "read", input: { path: "a" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "missing", is_error: true }, { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } }] },
    ],
  });
  const outgoing = toAnthropicRequest(request, "opencode", MODEL, "high") as { model: string; max_tokens: number; system: string; messages: object[]; tool_choice: object; output_config: object; temperature?: number };
  assert.equal(outgoing.model, MODEL);
  assert.equal(outgoing.max_tokens, 100);
  assert.equal(outgoing.system, "brief\n\nsystem addition");
  assert.equal(outgoing.messages.length, 2);
  assert.deepEqual(outgoing.tool_choice, { type: "auto", disable_parallel_tool_use: true });
  assert.deepEqual(outgoing.output_config, { effort: "high" });
  assert.equal(outgoing.temperature, undefined);
  assert.match(JSON.stringify(outgoing.messages), /"is_error":true/);
});

test("native reasoning is replayed only for the same provider, protocol and model", () => {
  const signature = encodeProviderReasoning(scope, "opaque-native-signature");
  const request = MessageRequest.parse({ model: MODEL, messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "summary", signature }, { type: "text", text: "answer" }] }, { role: "user", content: "continue" }] });
  assert.match(JSON.stringify(toAnthropicRequest(request, "opencode", MODEL, undefined)), /opaque-native-signature/);
  assert.doesNotMatch(JSON.stringify(toAnthropicRequest(request, "openai", MODEL, undefined)), /opaque-native-signature/);
  assert.doesNotMatch(JSON.stringify(toAnthropicRequest(request, "opencode", "other-model", undefined)), /opaque-native-signature/);
  assert.equal(decodeProviderReasoning({ ...scope, protocol: "responses" }, signature), undefined);
});

test("native request rejects invalid tool roles, tool schemas and thinking budgets", () => {
  const request = MessageRequest.parse({ model: MODEL, max_tokens: 2048, messages: [{ role: "user", content: "hi" }], thinking: { type: "enabled", budget_tokens: 2048 } });
  assert.throws(() => toAnthropicRequest(request, "opencode", MODEL, undefined), (error: unknown) => error instanceof BridgeError && error.code === "invalid_thinking");
  const invalidRole = MessageRequest.parse({ model: MODEL, messages: [{ role: "user", content: [{ type: "tool_use", id: "a", name: "tool", input: {} }] }] });
  assert.throws(() => toAnthropicRequest(invalidRole, "opencode", MODEL, undefined), BridgeError);
  const invalidSchema = MessageRequest.parse({ model: MODEL, messages: [{ role: "user", content: "hi" }], tools: [{ name: "bad", input_schema: "bad" }] });
  assert.throws(() => toAnthropicRequest(invalidSchema, "opencode", MODEL, undefined), BridgeError);
});

test("native SSE handles UTF-8 chunks, text and cached token accounting", async () => {
  const accumulator = new MessageAccumulator(MODEL);
  await readAnthropicSse(stream([start, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Chào bạn 👋" } }, { type: "content_block_stop", index: 0 }, ...end]), (event) => accumulator.accept(event), "opencode", MODEL);
  accumulator.assertCompleted();
  const message = accumulator.buildMessage() as { id: string; content: object[]; stop_reason: string };
  assert.equal(message.id, "native-id");
  assert.deepEqual(message.content, [{ type: "text", text: "Chào bạn 👋" }]);
  assert.equal(message.stop_reason, "end_turn");
  assert.deepEqual(accumulator.getUsage(), { input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 5 });
});

test("native tool arguments and signed thinking survive a full stream round trip", async () => {
  const accumulator = new MessageAccumulator(MODEL);
  const events = [start,
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Need a tool" } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "native-proof" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "call-1", name: "read", input: {} } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path":' } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"test"}' } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 8 } },
    { type: "message_stop" },
  ];
  await readAnthropicSse(stream(events), (event) => accumulator.accept(event), "opencode", MODEL);
  const message = accumulator.buildMessage() as { content: Array<{ type: string; signature?: string; input?: object }>; stop_reason: string };
  assert.equal(message.stop_reason, "tool_use");
  assert.equal(decodeProviderReasoning(scope, message.content[0]?.signature), "native-proof");
  assert.deepEqual(message.content[1]?.input, { path: "test" });
});

test("native output limits and refusal produce Anthropic stop reasons", async () => {
  for (const reason of ["max_tokens", "refusal"] as const) {
    const accumulator = new MessageAccumulator(MODEL);
    await readAnthropicSse(stream([start, { type: "message_delta", delta: { stop_reason: reason }, usage: { output_tokens: 1 } }, { type: "message_stop" }]), (event) => accumulator.accept(event), "opencode", MODEL);
    assert.equal((accumulator.buildMessage() as { stop_reason: string }).stop_reason, reason);
  }
});

test("native malformed, failed, unsupported and unfinished streams never report success", async () => {
  for (const events of [
    [start],
    [start, { type: "message_stop" }],
    [start, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "bad" } }],
    [start, { type: "error", error: { type: "rate_limit_error", message: "quota" } }],
    [start, { type: "message_delta", delta: { stop_reason: "pause_turn" } }, { type: "message_stop" }],
    [{ type: "content_block_start", index: 0, content_block: { type: "text", text: "bad" } }],
  ]) {
    const emitted: OpenAIEvent[] = [];
    await assert.rejects(readAnthropicSse(stream(events), (event) => emitted.push(event), "opencode", MODEL), BridgeError);
    assert.ok(!emitted.some((event) => event.type === "response.completed"));
  }
});

test("native effort maps cross-provider maximum levels to the common high level", () => {
  const request = MessageRequest.parse({ model: MODEL, messages: [{ role: "user", content: "hi" }], output_config: { effort: "max" } });
  const result = toAnthropicRequest(request, "opencode", MODEL, undefined) as { output_config: { effort: string } };
  assert.equal(result.output_config.effort, "high");
});
