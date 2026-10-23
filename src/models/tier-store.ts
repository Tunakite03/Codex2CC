import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { BridgeError } from "../bridge/bridge.js";
import type { GatewayOptions } from "../gateway/gateway.js";
import { resolveDataDir } from "../telemetry/logger.js";
import { DEFAULT_TIER_MODELS, ANTIGRAVITY_TIER_MODELS, PROVIDERS, loadTierModels, type ProviderType, type TierModels } from "./models.js";
import { API_PROVIDERS, ApiProviderConfigsSchema, apiProviderTiers, defaultApiProviderConfig, isApiProvider, parseApiProviderConfig, type ApiProvider, type ApiProviderConfig, type ApiProviderConfigs } from "../providers/config.js";

export const EffortLevel = z.enum(["low", "medium", "high", "xhigh", "max"]);
export type EffortLevel = z.infer<typeof EffortLevel>;

const ModelSlug = z
  .string()
  .trim()
  .min(1, "must not be empty")
  .max(128, "must be at most 128 characters")
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/, "must be a model slug (letters, digits, '.', '_', ':', '/', '-')");

const TierModelsSchema = z.object({ fable: ModelSlug, opus: ModelSlug, sonnet: ModelSlug, haiku: ModelSlug });

const PersistedTierModels = z.object({ version: z.literal(1), tiers: TierModelsSchema });

export const SettingsSchema = z.object({
  version: z.literal(1),
  provider: z.enum(PROVIDERS).optional(),
  providers: ApiProviderConfigsSchema.optional(),
  effort: EffortLevel.optional(),
  tiers: TierModelsSchema.optional(),
  mappings: z.object({
    codex: TierModelsSchema.optional(),
    antigravity: TierModelsSchema.optional(),
    openrouter: TierModelsSchema.optional(),
    openai: TierModelsSchema.optional(),
    opencode: TierModelsSchema.optional(),
  }).optional(),
});
export type Settings = z.infer<typeof SettingsSchema>;

/** Resolves the unified settings file (CODEX2CC_SETTINGS_FILE, CODEX2CC_TIERS_FILE, else <data dir>/logs/settings.json). */
export function resolveTierFilePath(env: NodeJS.ProcessEnv): string {
  const custom = env.CODEX2CC_SETTINGS_FILE?.trim() || env.CODEX2CC_TIERS_FILE?.trim();
  if (custom && custom.length > 0) return resolve(custom);
  return join(resolveDataDir(env), "logs", "settings.json");
}

export const resolveSettingsFilePath = resolveTierFilePath;

/** Validates an untrusted tier mapping; throws a 400 BridgeError naming the first invalid tier. */
export function parseTierModels(input: unknown): TierModels {
  const result = TierModelsSchema.safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0];
    const field = issue?.path.join(".") || "tiers";
    throw new BridgeError(400, "invalid_tier_models", `Tier mapping field "${field}" ${issue?.message ?? "is invalid"}.`);
  }
  return result.data;
}

/** The mapping the gateway should use right now: live store first, then static tiers, then provider defaults. */
export function activeTierModels(options: Pick<GatewayOptions, "tierStore" | "tiers" | "provider">): TierModels {
  const provider = options.provider ?? options.tierStore?.getProvider() ?? "codex";
  if (options.tierStore) return options.tierStore.current(provider);
  if (provider === "codex" && options.tiers) return options.tiers;
  return isApiProvider(provider) ? apiProviderTiers(defaultApiProviderConfig(provider)) : provider === "antigravity" ? ANTIGRAVITY_TIER_MODELS : DEFAULT_TIER_MODELS;
}

function writeWarning(operation: string, message: string, path: string): void {
  process.stderr.write(`${JSON.stringify({ level: "warn", operation, message, path })}\n`);
}

/** Reads unified settings file or falls back to legacy tier-models.json structure. */
function readSavedSettings(filePath: string): Settings | undefined {
  if (!existsSync(filePath)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf8"));
    const parsed = SettingsSchema.safeParse(raw);
    if (parsed.success) {
      const data = parsed.data;
      const codexMapping = data.mappings?.codex ?? data.tiers;
      return {
        ...data,
        mappings: {
          ...data.mappings,
          ...(codexMapping ? { codex: codexMapping } : {}),
          ...(data.mappings?.antigravity ? { antigravity: data.mappings.antigravity } : {}),
        },
      };
    }
    const legacy = PersistedTierModels.safeParse(raw);
    if (legacy.success) {
      return {
        version: 1,
        tiers: legacy.data.tiers,
        mappings: {
          codex: legacy.data.tiers,
        },
      };
    }
    throw new Error("Invalid settings shape");
  } catch (err) {
    writeWarning("settings_load_failed", `Discarding unreadable settings: ${(err as Error).message}`, filePath);
    try {
      renameSync(filePath, `${filePath}.corrupt`);
    } catch (renameErr) {
      writeWarning("settings_backup_failed", (renameErr as Error).message, filePath);
    }
    return undefined;
  }
}

/** Automatically imports legacy tier-models.json and tier-models-antigravity.json if settings.json does not exist. */
function tryMigrateLegacyFiles(settingsPath: string): Settings | undefined {
  if (existsSync(settingsPath)) return undefined;
  const legacyDir = dirname(settingsPath);
  const legacyCodexPath = join(legacyDir, "tier-models.json");
  const legacyAntPath = join(legacyDir, "tier-models-antigravity.json");
  let codexTiers: TierModels | undefined;
  let antTiers: TierModels | undefined;

  if (existsSync(legacyCodexPath)) {
    try {
      codexTiers = PersistedTierModels.parse(JSON.parse(readFileSync(legacyCodexPath, "utf8"))).tiers;
    } catch (err) {
      writeWarning("legacy_settings_unreadable", (err as Error).message, legacyCodexPath);
    }
  }
  if (existsSync(legacyAntPath)) {
    try {
      antTiers = PersistedTierModels.parse(JSON.parse(readFileSync(legacyAntPath, "utf8"))).tiers;
    } catch (err) {
      writeWarning("legacy_settings_unreadable", (err as Error).message, legacyAntPath);
    }
  }

  if (codexTiers || antTiers) {
    return {
      version: 1,
      mappings: {
        ...(codexTiers ? { codex: codexTiers } : {}),
        ...(antTiers ? { antigravity: antTiers } : {}),
      },
    };
  }
  return undefined;
}

/**
 * Filesystem adapter for unified configuration (active provider, default reasoning effort,
 * and per-provider Claude tier model mappings) persisted in a single settings.json file.
 */
export class TierModelStore {
  private activeProvider: ProviderType;
  private effort: EffortLevel | undefined;
  private readonly baselines: Record<ProviderType, TierModels>;
  private readonly customMappings: Map<ProviderType, TierModels> = new Map();
  private readonly providerConfigs: Map<ApiProvider, ApiProviderConfig> = new Map();

  private constructor(
    private readonly filePath: string,
    env: NodeJS.ProcessEnv,
    initialProvider: ProviderType = "codex",
    saved: Settings | undefined,
  ) {
    this.baselines = {
      codex: loadTierModels(env),
      antigravity: ANTIGRAVITY_TIER_MODELS,
      openrouter: apiProviderTiers(defaultApiProviderConfig("openrouter")),
      openai: apiProviderTiers(defaultApiProviderConfig("openai")),
      opencode: apiProviderTiers(defaultApiProviderConfig("opencode")),
    };
    this.activeProvider = saved?.provider ?? initialProvider;
    this.effort = saved?.effort ?? (env.CLAUDE_CODE_EFFORT_LEVEL ? EffortLevel.safeParse(env.CLAUDE_CODE_EFFORT_LEVEL).data : undefined);

    if (saved?.mappings?.codex) {
      this.customMappings.set("codex", saved.mappings.codex);
    } else if (saved?.tiers) {
      this.customMappings.set("codex", saved.tiers);
    }
    for (const provider of PROVIDERS) {
      const mapping = saved?.mappings?.[provider];
      if (mapping) this.customMappings.set(provider, mapping);
    }
    for (const provider of API_PROVIDERS) {
      const config = saved?.providers?.[provider];
      if (config) this.providerConfigs.set(provider, config);
    }
  }

  static open(filePath: string, env: NodeJS.ProcessEnv = process.env, provider: ProviderType = "codex"): TierModelStore {
    const saved = readSavedSettings(filePath) ?? tryMigrateLegacyFiles(filePath);
    return new TierModelStore(filePath, env, provider, saved);
  }

  setProvider(provider: ProviderType): void {
    const previous = this.activeProvider;
    this.activeProvider = provider;
    try { this.persist(); }
    catch (error) { this.activeProvider = previous; throw error; }
  }

  getProvider(): ProviderType {
    return this.activeProvider;
  }

  setEffort(effort: EffortLevel | undefined): void {
    const previous = this.effort;
    this.effort = effort;
    try { this.persist(); }
    catch (error) { this.effort = previous; throw error; }
  }

  getEffort(): EffortLevel | undefined {
    return this.effort;
  }

  current(provider?: ProviderType): TierModels {
    const target = provider ?? this.activeProvider;
    return this.customMappings.get(target) ?? this.defaults(target);
  }

  /** The mapping that applies when nothing is saved (env overrides on top of built-in defaults). */
  defaults(provider?: ProviderType): TierModels {
    const target = provider ?? this.activeProvider;
    return isApiProvider(target) ? apiProviderTiers(this.getApiProviderConfig(target)) : this.baselines[target];
  }

  isCustom(provider?: ProviderType): boolean {
    const target = provider ?? this.activeProvider;
    return this.customMappings.has(target);
  }

  path(): string {
    return this.filePath;
  }

  /** Persists atomically (temp file + rename); the in-memory mapping changes only after the write succeeds. */
  save(tiers: TierModels, provider?: ProviderType): void {
    const target = provider ?? this.activeProvider;
    const next: TierModels = { fable: tiers.fable, opus: tiers.opus, sonnet: tiers.sonnet, haiku: tiers.haiku };
    const previous = this.customMappings.get(target);
    this.customMappings.set(target, next);
    try { this.persist(); }
    catch (error) {
      if (previous) this.customMappings.set(target, previous);
      else this.customMappings.delete(target);
      throw error;
    }
  }

  /** Deletes the saved mapping for the provider and reverts to the env/default baseline. */
  reset(provider?: ProviderType): void {
    const target = provider ?? this.activeProvider;
    const previous = this.customMappings.get(target);
    this.customMappings.delete(target);
    try { this.persist(); }
    catch (error) {
      if (previous) this.customMappings.set(target, previous);
      throw error;
    }
  }

  getApiProviderConfig(provider: ApiProvider): ApiProviderConfig {
    return structuredClone(this.providerConfigs.get(provider) ?? defaultApiProviderConfig(provider));
  }

  saveApiProviderConfig(provider: ApiProvider, input: ApiProviderConfig): void {
    const config = parseApiProviderConfig(input);
    const mapping = this.customMappings.get(provider);
    const slugs = new Set(config.models.map((model) => model.slug));
    if (mapping && Object.values(mapping).some((slug) => !slugs.has(slug))) {
      throw new BridgeError(400, "model_in_use", "Provider configuration removes a model used by a saved tier mapping. Reset or update the mapping first.");
    }
    const previous = this.providerConfigs.get(provider);
    this.providerConfigs.set(provider, config);
    try {
      this.persist();
    } catch (error) {
      if (previous) this.providerConfigs.set(provider, previous);
      else this.providerConfigs.delete(provider);
      throw error;
    }
  }

  private persist(): void {
    const mappings: Partial<Record<ProviderType, TierModels>> = Object.fromEntries(this.customMappings);
    const providers: ApiProviderConfigs = Object.fromEntries(this.providerConfigs);
    const codexMapping = this.customMappings.get("codex");
    const data: Settings = {
      version: 1,
      provider: this.activeProvider,
      ...(this.effort ? { effort: this.effort } : {}),
      // Legacy readers interpret `tiers` as Codex mappings, never as the active API provider.
      ...(codexMapping ? { tiers: codexMapping } : {}),
      mappings,
      providers,
    };
    const tempPath = `${this.filePath}.tmp`;
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(tempPath, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(tempPath, this.filePath);
  }
}

export const SettingsStore = TierModelStore;
