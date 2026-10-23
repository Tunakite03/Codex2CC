import { z } from "zod";
import { BridgeError } from "../bridge/bridge.js";
import { API_PROVIDERS, type ProviderType, type TierModels } from "../models/models.js";

export { API_PROVIDERS };
export type ApiProvider = typeof API_PROVIDERS[number];
export const ApiProviderSchema = z.enum(API_PROVIDERS);
export const ApiProtocolSchema = z.enum(["chat-completions", "responses", "anthropic-messages"]);
export type ApiProtocol = z.infer<typeof ApiProtocolSchema>;
export const ModelSlugSchema = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);

const EndpointSchema = z.string().url().superRefine((value, context) => {
  let url: URL;
  try { url = new URL(value); }
  catch (error) {
    if (!(error instanceof TypeError)) throw error;
    context.addIssue({ code: "custom", message: "must be a valid absolute URL" });
    return;
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username || url.password || url.search || url.hash) {
    context.addIssue({ code: "custom", message: "must use HTTPS (or loopback HTTP), without credentials, query parameters or fragments" });
  }
});

export const ApiModelSchema = z.object({
  slug: ModelSlugSchema,
  displayName: z.string().trim().min(1).max(160),
  protocol: ApiProtocolSchema,
  reasoning: z.enum(["none", "openai", "openrouter"]).default("none"),
  contextWindow: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
}).superRefine((model, context) => {
  if (model.protocol === "anthropic-messages" && model.reasoning !== "none") {
    context.addIssue({ code: "custom", path: ["reasoning"], message: "Anthropic Messages models must use native thinking, not OpenAI reasoning controls" });
  }
  if (model.protocol === "responses" && model.reasoning === "openrouter") {
    context.addIssue({ code: "custom", path: ["reasoning"], message: "Responses models require openai or none reasoning controls" });
  }
});
export type ApiModel = z.infer<typeof ApiModelSchema>;

/** URLs are complete resource endpoints, so a provider's model protocols need not share a base URL. */
export const ApiProviderConfigSchema = z.object({
  apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*_API_KEY$/, "must name an environment variable ending in _API_KEY"),
  endpoints: z.object({
    "chat-completions": EndpointSchema.optional(),
    responses: EndpointSchema.optional(),
    "anthropic-messages": EndpointSchema.optional(),
  }),
  defaultModel: ModelSlugSchema,
  models: z.array(ApiModelSchema).min(1).max(200),
}).superRefine((config, context) => {
  const slugs = new Set<string>();
  for (const [index, model] of config.models.entries()) {
    if (slugs.has(model.slug)) context.addIssue({ code: "custom", path: ["models", index, "slug"], message: "model slugs must be unique" });
    slugs.add(model.slug);
    if (config.endpoints[model.protocol] === undefined) {
      context.addIssue({ code: "custom", path: ["models", index, "protocol"], message: "requires a configured endpoint for this protocol" });
    }
  }
  if (!slugs.has(config.defaultModel)) context.addIssue({ code: "custom", path: ["defaultModel"], message: "must exist in the configured models" });
});
export type ApiProviderConfig = z.infer<typeof ApiProviderConfigSchema>;
export const ApiProviderConfigsSchema = z.partialRecord(ApiProviderSchema, ApiProviderConfigSchema);
export type ApiProviderConfigs = z.infer<typeof ApiProviderConfigsSchema>;

const DEFAULT_CONFIGS: Readonly<Record<ApiProvider, ApiProviderConfig>> = {
  openrouter: {
    apiKeyEnv: "OPENROUTER_API_KEY",
    endpoints: { "chat-completions": "https://openrouter.ai/api/v1/chat/completions" },
    defaultModel: "anthropic/claude-sonnet-4.6",
    models: [{ slug: "anthropic/claude-sonnet-4.6", displayName: "Claude Sonnet 4.6", protocol: "chat-completions", reasoning: "openrouter" }],
  },
  openai: {
    apiKeyEnv: "OPENAI_API_KEY",
    endpoints: { responses: "https://api.openai.com/v1/responses", "chat-completions": "https://api.openai.com/v1/chat/completions" },
    defaultModel: "gpt-5.5",
    models: [{ slug: "gpt-5.5", displayName: "GPT-5.5", protocol: "responses", reasoning: "openai" }],
  },
  opencode: {
    apiKeyEnv: "OPENCODE_API_KEY",
    endpoints: {
      "chat-completions": "https://opencode.ai/inference/openai/v1/chat/completions",
      responses: "https://opencode.ai/inference/openai/v1/responses",
      "anthropic-messages": "https://opencode.ai/inference/anthropic/v1/messages",
    },
    defaultModel: "gpt-5.5",
    models: [
      { slug: "gpt-5.5", displayName: "GPT-5.5", protocol: "responses", reasoning: "openai" },
      { slug: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6", protocol: "anthropic-messages", reasoning: "none" },
      { slug: "deepseek-v4.1-flash", displayName: "DeepSeek V4.1 Flash", protocol: "chat-completions", reasoning: "none" },
      { slug: "kimi-k3", displayName: "Kimi K3", protocol: "chat-completions", reasoning: "none" },
    ],
  },
  anthropic: {
    apiKeyEnv: "ANTHROPIC_API_KEY",
    endpoints: { "anthropic-messages": "https://api.anthropic.com/v1/messages" },
    defaultModel: "claude-sonnet-5-5",
    models: [{ slug: "claude-sonnet-5-5", displayName: "Claude Sonnet 5.5", protocol: "anthropic-messages", reasoning: "none" }],
  },
  gemini: {
    apiKeyEnv: "GEMINI_API_KEY",
    endpoints: { "chat-completions": "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions" },
    defaultModel: "gemini-3.8-flash",
    models: [{ slug: "gemini-3.8-flash", displayName: "Gemini 3.8 Flash", protocol: "chat-completions", reasoning: "none" }],
  },
  deepseek: {
    apiKeyEnv: "DEEPSEEK_API_KEY",
    endpoints: { "chat-completions": "https://api.deepseek.com/chat/completions" },
    defaultModel: "deepseek-flash",
    models: [{ slug: "deepseek-flash", displayName: "DeepSeek Flash", protocol: "chat-completions", reasoning: "none" }],
  },
  groq: {
    apiKeyEnv: "GROQ_API_KEY",
    endpoints: { "chat-completions": "https://api.groq.com/openai/v1/chat/completions" },
    defaultModel: "openai/gpt-oss-120b",
    models: [{ slug: "openai/gpt-oss-120b", displayName: "GPT-OSS 120B", protocol: "chat-completions", reasoning: "none" }],
  },
  xai: {
    apiKeyEnv: "XAI_API_KEY",
    endpoints: { "chat-completions": "https://api.x.ai/v1/chat/completions" },
    defaultModel: "grok-4.20-0309-non-reasoning",
    models: [{ slug: "grok-4.20-0309-non-reasoning", displayName: "Grok 4.20 Non-Reasoning", protocol: "chat-completions", reasoning: "none" }],
  },
  mistral: {
    apiKeyEnv: "MISTRAL_API_KEY",
    endpoints: { "chat-completions": "https://api.mistral.ai/v1/chat/completions" },
    defaultModel: "mistral-large-latest",
    models: [{ slug: "mistral-large-latest", displayName: "Mistral Large", protocol: "chat-completions", reasoning: "none" }],
  },
  custom: {
    apiKeyEnv: "CUSTOM_API_KEY",
    endpoints: { "chat-completions": "http://127.0.0.1:8000/v1/chat/completions" },
    defaultModel: "custom-model",
    models: [{ slug: "custom-model", displayName: "Custom model", protocol: "chat-completions", reasoning: "none" }],
  },
};

export function isApiProvider(provider: ProviderType): provider is ApiProvider {
  return API_PROVIDERS.some((candidate) => candidate === provider);
}

export function defaultApiProviderConfig(provider: ApiProvider): ApiProviderConfig {
  return structuredClone(DEFAULT_CONFIGS[provider]);
}

export function apiProviderTiers(config: ApiProviderConfig): TierModels {
  return { fable: config.defaultModel, opus: config.defaultModel, sonnet: config.defaultModel, haiku: config.defaultModel };
}

export function parseApiProviderConfig(input: unknown): ApiProviderConfig {
  const parsed = ApiProviderConfigSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new BridgeError(400, "invalid_provider_config", `Provider configuration field "${issue?.path.join(".") ?? "body"}" ${issue?.message ?? "is invalid"}.`);
  }
  return parsed.data;
}

/** Reads only the explicitly configured credential. Values never enter status responses or settings. */
export function requireApiKey(config: ApiProviderConfig, env: NodeJS.ProcessEnv): string {
  const key = env[config.apiKeyEnv]?.trim();
  if (!key) throw new BridgeError(401, "missing_provider_key", `Set ${config.apiKeyEnv} in the gateway environment and restart the gateway.`);
  if (!/^[\x21-\x7e]+$/.test(key)) throw new BridgeError(400, "invalid_provider_key", `${config.apiKeyEnv} contains invalid header characters.`);
  return key;
}

export function hasApiKey(config: ApiProviderConfig, env: NodeJS.ProcessEnv): boolean {
  const key = env[config.apiKeyEnv]?.trim();
  return key !== undefined && /^[\x21-\x7e]+$/.test(key);
}
