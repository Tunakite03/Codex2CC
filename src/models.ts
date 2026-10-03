export type Tier = "opus" | "sonnet" | "haiku";
export type TierModels = Readonly<Record<Tier, string>>;

export const DEFAULT_TIER_MODELS: TierModels = {
  opus: "gpt-6.1-sol",
  sonnet: "gpt-6-sol",
  haiku: "gpt-6-luna",
};

export type ModelResolution = {
  readonly slug: string;
  /** True when the requested model is unknown and the default was substituted. */
  readonly fellBack: boolean;
};

/** Reads CODEX2CC_MODEL_OPUS / _SONNET / _HAIKU overrides; blank values keep the defaults. */
export function loadTierModels(env: NodeJS.ProcessEnv): TierModels {
  return {
    opus: env.CODEX2CC_MODEL_OPUS?.trim() || DEFAULT_TIER_MODELS.opus,
    sonnet: env.CODEX2CC_MODEL_SONNET?.trim() || DEFAULT_TIER_MODELS.sonnet,
    haiku: env.CODEX2CC_MODEL_HAIKU?.trim() || DEFAULT_TIER_MODELS.haiku,
  };
}

/** The model for a Claude tier when the account has it, otherwise `fallback`. */
export function tierModel(tiers: TierModels, tier: Tier, available: ReadonlySet<string>, fallback: string): string {
  return available.has(tiers[tier]) ? tiers[tier] : fallback;
}

/**
 * Maps the model name Claude Code asked for to an account model: exact slug first, then the
 * Claude tier named in it (opus, haiku, sonnet), then the default.
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
  for (const tier of ["opus", "haiku", "sonnet"] as const) {
    if (lower.includes(tier) && available.has(tiers[tier])) return { slug: tiers[tier], fellBack: false };
  }
  return { slug: defaultModel, fellBack: true };
}
