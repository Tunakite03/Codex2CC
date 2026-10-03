import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { z } from "zod";
import {
  AnthropicStream,
  BridgeError,
  estimateInputTokens,
  MessageAccumulator,
  MessageRequest,
  readSse,
  toOpenAIRequest,
  unsupportedBlockTypes,
  unsupportedToolNames,
} from "./bridge.js";
import { checkClient, checkHost, requestPathname, type GuardPolicy, type GuardResult } from "./guard.js";

export const CHATGPT_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";

const DEFAULT_MAX_BODY_BYTES = 16 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 600_000;
const UPSTREAM_ATTEMPTS = 3;

export type ModelInfo = { slug: string; displayName: string };

/** The part of a ChatGPT session the gateway needs to call the upstream API. */
export type UpstreamSession = {
  accessToken(): Promise<string>;
  /** Returns a token other than `rejected`, refreshing the session when upstream answered 401. */
  refreshAfterRejection(rejected: string): Promise<string>;
  accountId(): string;
};

export type GatewayOptions = {
  readonly session: UpstreamSession;
  readonly defaultModel: string;
  readonly availableModels: readonly ModelInfo[];
  readonly policy: GuardPolicy;
  readonly upstreamUrl?: string;
  readonly maxBodyBytes?: number;
};

type ResolvedGatewayOptions = GatewayOptions & {
  readonly upstreamUrl: string;
  readonly maxBodyBytes: number;
  readonly modelSlugs: ReadonlySet<string>;
};

function errorType(status: number): string {
  if (status === 400) return "invalid_request_error";
  if (status === 401) return "authentication_error";
  if (status === 403) return "permission_error";
  if (status === 429) return "rate_limit_error";
  return "api_error";
}

function sendError(response: ServerResponse, error: BridgeError): void {
  const body = { type: "error", error: { type: errorType(error.status), message: error.message } };
  if (response.headersSent) {
    response.write(`event: error\ndata: ${JSON.stringify(body)}\n\n`);
    response.end();
  } else {
    response.writeHead(error.status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
  }
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
      token = await options.session.refreshAfterRejection(token);
      continue;
    }
    if ((response.status === 429 || response.status === 503) && attempt < UPSTREAM_ATTEMPTS) {
      process.stderr.write(`${JSON.stringify({ level: "warn", operation: "inference", attempt, status: response.status })}\n`);
      await response.body?.cancel();
      await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
      continue;
    }
    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      const passthrough = response.status === 401 || response.status === 403 || response.status === 429;
      throw new BridgeError(
        passthrough ? response.status : 502,
        "inference_failed",
        `ChatGPT inference returned HTTP ${response.status}: ${errText.slice(0, 200)}`,
      );
    }
    if (!response.body) throw new BridgeError(502, "missing_stream", "ChatGPT inference returned no stream.");
    return response;
  }
}

export function resolveModelSlug(
  inboundModel: string | undefined,
  defaultModel: string,
  modelSlugs: ReadonlySet<string>,
): string {
  if (!inboundModel) return defaultModel;
  if (modelSlugs.has(inboundModel)) return inboundModel;
  const lower = inboundModel.toLowerCase();
  if (lower.includes("opus") && modelSlugs.has("gpt-6.1-sol")) return "gpt-6.1-sol";
  if (lower.includes("haiku") && modelSlugs.has("gpt-5.6-sol")) return "gpt-5.6-sol";
  if (lower.includes("sonnet") && modelSlugs.has("gpt-6-sol")) return "gpt-6-sol";
  return defaultModel;
}

async function handleMessage(
  options: ResolvedGatewayOptions,
  request: IncomingMessage,
  response: ServerResponse,
  clientGone: AbortSignal,
): Promise<void> {
  const inbound = parseRequest(await readBody(request, options.maxBodyBytes));
  const omittedBlocks = unsupportedBlockTypes(inbound);
  if (omittedBlocks.length > 0) {
    process.stderr.write(`${JSON.stringify({ level: "warn", operation: "unsupported_blocks", types: omittedBlocks })}\n`);
  }
  const omittedTools = unsupportedToolNames(inbound);
  if (omittedTools.length > 0) {
    process.stderr.write(`${JSON.stringify({ level: "warn", operation: "unsupported_tools", names: omittedTools })}\n`);
  }
  const activeModel = resolveModelSlug(inbound.model, options.defaultModel, options.modelSlugs);
  const outgoing = toOpenAIRequest(inbound, activeModel);
  const upstream = await openInference(options, outgoing, clientGone);
  if (inbound.stream) {
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    const encoder = new AnthropicStream(response, activeModel, estimateInputTokens(inbound));
    await readSse(upstream.body!, (event) => encoder.accept(event));
    encoder.assertCompleted();
    response.end();
  } else {
    const accumulator = new MessageAccumulator(activeModel);
    await readSse(upstream.body!, (event) => accumulator.accept(event));
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(accumulator.buildMessage()));
  }
}

async function handleCountTokens(
  options: ResolvedGatewayOptions,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const inbound = parseRequest(await readBody(request, options.maxBodyBytes));
  response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ input_tokens: estimateInputTokens(inbound) }));
}

function toBridgeError(error: Error): BridgeError {
  if (error instanceof BridgeError) return error;
  if (error instanceof z.ZodError) return new BridgeError(502, "invalid_upstream_shape", "OpenAI returned data outside the documented schema.");
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
    modelSlugs: new Set(gatewayOptions.availableModels.map((model) => model.slug)),
  };

  return createServer((request, response) => {
    const hostCheck = checkHost(request.headers);
    if (!hostCheck.ok) {
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
    const clientCheck = checkClient(request.headers, options.policy);
    if (!clientCheck.ok) {
      sendGuardFailure(response, clientCheck);
      return;
    }
    if (request.method === "GET" && path === "/v1/models") {
      const list = options.availableModels.map((model) => ({
        id: model.slug,
        type: "model",
        display_name: `${model.displayName} (ChatGPT Plus)`,
      }));
      list.push(
        { id: "claude-3-7-sonnet-20250219", type: "model", display_name: "Claude 3.7 Sonnet (via ChatGPT)" },
        { id: "claude-3-5-sonnet-20241022", type: "model", display_name: "Claude 3.5 Sonnet (via ChatGPT)" },
        { id: "claude-3-5-haiku-20241022", type: "model", display_name: "Claude 3.5 Haiku (via ChatGPT)" },
      );
      response.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({ data: list, has_more: false, first_id: options.defaultModel, last_id: options.defaultModel }),
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
