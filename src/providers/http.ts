import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { BridgeError } from "../bridge/bridge.js";
import { recordLog } from "../telemetry/logger.js";
import type { ApiProtocol, ApiProvider } from "./config.js";

const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 600_000;
const MAX_ERROR_BYTES = 65_536;
const ErrorBody = z.object({ error: z.object({
  code: z.union([z.string(), z.number()]).nullable().optional(),
  type: z.string().optional(),
  message: z.string().optional(),
}) });

export type ApiInference = {
  readonly provider: ApiProvider;
  readonly protocol: ApiProtocol;
  readonly url: string;
  readonly apiKey: string;
  readonly body: object;
  readonly signal: AbortSignal;
};

function retryAfter(header: string | null): number | undefined {
  if (header === null) return undefined;
  if (/^\d+$/.test(header.trim())) return Number(header.trim());
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, Math.ceil((date - Date.now()) / 1000)) : undefined;
}

async function readErrorBody(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < MAX_ERROR_BYTES) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const bytes = chunk.value.subarray(0, MAX_ERROR_BYTES - size);
      chunks.push(bytes);
      size += bytes.length;
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function httpError(response: Response, request: ApiInference): Promise<BridgeError> {
  const text = await readErrorBody(response);
  let detail = "The provider rejected the request.";
  let code = "inference_failed";
  try {
    const parsed = ErrorBody.safeParse(JSON.parse(text));
    if (parsed.success) {
      detail = (parsed.data.error.message ?? detail).replaceAll(request.apiKey, "[REDACTED]").slice(0, 500);
      const upstreamCode = parsed.data.error.code;
      if (typeof upstreamCode === "string" && /^[a-z_]{1,80}$/.test(upstreamCode)) code = upstreamCode;
    }
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  if (/context_(length|window|limit)_exceeded/.test(code) || (response.status === 400 && /context (window|length)|prompt is too long/i.test(detail))) {
    return new BridgeError(400, "context_length_exceeded", detail);
  }
  const status = response.status >= 400 && response.status < 500 ? response.status : 502;
  return new BridgeError(status, code, `${request.provider} inference returned HTTP ${response.status}: ${detail}`, status === 429 ? retryAfter(response.headers.get("retry-after")) : undefined);
}

/** Retries only before a stream is handed to the caller. Redirects cannot forward provider credentials. */
export async function openApiInference(request: ApiInference): Promise<Response> {
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "text/event-stream" };
  if (request.protocol === "anthropic-messages") {
    headers["x-api-key"] = request.apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else {
    headers.Authorization = `Bearer ${request.apiKey}`;
  }
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    signal.throwIfAborted();
    let response: Response;
    try {
      response = await fetch(request.url, { method: "POST", headers, body: JSON.stringify(request.body), redirect: "error", signal });
    } catch (error) {
      if (request.signal.aborted) throw error;
      if (signal.aborted) throw new BridgeError(504, "provider_timeout", `${request.provider} inference timed out.`);
      if (!(error instanceof TypeError)) throw error;
      if (attempt === MAX_ATTEMPTS) throw new BridgeError(502, "provider_unreachable", `${request.provider} inference could not connect to its configured endpoint.`);
      recordLog({ level: "warn", operation: "provider_retry", message: "Retrying provider connection failure", details: { provider: request.provider, attempt } });
      await delay(300 * attempt, undefined, { signal });
      continue;
    }
    if ([502, 503, 504].includes(response.status) && attempt < MAX_ATTEMPTS) {
      await response.body?.cancel();
      recordLog({ level: "warn", operation: "provider_retry", message: "Retrying temporary provider HTTP failure", details: { provider: request.provider, attempt, status: response.status } });
      await delay(300 * attempt, undefined, { signal });
      continue;
    }
    if (!response.ok) throw await httpError(response, request);
    if (!response.body || !response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) {
      await response.body?.cancel();
      throw new BridgeError(502, "invalid_provider_stream", `${request.provider} did not return a server-sent event stream.`);
    }
    return response;
  }
  throw new BridgeError(502, "provider_unreachable", `${request.provider} inference exhausted its retry budget.`);
}
