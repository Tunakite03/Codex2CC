import assert from "node:assert/strict";
import { ServerResponse } from "node:http";
import { Socket } from "node:net";
import test from "node:test";
import {
  createLimiter,
  formatMessagesForAntigravity,
  handleAntigravityMessage,
  isAntigravityAvailable,
  modelHasEmbeddedEffort,
  parseAssistantOutput,
  type AntigravityRunner,
  type AntigravityStreamEvent,
} from "./antigravity.js";
import { BridgeError, type MessageRequest } from "./bridge.js";
import { resetTokenUsage, getTokenUsageStats } from "../telemetry/usage.js";

function createMockResponse(): { response: ServerResponse; getOutput: () => string; getStatus: () => number } {
  const socket = new Socket();
  const response = new ServerResponse({ method: "POST", url: "/v1/messages", httpVersion: "1.1" } as any);
  response.assignSocket(socket);

  let output = "";
  response.write = (chunk: any) => {
    output += chunk.toString();
    return true;
  };
  response.end = (chunk?: any) => {
    if (chunk) output += chunk.toString();
    return response;
  };

  return {
    response,
    getOutput: () => output,
    getStatus: () => response.statusCode,
  };
}

test("formatMessagesForAntigravity serializes system, tools, conversation, and tool blocks", () => {
  const req: MessageRequest = {
    model: "claude-sonnet-4-6",
    max_tokens: 4096,
    stream: false,
    system: "You are a helpful assistant.",
    tools: [
      {
        name: "calculator",
        description: "Perform math",
        input_schema: { type: "object", properties: { expr: { type: "string" } } },
      },
    ],
    messages: [
      { role: "user", content: "What is 2 + 2?" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me calculate that." },
          { type: "tool_use", id: "tool_1", name: "calculator", input: { expr: "2 + 2" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tool_1", content: "4" },
        ],
      },
    ],
  };

  const formatted = formatMessagesForAntigravity(req);
  assert.match(formatted, /\[Tool Use Protocol\]/);
  assert.match(formatted, /\[System Instructions\]\nYou are a helpful assistant\./);
  assert.match(formatted, /\[Available Tools\]\n- calculator: Perform math/);
  assert.match(formatted, /Human: What is 2 \+ 2\?/);
  assert.match(formatted, /Assistant: Let me calculate that\.\n<tool_call id="tool_1">\{"name":"calculator","input":\{"expr":"2 \+ 2"\}\}<\/tool_call>/);
  assert.match(formatted, /Human: <tool_result id="tool_1">4<\/tool_result>/);
});

test("isAntigravityAvailable returns boolean without throwing", () => {
  const available = isAntigravityAvailable();
  assert.equal(typeof available, "boolean");
});

test("handleAntigravityMessage streams SSE events and tracks tokens", async () => {
  resetTokenUsage();
  const mockRunner: AntigravityRunner = async (options, onEvent) => {
    assert.equal(options.model, "claude-sonnet-4-6");
    onEvent({
      event: "step_update",
      step_update: {
        step_index: 0,
        state: "ACTIVE",
        step_type: "agent_response",
        text_delta: "Hello ",
      },
    });
    onEvent({
      event: "step_update",
      step_update: {
        step_index: 0,
        state: "ACTIVE",
        step_type: "agent_response",
        text_delta: "world!",
      },
    });
    onEvent({
      event: "step_update",
      step_update: {
        step_index: 0,
        state: "DONE",
        step_type: "agent_response",
        usage: {
          input_tokens: 15,
          output_tokens: 6,
          thinking_tokens: 0,
          cache_read_tokens: 5,
          total_tokens: 21,
        },
      },
    });
  };

  const { response, getOutput, getStatus } = createMockResponse();
  const clientGone = new AbortController();

  const req: MessageRequest = {
    model: "claude-sonnet-4-6",
    max_tokens: 4096,
    stream: true,
    messages: [{ role: "user", content: "Hi" }],
  };

  await handleAntigravityMessage({ model: "claude-sonnet-4-6", runner: mockRunner }, req, response, clientGone.signal);

  assert.equal(getStatus(), 200);
  const out = getOutput();
  assert.match(out, /event: message_start/);
  assert.match(out, /event: content_block_start/);
  assert.match(out, /event: content_block_delta/);
  assert.match(out, /"type":"text_delta","text":"Hello "/);
  assert.match(out, /"type":"text_delta","text":"world!"/);
  assert.match(out, /event: content_block_stop/);
  assert.match(out, /event: message_delta/);
  assert.match(out, /event: message_stop/);

  const usage = getTokenUsageStats();
  assert.equal(usage.grandTotalTokens, 26); // 15 input + 6 output + 5 cached
  const modelUsage = usage.models.find((m) => m.model === "claude-sonnet-4-6");
  assert.equal(modelUsage?.outputTokens, 6);
});

test("handleAntigravityMessage returns standard JSON response when stream is false", async () => {
  resetTokenUsage();
  const mockRunner: AntigravityRunner = async (options, onEvent) => {
    onEvent({
      event: "result",
      result: {
        status: "SUCCESS",
        response: "Bonjour le monde",
        usage: {
          input_tokens: 10,
          output_tokens: 4,
          thinking_tokens: 0,
          total_tokens: 14,
        },
      },
    });
  };

  const { response, getOutput, getStatus } = createMockResponse();
  const clientGone = new AbortController();

  const req: MessageRequest = {
    model: "gemini-3.8-flash-high",
    max_tokens: 4096,
    stream: false,
    messages: [{ role: "user", content: "Say hello in French" }],
  };

  await handleAntigravityMessage({ model: "gemini-3.8-flash-high", runner: mockRunner }, req, response, clientGone.signal);

  assert.equal(getStatus(), 200);
  const json = JSON.parse(getOutput());
  assert.equal(json.type, "message");
  assert.equal(json.role, "assistant");
  assert.equal(json.model, "gemini-3.8-flash-high");
  assert.equal(json.content[0]?.text, "Bonjour le monde");
  assert.equal(json.stop_reason, "end_turn");
  assert.equal(json.usage?.output_tokens, 4);
});

test("modelHasEmbeddedEffort detects effort suffix in Gemini Flash slugs", () => {
  assert.equal(modelHasEmbeddedEffort("gemini-3.8-flash-high"), true);
  assert.equal(modelHasEmbeddedEffort("gemini-3.8-flash-medium"), true);
  assert.equal(modelHasEmbeddedEffort("gemini-3.8-flash-low"), true);
  assert.equal(modelHasEmbeddedEffort("gemini-3.7-flash-high"), true);
});

test("modelHasEmbeddedEffort returns false for non-embedded-effort models", () => {
  assert.equal(modelHasEmbeddedEffort("claude-sonnet-4-6"), false);
  assert.equal(modelHasEmbeddedEffort("claude-opus-4-6-thinking"), false);
  assert.equal(modelHasEmbeddedEffort("gpt-oss-120b-medium"), true); // slug ends with -medium
  assert.equal(modelHasEmbeddedEffort("gemini-3.1-pro-high"), true);
});

test("parseAssistantOutput separates text and tool_use blocks", () => {
  const text = 'I will run the command now.\n<tool_call>{"name":"bash","input":{"command":"ls -la"}}</tool_call>';
  let counter = 0;
  const result = parseAssistantOutput(text, new Set(["bash"]), () => `tool_${++counter}`);
  assert.equal(result.blocks.length, 2);
  assert.deepEqual(result.blocks[0], { type: "text", text: "I will run the command now." });
  assert.deepEqual(result.blocks[1], { type: "tool_use", id: "tool_1", name: "bash", input: { command: "ls -la" } });
  assert.equal(result.rejected.length, 0);
});

test("parseAssistantOutput retains unknown tools as plain text", () => {
  const text = '<tool_call>{"name":"unknown_tool","input":{}}</tool_call>';
  const result = parseAssistantOutput(text, new Set(["bash"]), () => "id");
  assert.equal(result.blocks.length, 1);
  assert.equal(result.blocks[0]?.type, "text");
  assert.equal(result.rejected.length, 1);
});

test("handleAntigravityMessage translates tool_call into tool_use stream event", async () => {
  const mockRunner: AntigravityRunner = async (_options, onEvent) => {
    onEvent({
      event: "step_update",
      step_update: {
        step_index: 0,
        state: "DONE",
        step_type: "agent_response",
        text_delta: 'Executing:\n<tool_call>{"name":"bash","input":{"command":"pwd"}}</tool_call>',
        usage: { input_tokens: 20, output_tokens: 15, thinking_tokens: 0, total_tokens: 35 },
      },
    });
  };

  const { response, getOutput, getStatus } = createMockResponse();
  const req: MessageRequest = {
    model: "claude-sonnet-4-6",
    max_tokens: 4096,
    stream: true,
    tools: [{ name: "bash", description: "Run bash command", input_schema: { type: "object" } }],
    messages: [{ role: "user", content: "Where are we?" }],
  };

  await handleAntigravityMessage({ model: "claude-sonnet-4-6", runner: mockRunner }, req, response, new AbortController().signal);

  assert.equal(getStatus(), 200);
  const out = getOutput();
  assert.match(out, /event: message_start/);
  assert.match(out, /"type":"tool_use"/);
  assert.match(out, /"name":"bash"/);
  assert.match(out, /"stop_reason":"tool_use"/);
});

test("handleAntigravityMessage throws loud BridgeError when tools are denied and no text returned", async () => {
  const mockRunner: AntigravityRunner = async (_options, onEvent) => {
    onEvent({
      event: "result",
      result: {
        status: "SUCCESS",
        response: "",
        denied_actions: [{ action: "write_file" }],
      },
    });
  };

  const { response } = createMockResponse();
  const req: MessageRequest = {
    model: "claude-sonnet-4-6",
    max_tokens: 4096,
    stream: false,
    messages: [{ role: "user", content: "Do something" }],
  };

  await assert.rejects(
    async () => handleAntigravityMessage({ model: "claude-sonnet-4-6", runner: mockRunner }, req, response, new AbortController().signal),
    (err: BridgeError) => err.status === 502 && err.code === "antigravity_tool_denied",
  );
});

test("createLimiter bounds concurrency and cancels queued waiters on abort", async () => {
  const limiter = createLimiter(1);
  const release1 = await limiter.acquire();

  const ac = new AbortController();
  const acquire2Promise = limiter.acquire(ac.signal);
  ac.abort();

  await assert.rejects(acquire2Promise, (err: BridgeError) => err.status === 499);
  release1();
});

