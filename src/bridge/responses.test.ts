import assert from "node:assert/strict";
import test from "node:test";
import { encodeReasoningSignature, MessageAccumulator, MessageRequest } from "./bridge.js";
import { readResponsesSse, toResponsesRequest } from "./responses.js";
import { defaultApiProviderConfig } from "../providers/config.js";
import { decodeProviderReasoning, encodeProviderReasoning } from "../providers/reasoning.js";

const model = defaultApiProviderConfig("openai").models[0]!;
const scope = { provider: "openai" as const, protocol: "responses" as const, model: model.slug };

test("public Responses honors output limits and explicit reasoning without Codex defaults", () => {
  const request = MessageRequest.parse({ model: "claude-sonnet", max_tokens: 256, thinking: { type: "disabled" }, messages: [{ role: "user", content: "hi" }], tools: [{ name: "read", input_schema: { type: "object", properties: { optional: { type: "string" } } } }] });
  const outgoing = toResponsesRequest(request, "openai", model, "max") as { max_output_tokens: number; reasoning?: object; tools: Array<{ strict: boolean }>; include?: string[] };
  assert.equal(outgoing.max_output_tokens, 256);
  assert.deepEqual(outgoing.reasoning, { effort: "xhigh" });
  assert.equal(outgoing.tools[0]?.strict, false);
  const ordinary = toResponsesRequest(request, "openai", { ...model, reasoning: "none" }, "high");
  assert.equal("reasoning" in ordinary, false);
  assert.equal("include" in ordinary, false);
});

test("public Responses drops Codex or other-provider reasoning and replays only its own state", () => {
  const encrypted = "opaque-encrypted";
  for (const [signature, expected] of [
    [encodeReasoningSignature(model.slug, encrypted), false],
    [encodeProviderReasoning({ ...scope, provider: "opencode" }, encrypted), false],
    [encodeProviderReasoning(scope, encrypted), true],
  ] as const) {
    const request = MessageRequest.parse({ model: model.slug, messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "summary", signature }, { type: "text", text: "answer" }] }, { role: "user", content: "continue" }] });
    const outgoing = JSON.stringify(toResponsesRequest(request, "openai", model, undefined));
    assert.equal(outgoing.includes(encrypted), expected);
  }
});

test("public Responses normalizes nullable metadata and scopes encrypted reasoning", async () => {
  const events = [
    { type: "response.created", response: { id: "api-response", error: null, incomplete_details: null } },
    { type: "response.output_item.done", item: { type: "reasoning", summary: [{ type: "summary_text", text: "summary" }], encrypted_content: "encrypted" } },
    { type: "response.output_text.delta", delta: "answer" },
    { type: "response.completed", response: { usage: { input_tokens: 12, output_tokens: 3 } } },
  ];
  const body = new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")).body!;
  const accumulator = new MessageAccumulator(model.slug);
  await readResponsesSse(body, (event) => accumulator.accept(event), "openai", model.slug);
  const result = accumulator.buildMessage() as { content: Array<{ signature?: string }> };
  assert.equal(decodeProviderReasoning(scope, result.content[0]?.signature), "encrypted");
  assert.equal(body.locked, false);
});

test("public Responses rejects invalid nested event payloads before the encoder consumes them", async () => {
  const body = new Response('data: {"type":"response.output_text.delta","delta":12}\n\n').body!;
  await assert.rejects(readResponsesSse(body, () => assert.fail("invalid event emitted"), "openai", model.slug));
  assert.equal(body.locked, false);
});

test("public Responses reasoning supports model slugs containing colons without cross-model replay", () => {
  const selected = { ...model, slug: "provider/model:version" };
  const signature = encodeProviderReasoning({ ...scope, model: selected.slug }, "scoped-encrypted");
  const request = MessageRequest.parse({ model: selected.slug, messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "summary", signature }] }, { role: "user", content: "continue" }] });
  const payload = toResponsesRequest(request, "openai", selected, undefined) as { model: string; input: object[] };
  assert.equal(payload.model, selected.slug);
  assert.match(JSON.stringify(payload.input), /scoped-encrypted/);
  assert.doesNotMatch(JSON.stringify(toResponsesRequest(request, "openai", { ...selected, slug: "provider/model" }, undefined)), /scoped-encrypted/);
  assert.doesNotMatch(JSON.stringify(toResponsesRequest(request, "openai", { ...selected, reasoning: "none" }, undefined)), /scoped-encrypted/);
});
