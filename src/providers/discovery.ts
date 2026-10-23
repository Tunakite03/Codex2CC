import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { BridgeError } from "../bridge/bridge.js";
import { recordLog } from "../telemetry/logger.js";
import { ApiModelSchema, requireApiKey, type ApiModel, type ApiProtocol, type ApiProvider, type ApiProviderConfig } from "./config.js";

const MAX_ATTEMPTS = 3;
const MAX_PAGES = 10;
const REQUEST_TIMEOUT_MS = 30_000;
const ANTHROPIC_PAGE_LIMIT = 1000;
const ANTHROPIC_VERSION = "2023-06-01";

/** Model families listed beside chat models that no adapter protocol can serve. */
const NON_CHAT_MODEL = /embed|moderation|whisper|transcri|speech|\btts\b|audio|image|dall-e|rerank|realtime/i;

/** Each protocol's endpoint ends with a fixed resource path; the model list sits beside it. */
const RESOURCE_SUFFIX: Readonly<Record<ApiProtocol, string>> = {
  "chat-completions": "/chat/completions",
  responses: "/responses",
  "anthropic-messages": "/messages",
};

const ModelListPage = z.object({
  data: z.array(z.object({
    id: z.string(),
    display_name: z.string().nullish(),
    name: z.string().nullish(),
    context_length: z.number().int().positive().nullish(),
    max_input_tokens: z.number().int().positive().nullish(),
  })),
  has_more: z.boolean().nullish(),
  last_id: z.string().nullish(),
});
type ModelListPage = z.infer<typeof ModelListPage>;
type ModelListEntry = ModelListPage["data"][number];

/** Derives the list URL from the endpoint the user configured, so host, path prefix and credentials match. */
export function modelsUrlFor(endpoint: string, protocol: ApiProtocol): URL {
  const url = new URL(endpoint);
  const suffix = RESOURCE_SUFFIX[protocol];
  if (!url.pathname.endsWith(suffix)) {
    throw new BridgeError(400, "model_discovery_unsupported", `Cannot find the model list: the ${protocol} endpoint must end with "${suffix}".`);
  }
  url.pathname = `${url.pathname.slice(0, -suffix.length)}/models`;
  return url;
}

/** Keeps chat-capable entries that pass the catalog schema; each rejected id is reported, never dropped silently. */
export function toDiscoveredModels(entries: readonly ModelListEntry[], protocol: ApiProtocol): { readonly models: ApiModel[]; readonly skipped: string[] } {
  const seen = new Set<string>();
  const models: ApiModel[] = [];
  const skipped: string[] = [];
  for (const entry of entries) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    if (NON_CHAT_MODEL.test(entry.id)) continue;
    const parsed = ApiModelSchema.safeParse({
      slug: entry.id,
      displayName: entry.display_name ?? entry.name ?? entry.id,
      protocol,
      reasoning: "none",
      contextWindow: entry.context_length ?? entry.max_input_tokens ?? undefined,
    });
    if (parsed.success) models.push(parsed.data);
    else skipped.push(entry.id);
  }
  return { models, skipped };
}

function authHeaders(protocol: ApiProtocol, apiKey: string): Readonly<Record<string, string>> {
  if (protocol === "anthropic-messages") return { Accept: "application/json", "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION };
  return { Accept: "application/json", Authorization: `Bearer ${apiKey}` };
}

/** Retries connection failures and gateway errors only; credentials are never sent to a redirect target. */
async function fetchPage(url: URL, headers: Readonly<Record<string, string>>, provider: ApiProvider, signal: AbortSignal): Promise<ModelListPage> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
    let response: Response;
    try {
      response = await fetch(url, { method: "GET", headers, redirect: "error", signal: requestSignal });
    } catch (error) {
      if (signal.aborted) throw error;
      if (requestSignal.aborted) throw new BridgeError(504, "provider_timeout", `${provider} model listing timed out.`);
      if (!(error instanceof TypeError)) throw error;
      if (attempt === MAX_ATTEMPTS) throw new BridgeError(502, "provider_unreachable", `${provider} model listing could not connect to its configured endpoint.`);
      recordLog({ level: "warn", operation: "provider_models_retry", message: "Retrying provider model listing after connection failure", details: { provider, attempt } });
      await delay(300 * attempt, undefined, { signal });
      continue;
    }
    if ([502, 503, 504].includes(response.status) && attempt < MAX_ATTEMPTS) {
      await response.body?.cancel();
      recordLog({ level: "warn", operation: "provider_models_retry", message: "Retrying provider model listing after temporary HTTP failure", details: { provider, attempt, status: response.status } });
      await delay(300 * attempt, undefined, { signal });
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      const status = response.status >= 400 && response.status < 500 ? response.status : 502;
      throw new BridgeError(status, "model_discovery_failed", `${provider} model listing returned HTTP ${response.status}. Check the API key and endpoint.`);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw new BridgeError(502, "invalid_model_list", `${provider} model listing was not valid JSON.`);
    }
    const parsed = ModelListPage.safeParse(payload);
    if (!parsed.success) throw new BridgeError(502, "invalid_model_list", `${provider} model listing did not match the expected shape.`);
    return parsed.data;
  }
  throw new BridgeError(502, "provider_unreachable", `${provider} model listing exhausted its retry budget.`);
}

/** Lists the models a provider serves. Discovered models use the default model's protocol and reasoning "none". */
export async function discoverApiModels(provider: ApiProvider, config: ApiProviderConfig, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<readonly ApiModel[]> {
  const defaultModel = config.models.find((model) => model.slug === config.defaultModel);
  if (!defaultModel) throw new BridgeError(400, "model_unavailable", `Default model "${config.defaultModel}" is not in the ${provider} model catalog.`);
  const endpoint = config.endpoints[defaultModel.protocol];
  if (!endpoint) throw new BridgeError(400, "missing_provider_endpoint", `Default model "${defaultModel.slug}" uses ${defaultModel.protocol}, which has no configured endpoint.`);
  const apiKey = requireApiKey(config, env);
  const listUrl = modelsUrlFor(endpoint, defaultModel.protocol);
  const headers = authHeaders(defaultModel.protocol, apiKey);
  const entries: ModelListEntry[] = [];
  let afterId: string | undefined;
  for (let pageNumber = 1; pageNumber <= MAX_PAGES; pageNumber++) {
    const pageUrl = new URL(listUrl);
    if (defaultModel.protocol === "anthropic-messages") pageUrl.searchParams.set("limit", String(ANTHROPIC_PAGE_LIMIT));
    if (afterId !== undefined) pageUrl.searchParams.set("after_id", afterId);
    const page = await fetchPage(pageUrl, headers, provider, signal);
    entries.push(...page.data);
    if (page.has_more !== true) {
      const { models, skipped } = toDiscoveredModels(entries, defaultModel.protocol);
      if (skipped.length > 0) {
        recordLog({ level: "warn", operation: "provider_models_skipped", message: "Skipped provider models that do not fit the catalog schema", details: { provider, count: skipped.length } });
      }
      return models;
    }
    if (!page.last_id) throw new BridgeError(502, "invalid_model_list", `${provider} reported more models without a cursor.`);
    afterId = page.last_id;
  }
  throw new BridgeError(502, "model_list_too_long", `${provider} listed more than ${MAX_PAGES} pages of models.`);
}
