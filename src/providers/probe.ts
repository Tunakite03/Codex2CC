import { BridgeError, MessageAccumulator, MessageRequest, type EffortLevel, type OpenAIEvent } from "../bridge/bridge.js";
import { toAnthropicRequest, readAnthropicSse } from "../bridge/anthropic.js";
import { toChatCompletionsRequest, readChatCompletionsSse } from "../bridge/chat-completions.js";
import { toResponsesRequest, readResponsesSse } from "../bridge/responses.js";
import { requireApiKey, type ApiModel, type ApiProtocol, type ApiProvider, type ApiProviderConfig } from "./config.js";
import { openApiInference } from "./http.js";

const PROBE_TIMEOUT_MS = 30_000;
const PROBE_MAX_TOKENS = 64;
const PROBE_REPLY_CHARS = 200;
// Claude Code always sends tools, which changes routing (e.g. OpenRouter require_parameters) and request validation.
const PROBE_TOOL = {
  name: "codex2cc_probe_noop",
  description: "Connection test placeholder. Never call this tool.",
  input_schema: { type: "object", properties: {}, additionalProperties: false },
} as const;

/** Translates an Anthropic request into the body the model's adapter protocol expects. */
export function toApiRequestBody(inbound: MessageRequest, provider: ApiProvider, model: ApiModel, effort: EffortLevel | undefined): object {
  if (model.protocol === "responses") return toResponsesRequest(inbound, provider, model, effort);
  if (model.protocol === "anthropic-messages") return toAnthropicRequest(inbound, provider, model.slug, effort);
  return toChatCompletionsRequest(inbound, model.slug, model.reasoning, effort, { provider, model: model.slug });
}

/** Reads a provider SSE body with the parser matching the model's adapter protocol. */
export function readApiStream(body: ReadableStream<Uint8Array>, accept: (event: OpenAIEvent) => void, provider: ApiProvider, model: ApiModel): Promise<void> {
  if (model.protocol === "responses") return readResponsesSse(body, accept, provider, model.slug);
  if (model.protocol === "anthropic-messages") return readAnthropicSse(body, accept, provider, model.slug);
  return readChatCompletionsSse(body, accept, { provider, model: model.slug });
}

export type ProviderProbeResult = {
  readonly provider: ApiProvider;
  readonly model: string;
  readonly protocol: ApiProtocol;
  readonly endpoint: string;
  readonly latencyMs: number;
  readonly reply: string;
};

/**
 * Sends one tiny message with a tool through the same translation and HTTP path as `/v1/messages`,
 * so a success proves the key, endpoint, model slug, tool support and stream parser all work together.
 */
export async function probeApiProvider(
  provider: ApiProvider,
  config: ApiProviderConfig,
  modelSlug: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<ProviderProbeResult> {
  const model = config.models.find((item) => item.slug === modelSlug);
  if (!model) throw new BridgeError(400, "model_unavailable", `Model "${modelSlug}" is not in the ${provider} model catalog.`);
  const endpoint = config.endpoints[model.protocol];
  if (!endpoint) throw new BridgeError(400, "missing_provider_endpoint", `Model "${model.slug}" uses ${model.protocol}, which has no configured endpoint.`);
  const apiKey = requireApiKey(config, env);
  const inbound = MessageRequest.parse({
    model: model.slug,
    max_tokens: model.maxOutputTokens === undefined ? PROBE_MAX_TOKENS : Math.min(PROBE_MAX_TOKENS, model.maxOutputTokens),
    stream: true,
    thinking: { type: "disabled" },
    tools: [PROBE_TOOL],
    messages: [{ role: "user", content: "Reply with the single word OK." }],
  });
  const startTime = Date.now();
  try {
    const upstream = await openApiInference({
      provider,
      protocol: model.protocol,
      url: endpoint,
      apiKey,
      body: toApiRequestBody(inbound, provider, model, undefined),
      signal: AbortSignal.any([signal, AbortSignal.timeout(PROBE_TIMEOUT_MS)]),
    });
    const accumulator = new MessageAccumulator(model.slug);
    let reply = "";
    await readApiStream(upstream.body!, (event) => {
      if (event.type === "response.output_text.delta" && typeof event.delta === "string") reply += event.delta;
      accumulator.accept(event);
    }, provider, model);
    accumulator.assertCompleted();
    return { provider, model: model.slug, protocol: model.protocol, endpoint, latencyMs: Date.now() - startTime, reply: reply.trim().slice(0, PROBE_REPLY_CHARS) };
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new BridgeError(504, "provider_timeout", `${provider} did not finish the test message within ${PROBE_TIMEOUT_MS / 1000}s.`);
    }
    if (error instanceof BridgeError) {
      throw new BridgeError(error.status, error.code, error.message.replaceAll(apiKey, "[REDACTED]"), error.retryAfterSeconds);
    }
    throw error;
  }
}
