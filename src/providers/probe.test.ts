import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { listenOnLoopback } from "../gateway/gateway.js";
import { defaultApiProviderConfig } from "./config.js";
import { probeApiProvider } from "./probe.js";

const API_KEY = "fixture-provider-secret-not-for-real-use";
const CHAT = [
  { id: "probe", choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null }] },
  { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";

async function close(server: Server): Promise<void> { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }

test("provider probe sends a tool like real Claude Code traffic, without OpenRouter default tool parameters", async () => {
  const bodies: string[] = [];
  const upstream = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      bodies.push(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(200, { "Content-Type": "text/event-stream" }).end(CHAT);
    });
  });
  const port = await listenOnLoopback(upstream, 0);
  try {
    const config = {
      ...defaultApiProviderConfig("openrouter"),
      endpoints: { "chat-completions": `http://127.0.0.1:${port}/inference` },
      defaultModel: "nvidia/probe-model:free",
      models: [{ slug: "nvidia/probe-model:free", displayName: "Probe model", protocol: "chat-completions" as const, reasoning: "openrouter" as const }],
    };
    const result = await probeApiProvider("openrouter", config, "nvidia/probe-model:free", { OPENROUTER_API_KEY: API_KEY }, new AbortController().signal);
    assert.equal(result.reply, "OK");
    assert.equal(bodies.length, 1);
    const sent = JSON.parse(bodies[0]!) as Record<string, unknown>;
    assert.equal(Array.isArray(sent.tools) && sent.tools.length, 1);
    assert.deepEqual(sent.provider, { require_parameters: true });
    assert.equal("parallel_tool_calls" in sent, false);
    assert.equal("tool_choice" in sent, false);
  } finally {
    await close(upstream);
  }
});
