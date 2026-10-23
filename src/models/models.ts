export const API_PROVIDERS = ["openrouter", "openai", "opencode", "anthropic", "gemini", "deepseek", "groq", "xai", "mistral", "custom"] as const;
export const PROVIDERS = ["codex", "antigravity", ...API_PROVIDERS] as const;
export type ProviderType = typeof PROVIDERS[number];
export const PROVIDER_LABELS: Readonly<Record<ProviderType, string>> = {
  codex: "ChatGPT", antigravity: "Google Antigravity", openrouter: "OpenRouter", openai: "OpenAI API", opencode: "OpenCode",
  anthropic: "Anthropic", gemini: "Google Gemini", deepseek: "DeepSeek", groq: "Groq",
  xai: "xAI", mistral: "Mistral", custom: "Custom provider",
};
export function isProviderType(value: string): value is ProviderType {
  return PROVIDERS.some((provider) => provider === value);
}

export type Tier = "fable" | "opus" | "sonnet" | "haiku";
export type TierModels = Readonly<Record<Tier, string>>;

export const DEFAULT_TIER_MODELS: TierModels = {
  fable: "gpt-6-astra",
  opus: "gpt-6.1-sol",
  sonnet: "gpt-6-sol",
  haiku: "gpt-6-luna",
};

export const ANTIGRAVITY_TIER_MODELS: TierModels = {
  fable: "gemini-3.8-flash-high",
  opus: "claude-opus-4-6-thinking",
  sonnet: "claude-sonnet-4-6",
  haiku: "gemini-3.8-flash-low",
};

export const ANTIGRAVITY_DEFAULT_MODEL = "claude-sonnet-4-6";

export type ModelCatalogItem = {
  readonly slug: string;
  readonly displayName: string;
  readonly contextWindow?: number;
};

/** Mirrors the output of `agy models`; keep in sync when Antigravity adds or retires models. */
export const ANTIGRAVITY_MODELS: readonly ModelCatalogItem[] = [
  { slug: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6 (Thinking)", contextWindow: 200_000 },
  { slug: "claude-opus-4-6-thinking", displayName: "Claude Opus 4.6 (Thinking)", contextWindow: 200_000 },
  { slug: "gemini-3.8-flash-high", displayName: "Gemini 3.8 Flash (High)", contextWindow: 1_000_000 },
  { slug: "gemini-3.8-flash-medium", displayName: "Gemini 3.8 Flash (Medium)", contextWindow: 1_000_000 },
  { slug: "gemini-3.8-flash-low", displayName: "Gemini 3.8 Flash (Low)", contextWindow: 1_000_000 },
  { slug: "gemini-3.7-flash-high", displayName: "Gemini 3.7 Flash (High)", contextWindow: 1_000_000 },
  { slug: "gemini-3.7-flash-medium", displayName: "Gemini 3.7 Flash (Medium)", contextWindow: 1_000_000 },
  { slug: "gemini-3.7-flash-low", displayName: "Gemini 3.7 Flash (Low)", contextWindow: 1_000_000 },
  { slug: "gemini-3.6-flash-high", displayName: "Gemini 3.6 Flash (High)", contextWindow: 1_000_000 },
  { slug: "gemini-3.6-flash-medium", displayName: "Gemini 3.6 Flash (Medium)", contextWindow: 1_000_000 },
  { slug: "gemini-3.6-flash-low", displayName: "Gemini 3.6 Flash (Low)", contextWindow: 1_000_000 },
  { slug: "gemini-3.1-pro-high", displayName: "Gemini 3.1 Pro (High)", contextWindow: 2_000_000 },
  { slug: "gemini-3.1-pro-low", displayName: "Gemini 3.1 Pro (Low)", contextWindow: 2_000_000 },
  { slug: "gpt-oss-120b-medium", displayName: "GPT-OSS 120B (Medium)", contextWindow: 128_000 },
];

/** Catalog shown while no ChatGPT session exists, so the control panel can still render tier mappings. */
export const OFFLINE_CODEX_MODELS: readonly ModelCatalogItem[] = [
  { slug: "gpt-6-astra", displayName: "ChatGPT Fable Tier (gpt-6-astra)" },
  { slug: "gpt-6-sol", displayName: "ChatGPT Sonnet Tier (gpt-6-sol)" },
  { slug: "gpt-6.1-sol", displayName: "ChatGPT Opus Tier (gpt-6.1-sol)" },
  { slug: "gpt-6-luna", displayName: "ChatGPT Haiku Tier (gpt-6-luna)" },
];

export const CLAUDE_GATEWAY_MODELS = [
  { id: "claude-sonnet-5-5", tier: "sonnet" },
  { id: "claude-opus-5-5", tier: "opus" },
  { id: "claude-haiku-5", tier: "haiku" },
  { id: "claude-fable-5-1", tier: "fable" },
] as const;

export type ModelResolution = {
  readonly slug: string;
  /** True when the requested model is unknown and the default was substituted. */
  readonly fellBack: boolean;
};

/** Reads CODEX2CC_MODEL_FABLE / _OPUS / _SONNET / _HAIKU overrides; blank values keep the defaults. */
export function loadTierModels(env: NodeJS.ProcessEnv): TierModels {
  return {
    fable: env.CODEX2CC_MODEL_FABLE?.trim() || DEFAULT_TIER_MODELS.fable,
    opus: env.CODEX2CC_MODEL_OPUS?.trim() || DEFAULT_TIER_MODELS.opus,
    sonnet: env.CODEX2CC_MODEL_SONNET?.trim() || DEFAULT_TIER_MODELS.sonnet,
    haiku: env.CODEX2CC_MODEL_HAIKU?.trim() || DEFAULT_TIER_MODELS.haiku,
  };
}

/**
 * The smallest known context window among `slugs`, for CLAUDE_CODE_MAX_CONTEXT_TOKENS: Claude Code
 * applies one window to whichever routed model is active, so the tightest one must not overflow.
 */
export function smallestContextWindow(catalog: readonly ModelCatalogItem[], slugs: readonly string[]): number | undefined {
  const windows = catalog
    .filter((model) => slugs.includes(model.slug) && model.contextWindow !== undefined)
    .map((model) => model.contextWindow as number);
  return windows.length === 0 ? undefined : Math.min(...windows);
}

/** Every account model a Claude Code session can reach: the default plus each tier route, Fable included. */
export function routedModels(tiers: TierModels, defaultModel: string): string[] {
  return [defaultModel, tiers.fable, tiers.opus, tiers.sonnet, tiers.haiku];
}

/** The model for a Claude tier when the account has it, otherwise `fallback`. */
export function tierModel(tiers: TierModels, tier: Tier, available: ReadonlySet<string>, fallback: string): string {
  return available.has(tiers[tier]) ? tiers[tier] : fallback;
}

/**
 * Maps the model name Claude Code asked for to an account model: exact slug first, then the
 * Claude tier named in it (fable, opus, haiku, sonnet), then the default.
 */
export function resolveModel(
  requested: string | undefined,
  defaultModel: string,
  available: ReadonlySet<string>,
  tiers: TierModels,
): ModelResolution {
  if (!requested) return { slug: defaultModel, fellBack: false };
  if (available.has(requested)) return { slug: requested, fellBack: false };
  const lower = requested.toLowerCase();
  for (const tier of ["fable", "opus", "haiku", "sonnet"] as const) {
    if (lower.includes(tier) && available.has(tiers[tier])) return { slug: tiers[tier], fellBack: false };
  }
  return { slug: defaultModel, fellBack: true };
}
