import { createHash } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { z } from "zod";
import {
  AnthropicStream,
  BridgeError,
  estimateCodexInputTokens,
  estimateTextTokens,
  hasReasoningItems,
  MessageAccumulator,
  MessageRequest,
  readSse,
  toOpenAIRequest,
  unsupportedBlockTypes,
  unsupportedToolNames,
  withoutReasoningItems,
  type OpenAIRequest,
} from "../bridge/bridge.js";
import { formatMessagesForAntigravity, handleAntigravityMessage, pruneToolsForAntigravity, type AntigravityRunner } from "../bridge/antigravity.js";
import { checkClient, checkHost, checkUiOrigin, requestPathname, type GuardPolicy, type GuardResult } from "./guard.js";
import {
  ANTIGRAVITY_DEFAULT_MODEL,
  ANTIGRAVITY_MODELS,
  CLAUDE_GATEWAY_MODELS,
  DEFAULT_TIER_MODELS,
  PROVIDER_LABELS,
  resolveModel,
  type ProviderType,
  type TierModels,
} from "../models/models.js";
import { activeTierModels, type TierModelStore } from "../models/tier-store.js";
import { handleUiRoute } from "../ui/ui.js";
import type { AccountUsageLimits } from "../auth/auth.js";
import { recordLog } from "../telemetry/logger.js";
import { recordTokenUsage } from "../telemetry/usage.js";
import { isApiProvider, requireApiKey, type ApiProvider } from "../providers/config.js";
import { currentProvider, getProviderConfig, providerDefaultModel, providerModels } from "../providers/runtime.js";
import { openApiInference } from "../providers/http.js";
import { readApiStream, toApiRequestBody } from "../providers/probe.js";
import type { AnthropicUsage, OpenAIEvent } from "../bridge/bridge.js";

export const CHATGPT_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";

const DEFAULT_MAX_BODY_BYTES = 16 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 600_000;
const UPSTREAM_ATTEMPTS = 3;
// Claude Code aborts a gateway stream after 300s without bytes; reasoning without a summary sends none.
const DEFAULT_KEEP_ALIVE_MS = 10_000;

export type ModelInfo = { slug: string; displayName: string; contextWindow?: number };

/** The part of a ChatGPT session the gateway needs to call the upstream API. */
export type UpstreamSession = {
  accessToken(): Promise<string>;
  /** Returns a token other than `rejected`, refreshing the session when upstream answered 401. */
  refreshAfterRejection(rejected: string): Promise<string>;
  accountId(): string;
  getUsageLimits?(forceRefresh?: boolean): Promise<AccountUsageLimits | null>;
};

export type GatewayOptions = {
  readonly session: UpstreamSession;
  readonly defaultModel: string;
  readonly availableModels: readonly ModelInfo[];
  readonly policy: GuardPolicy;
  readonly upstreamUrl?: string;
  readonly maxBodyBytes?: number;
  readonly tiers?: TierModels;
  /** Live, UI-editable mapping; when present it takes precedence over `tiers`. */
  readonly tierStore?: TierModelStore;
  provider?: ProviderType;
  /** Explicit startup model overrides remain scoped when the UI switches providers. */
  readonly defaultModels?: Partial<Record<ProviderType, string>>;
  /** Runtime credentials, read by configured variable name and never returned by UI APIs. */
  readonly providerEnv?: NodeJS.ProcessEnv;
  readonly antigravityRunner?: AntigravityRunner;
  readonly antigravityModels?: readonly ModelInfo[];
  /** Interval between SSE pings while a streamed response is open. */
  readonly keepAliveMs?: number;
};

type ResolvedGatewayOptions = GatewayOptions & {
  readonly upstreamUrl: string;
  readonly maxBodyBytes: number;
  readonly keepAliveMs: number;
  readonly currentTiers: () => TierModels;
  readonly modelSlugs: () => ReadonlySet<string>;
  readonly warnedModels: Set<string>;
  readonly activeProvider: () => ProviderType;
};

function errorType(status: number): string {
  if (status === 400) return "invalid_request_error";
  if (status === 401) return "authentication_error";
  if (status === 403) return "permission_error";
  if (status === 404) return "not_found_error";
  if (status === 413) return "request_too_large";
  if (status === 429) return "rate_limit_error";
  if (status >= 400 && status < 500) return "invalid_request_error";
  return "api_error";
}

function sendError(response: ServerResponse, error: BridgeError): void {
  const body = { type: "error", error: { type: errorType(error.status), message: error.message } };
  if (response.headersSent) {
    response.write(`event: error\ndata: ${JSON.stringify(body)}\n\n`);
    response.end();
  } else {
    response.writeHead(error.status, {
      "Content-Type": "application/json",
      ...(error.retryAfterSeconds === undefined ? {} : { "Retry-After": String(error.retryAfterSeconds) }),
    }).end(JSON.stringify(body));
  }
}

const UpstreamErrorBody = z.object({
  error: z.object({
    type: z.string().optional(),
    code: z.string().nullable().optional(),
    message: z.string().optional(),
    param: z.string().nullable().optional(),
    resets_in_seconds: z.number().nonnegative().optional(),
    resets_at: z.number().nonnegative().optional(),
  }).loose(),
}).loose();
type UpstreamErrorBody = z.infer<typeof UpstreamErrorBody>["error"];

function parseUpstreamError(text: string): UpstreamErrorBody | undefined {
  try {
    const parsed = UpstreamErrorBody.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data.error : undefined;
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

/**
 * Whole seconds until a rate limit lifts, from the Retry-After header or the ChatGPT usage-limit body.
 * Claude Code stops retrying and shows the error when this exceeds 60 seconds.
 */
function retryAfterSeconds(header: string | null, body: UpstreamErrorBody | undefined, now: number): number | undefined {
  if (header !== null) {
    if (/^\d+$/.test(header.trim())) return Number(header.trim());
    const date = Date.parse(header);
    if (!Number.isNaN(date)) return Math.max(0, Math.ceil((date - now) / 1000));
  }
  if (body?.resets_in_seconds !== undefined) return Math.ceil(body.resets_in_seconds);
  if (body?.resets_at !== undefined) return Math.max(0, Math.ceil(body.resets_at - now / 1000));
  return undefined;
}

/** Turns a non-2xx upstream answer into the error Claude Code needs to recover (compact, back off, re-auth). */
function upstreamHttpError(status: number, headers: Headers, text: string): BridgeError {
  const body = parseUpstreamError(text);
  const detail = body?.message ?? text.slice(0, 500);
  const message = `ChatGPT inference returned HTTP ${status}: ${detail}`;
  if (body?.code === "context_length_exceeded" || (status === 400 && /context (window|length)/i.test(detail))) {
    return new BridgeError(400, "context_length_exceeded", detail);
  }
  if (status === 400 && (body?.param?.includes("encrypted_content") === true || /encrypted.content/i.test(detail))) {
    return new BridgeError(400, "reasoning_rejected", message);
  }
  if (status === 429) return new BridgeError(429, "inference_failed", message, retryAfterSeconds(headers.get("retry-after"), body, Date.now()));
  return new BridgeError(status >= 400 && status < 500 ? status : 502, "inference_failed", message);
}

/**
 * The context-overflow error in the shape Claude Code recognizes, so it compacts the conversation
 * instead of retrying. The token count is the local estimate, raised above the limit it overflowed.
 */
function promptTooLong(detail: string, estimatedTokens: number, contextWindow: number | undefined): BridgeError {
  const counts = contextWindow === undefined ? "" : ` ${Math.max(estimatedTokens, contextWindow + 1)} tokens > ${contextWindow} maximum.`;
  return new BridgeError(400, "prompt_too_long", `prompt is too long:${counts} ${detail} (capability_rejected: prompt_too_long)`);
}

/** Stable per-conversation cache routing key; subagents get their own because their prefix differs. */
export function promptCacheKey(headers: IncomingHttpHeaders): string | undefined {
  const session = headers["x-claude-code-session-id"];
  if (typeof session !== "string" || session.length === 0) return undefined;
  const agent = headers["x-claude-code-agent-id"];
  const scope = typeof agent === "string" && agent.length > 0 ? `${session}:${agent}` : session;
  return createHash("sha256").update(scope, "utf8").digest("base64url");
}

function sendGuardFailure(response: ServerResponse, failure: Extract<GuardResult, { ok: false }>): void {
  response.writeHead(failure.status, { "Content-Type": "application/json" }).end(
    JSON.stringify({ type: "error", error: { type: failure.type, message: failure.message } }),
  );
}

async function readBody(request: IncomingMessage, maxBytes: number): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new BridgeError(413, "request_too_large", "Claude Code request exceeds the size limit.");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseRequest(raw: string): MessageRequest {
  try {
    const result = MessageRequest.safeParse(JSON.parse(raw));
    if (!result.success) {
      throw new BridgeError(400, "invalid_message", `Claude Code request failed validation: ${result.error.issues[0]?.path.join(".") ?? "body"}.`);
    }
    return result.data;
  } catch (error) {
    if (error instanceof SyntaxError) throw new BridgeError(400, "invalid_json", "Claude Code sent malformed JSON.");
    throw error;
  }
}

async function openInference(options: ResolvedGatewayOptions, body: object, clientGone: AbortSignal): Promise<Response> {
  let token = await options.session.accessToken();
  let refreshedAfterRejection = false;
  let attempt = 0;
  for (;;) {
    attempt++;
    const response = await fetch(options.upstreamUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "ChatGPT-Account-Id": options.session.accountId(),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.any([AbortSignal.timeout(UPSTREAM_TIMEOUT_MS), clientGone]),
    });
    if (response.status === 401 && !refreshedAfterRejection) {
      // The token may have expired early or been rotated by another process: refresh once, outside the retry budget.
      refreshedAfterRejection = true;
      attempt--;
      await response.body?.cancel();
      process.stderr.write(`${JSON.stringify({ level: "warn", operation: "inference", status: 401, action: "refresh_token" })}\n`);
      recordLog({
        level: "warn",
        operation: "inference",
        message: "ChatGPT token rejected (401), refreshing access token",
        details: { status: 401, action: "refresh_token" },
      });
      token = await options.session.refreshAfterRejection(token);
      continue;
    }
    // 429 is not retried here: Claude Code backs off itself and honors the Retry-After passed through.
    if (response.status === 503 && attempt < UPSTREAM_ATTEMPTS) {
      process.stderr.write(`${JSON.stringify({ level: "warn", operation: "inference", attempt, status: response.status })}\n`);
      recordLog({
        level: "warn",
        operation: "inference",
        message: `Upstream HTTP ${response.status} on attempt ${attempt}, retrying in ${300 * attempt}ms`,
        details: { attempt, status: response.status },
      });
      await response.body?.cancel();
      await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
      continue;
    }
    if (!response.ok) {
      throw upstreamHttpError(response.status, response.headers, await response.text());
    }
    if (!response.body) throw new BridgeError(502, "missing_stream", "ChatGPT inference returned no stream.");
    return response;
  }
}

async function handleMessage(
  options: ResolvedGatewayOptions,
  request: IncomingMessage,
  response: ServerResponse,
  clientGone: AbortSignal,
): Promise<void> {
  const startTime = Date.now();
  const inbound = parseRequest(await readBody(request, options.maxBodyBytes));
  const requestedEffort = inbound.output_config?.effort ?? inbound.reasoning_effort;
  const loggedRequestedEffort = requestedEffort ?? "upstream_default";
  recordLog({
    level: "info",
    operation: "inbound_request",
    message: `Received message request for model "${inbound.model}" (stream: ${Boolean(inbound.stream)}, effort: ${loggedRequestedEffort})`,
    details: { model: inbound.model, stream: Boolean(inbound.stream), effort: loggedRequestedEffort },
  });
  const omittedBlocks = unsupportedBlockTypes(inbound);
  if (omittedBlocks.length > 0) {
    process.stderr.write(`${JSON.stringify({ level: "warn", operation: "unsupported_blocks", types: omittedBlocks })}\n`);
    recordLog({
      level: "warn",
      operation: "unsupported_blocks",
      message: `Unsupported blocks omitted: ${omittedBlocks.join(", ")}`,
      details: { types: omittedBlocks.join(", ") },
    });
  }
  const omittedTools = unsupportedToolNames(inbound);
  if (omittedTools.length > 0) {
    process.stderr.write(`${JSON.stringify({ level: "warn", operation: "unsupported_tools", names: omittedTools })}\n`);
    recordLog({
      level: "warn",
      operation: "unsupported_tools",
      message: `Unsupported tools omitted: ${omittedTools.join(", ")}`,
      details: { names: omittedTools.join(", ") },
    });
  }
  const provider = options.activeProvider();
  if (isApiProvider(provider)) {
    await routeToApi(options, provider, inbound, response, clientGone, startTime);
    return;
  }
  if (provider === "antigravity") {
    await routeToAntigravity(options, inbound, requestedEffort, response, clientGone);
    return;
  }
  await routeToCodex(options, inbound, request.headers, response, clientGone, startTime);
}

function resolveRequestModel(options: ResolvedGatewayOptions, requestedModel: string): ReturnType<typeof resolveModel> {
  const slugs = options.modelSlugs();
  const defaultModel = providerDefaultModel(options, options.activeProvider());
  return resolveModel(requestedModel, defaultModel, slugs, options.currentTiers());
}

async function routeToAntigravity(
  options: ResolvedGatewayOptions,
  inbound: MessageRequest,
  requestedEffort: string | undefined,
  response: ServerResponse,
  clientGone: AbortSignal,
): Promise<void> {
  const resolution = resolveRequestModel(options, inbound.model);
  const activeModel = resolution.slug;
  if (resolution.fellBack && !options.warnedModels.has(inbound.model)) {
    options.warnedModels.add(inbound.model);
    process.stderr.write(`${JSON.stringify({ level: "warn", operation: "model_fallback", provider: "antigravity", requested: inbound.model, using: activeModel })}\n`);
    recordLog({
      level: "warn",
      operation: "model_fallback",
      message: `[Antigravity] Requested model "${inbound.model}" unavailable; routed to "${activeModel}"`,
      details: { provider: "antigravity", requested: inbound.model, using: activeModel },
    });
  }
  const defaultEffort = options.tierStore?.getEffort();
  await handleAntigravityMessage(
    { model: activeModel, runner: options.antigravityRunner, effort: requestedEffort ?? defaultEffort },
    inbound,
    response,
    clientGone,
  );
}

/**
 * Opens the upstream stream. Replayed reasoning the upstream cannot decrypt (expired, or issued to
 * another account) is dropped once instead of failing the turn.
 */
async function openCodexInference(options: ResolvedGatewayOptions, outgoing: OpenAIRequest, clientGone: AbortSignal): Promise<Response> {
  try {
    return await openInference(options, outgoing, clientGone);
  } catch (error) {
    if (!(error instanceof BridgeError && error.code === "reasoning_rejected" && hasReasoningItems(outgoing))) throw error;
    process.stderr.write(`${JSON.stringify({ level: "warn", operation: "reasoning_rejected", action: "retry_without_reasoning" })}\n`);
    recordLog({
      level: "warn",
      operation: "reasoning_rejected",
      message: "ChatGPT rejected replayed reasoning; retrying without it",
      details: { action: "retry_without_reasoning" },
    });
    return openInference(options, withoutReasoningItems(outgoing), clientGone);
  }
}

async function routeToCodex(
  options: ResolvedGatewayOptions,
  inbound: MessageRequest,
  headers: IncomingHttpHeaders,
  response: ServerResponse,
  clientGone: AbortSignal,
  startTime: number,
): Promise<void> {
  const resolution = resolveRequestModel(options, inbound.model);
  const activeModel = resolution.slug;
  if (resolution.fellBack && !options.warnedModels.has(inbound.model)) {
    options.warnedModels.add(inbound.model);
    process.stderr.write(`${JSON.stringify({ level: "warn", operation: "model_fallback", requested: inbound.model, using: activeModel })}\n`);
    recordLog({
      level: "warn",
      operation: "model_fallback",
      message: `Requested model "${inbound.model}" unavailable; routed to "${activeModel}"`,
      details: { requested: inbound.model, using: activeModel },
    });
  }
  const outgoing = toOpenAIRequest(inbound, activeModel);
  const cacheKey = promptCacheKey(headers);
  if (cacheKey !== undefined) outgoing.prompt_cache_key = cacheKey;
  const defaultEffort = options.tierStore?.getEffort();
  if (outgoing.reasoning?.effort === undefined) {
    if (defaultEffort) {
      outgoing.reasoning = { ...outgoing.reasoning, effort: defaultEffort };
    } else if (activeModel === options.currentTiers().haiku || activeModel === DEFAULT_TIER_MODELS.haiku) {
      outgoing.reasoning = { ...outgoing.reasoning, effort: "max" };
    }
  }
  const effort = outgoing.reasoning?.effort ?? "upstream_default";
  const estimatedTokens = estimateCodexInputTokens(outgoing);
  try {
    const upstream = await openCodexInference(options, outgoing, clientGone);
    if (inbound.stream) {
      // Headers go out with the first SSE frame, so a failure reported before any content still gets its status.
      response.statusCode = 200;
      response.setHeader("Content-Type", "text/event-stream");
      response.setHeader("Cache-Control", "no-cache");
      response.setHeader("Connection", "keep-alive");
      const encoder = new AnthropicStream(response, activeModel, estimatedTokens);
      const keepAlive = setInterval(() => encoder.keepAlive(), options.keepAliveMs);
      try {
        await readSse(upstream.body!, (event) => encoder.accept(event));
      } finally {
        clearInterval(keepAlive);
      }
      encoder.assertCompleted();
      response.end();
      const usage = encoder.getUsage();
      const inputTokens = usage?.input_tokens ?? estimatedTokens;
      const outputTokens = usage?.output_tokens ?? 0;
      const cachedTokens = usage?.cache_read_input_tokens ?? 0;
      recordTokenUsage({
        model: activeModel,
        inputTokens,
        outputTokens,
        cachedTokens,
      });
      recordLog({
        level: "info",
        operation: "stream_complete",
        message: `Stream completed for model "${activeModel}" in ${Date.now() - startTime}ms`,
        details: {
          model: activeModel,
          effort,
          durationMs: Date.now() - startTime,
          inputTokens,
          outputTokens,
          cachedTokens,
          totalTokens: inputTokens + outputTokens + cachedTokens,
        },
      });
    } else {
      const accumulator = new MessageAccumulator(activeModel);
      await readSse(upstream.body!, (event) => accumulator.accept(event));
      accumulator.assertCompleted();
      const msg = accumulator.buildMessage();
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(msg));
      const usage = accumulator.getUsage();
      const inputTokens = usage.input_tokens;
      const outputTokens = usage.output_tokens;
      const cachedTokens = usage.cache_read_input_tokens ?? 0;
      recordTokenUsage({
        model: activeModel,
        inputTokens,
        outputTokens,
        cachedTokens,
      });
      recordLog({
        level: "info",
        operation: "message_complete",
        message: `Message completed for model "${activeModel}" in ${Date.now() - startTime}ms`,
        details: {
          model: activeModel,
          effort,
          durationMs: Date.now() - startTime,
          inputTokens,
          outputTokens,
          cachedTokens,
          totalTokens: inputTokens + outputTokens + cachedTokens,
        },
      });
    }
  } catch (error) {
    if (!(error instanceof BridgeError && error.code === "context_length_exceeded")) throw error;
    const contextWindow = options.availableModels.find((model) => model.slug === activeModel)?.contextWindow;
    throw promptTooLong(error.message, estimatedTokens, contextWindow);
  }
}

async function routeToApi(
  options: ResolvedGatewayOptions,
  provider: ApiProvider,
  inbound: MessageRequest,
  response: ServerResponse,
  clientGone: AbortSignal,
  startTime: number,
): Promise<void> {
  // Capture provider configuration before the first await; a UI switch affects only subsequent requests.
  const config = getProviderConfig(options, provider);
  const resolution = resolveModel(inbound.model, providerDefaultModel(options, provider), new Set(config.models.map((model) => model.slug)), options.currentTiers());
  const model = config.models.find((item) => item.slug === resolution.slug);
  if (!model) throw new BridgeError(400, "model_unavailable", "The requested API model is not configured for this provider.");
  const apiKey = requireApiKey(config, options.providerEnv ?? process.env);
  const endpoint = config.endpoints[model.protocol];
  if (!endpoint) throw new BridgeError(400, "missing_provider_endpoint", "The selected model's protocol has no configured endpoint.");
  if (model.maxOutputTokens !== undefined && inbound.max_tokens > model.maxOutputTokens) {
    throw new BridgeError(400, "output_limit_exceeded", `Requested max_tokens exceeds the configured output limit for model "${model.slug}".`);
  }
  const effort = options.tierStore?.getEffort();
  const outgoing = toApiRequestBody(inbound, provider, model, effort);
  const estimatedTokens = estimateCodexInputTokens(toOpenAIRequest(inbound, model.slug));
  if (resolution.fellBack) recordLog({ level: "warn", operation: "model_fallback", message: "Requested model is not configured; using provider default", details: { provider, requested: inbound.model, model: model.slug } });
  try {
    const upstream = await openApiInference({ provider, protocol: model.protocol, url: endpoint, apiKey, body: outgoing, signal: clientGone });
    const read = (accept: (event: OpenAIEvent) => void): Promise<void> => readApiStream(upstream.body!, accept, provider, model);
    let usage: AnthropicUsage | undefined;
    if (inbound.stream) {
      response.statusCode = 200;
      response.setHeader("Content-Type", "text/event-stream");
      response.setHeader("Cache-Control", "no-cache");
      response.setHeader("Connection", "keep-alive");
      const encoder = new AnthropicStream(response, model.slug, estimatedTokens);
      const keepAlive = setInterval(() => encoder.keepAlive(), options.keepAliveMs);
      try { await read((event) => encoder.accept(event)); }
      finally { clearInterval(keepAlive); }
      encoder.assertCompleted();
      usage = encoder.getUsage();
      response.end();
    } else {
      const accumulator = new MessageAccumulator(model.slug);
      await read((event) => accumulator.accept(event));
      accumulator.assertCompleted();
      usage = accumulator.getUsage();
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(accumulator.buildMessage()));
    }
    const inputTokens = usage?.input_tokens ?? estimatedTokens;
    const outputTokens = usage?.output_tokens ?? 0;
    const cachedTokens = usage?.cache_read_input_tokens ?? 0;
    recordTokenUsage({ model: model.slug, inputTokens, outputTokens, cachedTokens });
    recordLog({ level: "info", operation: "provider_complete", message: "API provider response completed", details: { provider, protocol: model.protocol, model: model.slug, inputTokens, outputTokens, cachedTokens, durationMs: Date.now() - startTime } });
  } catch (error) {
    if (error instanceof BridgeError) {
      const message = error.message.replaceAll(apiKey, "[REDACTED]");
      if (error.code === "context_length_exceeded") throw promptTooLong(message, estimatedTokens, model.contextWindow);
      throw new BridgeError(error.status, error.code.replaceAll(apiKey, "redacted"), message, error.retryAfterSeconds);
    }
    throw error;
  }
}

async function handleCountTokens(
  options: ResolvedGatewayOptions,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const inbound = parseRequest(await readBody(request, options.maxBodyBytes));
  const provider = options.activeProvider();
  const { slug: model } = resolveRequestModel(options, inbound.model);
  const count = provider === "antigravity"
    ? estimateTextTokens(formatMessagesForAntigravity(pruneToolsForAntigravity(inbound)))
    : estimateCodexInputTokens(toOpenAIRequest(inbound, model));
  recordLog({
    level: "info",
    operation: "count_tokens",
    message: "Estimated input tokens locally from the provider payload",
    details: { provider, requestedModel: inbound.model, model, tokens: count, method: "local_heuristic" },
  });
  response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ input_tokens: count }));
}

function toBridgeError(error: Error): BridgeError {
  if (error instanceof BridgeError) return error;
  if (error instanceof z.ZodError) return new BridgeError(502, "invalid_upstream_shape", "The provider returned data outside the documented schema.");
  return new BridgeError(500, "internal_error", `Codex2CC failed while translating the request: ${error.message}`);
}

/**
 * Anthropic-compatible local gateway. Every request must pass the Host check, and every
 * route except the `HEAD /api/hello` liveness probe must pass the client credential check.
 */
export function createGatewayServer(gatewayOptions: GatewayOptions): Server {
  const options: ResolvedGatewayOptions = {
    ...gatewayOptions,
    upstreamUrl: gatewayOptions.upstreamUrl ?? CHATGPT_RESPONSES_URL,
    maxBodyBytes: gatewayOptions.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
    keepAliveMs: gatewayOptions.keepAliveMs ?? DEFAULT_KEEP_ALIVE_MS,
    currentTiers: () => activeTierModels(gatewayOptions),
    activeProvider: () => currentProvider(gatewayOptions),
    modelSlugs: () => {
      return new Set(providerModels(gatewayOptions, currentProvider(gatewayOptions)).map((model) => model.slug));
    },
    warnedModels: new Set<string>(),
  };

  return createServer((request, response) => {
    const hostCheck = checkHost(request.headers);
    if (!hostCheck.ok) {
      recordLog({
        level: "error",
        operation: "guard_host",
        message: `Blocked request with invalid Host: ${hostCheck.message}`,
        details: { status: hostCheck.status, type: hostCheck.type },
      });
      sendGuardFailure(response, hostCheck);
      return;
    }
    const path = requestPathname(request.url);
    if (path === undefined) {
      response.writeHead(400).end();
      return;
    }
    if (request.method === "HEAD" && path === "/api/hello") {
      response.writeHead(200).end();
      return;
    }
    if (path === "/" || path === "/ui" || path.startsWith("/api/ui/")) {
      const port = (request.socket.localPort) || 3456;
      const originCheck = checkUiOrigin(request.headers, port);
      if (!originCheck.ok) {
        recordLog({
          level: "warn",
          operation: "guard_ui_origin",
          message: `Blocked control panel request: ${originCheck.message}`,
          details: { status: originCheck.status, type: originCheck.type, path },
        });
        sendGuardFailure(response, originCheck);
        return;
      }
      handleUiRoute(gatewayOptions, request, response, path, port).then((handled) => {
        if (!handled) response.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "Unknown control panel route." } }));
      }).catch((error: Error) => {
        const typed = toBridgeError(error);
        recordLog({
          level: typed.status >= 500 ? "error" : "warn",
          operation: "ui_request_failed",
          message: `Control panel request failed: ${typed.code} (${typed.status}): ${typed.message}`,
          details: { code: typed.code, status: typed.status, path },
        });
        if (response.headersSent) {
          response.end();
          return;
        }
        response.writeHead(typed.status, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: false, error: typed.message }));
      });
      return;
    }
    const clientCheck = checkClient(request.headers, options.policy);
    if (!clientCheck.ok) {
      recordLog({
        level: "warn",
        operation: "guard_auth",
        message: `Client auth check failed: ${clientCheck.message}`,
        details: { status: clientCheck.status, type: clientCheck.type },
      });
      sendGuardFailure(response, clientCheck);
      return;
    }
    if (request.method === "GET" && path === "/v1/models") {
      const currentProvider = options.activeProvider();
      const availableModels = providerModels(options, currentProvider);
      const modelSlugs = new Set(availableModels.map((model) => model.slug));
      const defaultModel = providerDefaultModel(options, currentProvider);

      recordLog({
        level: "info",
        operation: "models",
        message: `Client queried models catalog for provider "${currentProvider}" (${CLAUDE_GATEWAY_MODELS.length} models returned)`,
      });
      const tiers = options.currentTiers();
      const providerLabel = PROVIDER_LABELS[currentProvider];
      const list = CLAUDE_GATEWAY_MODELS.map((model) => {
        const resolution = resolveModel(model.id, defaultModel, modelSlugs, tiers);
        const targetModel = availableModels.find((available) => available.slug === resolution.slug);
        return {
          id: model.id,
          type: "model",
          display_name: `${resolution.slug} (${providerLabel} via ${model.tier} route${resolution.fellBack ? ", fallback" : ""})`,
          ...(targetModel?.contextWindow === undefined ? {} : { max_input_tokens: targetModel.contextWindow }),
        };
      });
      response.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          data: list,
          has_more: false,
          first_id: CLAUDE_GATEWAY_MODELS[0].id,
          last_id: CLAUDE_GATEWAY_MODELS.at(-1)!.id,
        }),
      );
      return;
    }
    const route = request.method !== "POST" ? undefined
      : path === "/v1/messages" ? handleMessage
      : path === "/v1/messages/count_tokens" ? handleCountTokens
      : undefined;
    if (route === undefined) {
      response.writeHead(404).end();
      return;
    }

    const clientGone = new AbortController();
    response.on("close", () => clientGone.abort());
    route(options, request, response, clientGone.signal).catch((error: Error) => {
      const typed = toBridgeError(error);
      const clientDisconnected = clientGone.signal.aborted;
      process.stderr.write(`${JSON.stringify({ level: clientDisconnected ? "info" : "error", operation: "bridge_request", code: typed.code, status: typed.status, message: typed.message, clientDisconnected })}\n`);
      recordLog({
        level: clientDisconnected ? "info" : "error",
        operation: "bridge_request",
        message: clientDisconnected ? "Client closed connection before completion" : `${typed.code} (${typed.status}): ${typed.message}`,
        details: { code: typed.code, status: typed.status, clientDisconnected },
      });
      if (!clientDisconnected) sendError(response, typed);
    });
  });
}

/** Binds the server to a loopback port (0 picks a free one) and returns the bound port. */
export async function listenOnLoopback(server: Server, port: number): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new BridgeError(500, "gateway_bind_failed", "Could not bind the local gateway.");
  }
  return address.port;
}
