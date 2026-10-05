import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { BridgeError } from "../bridge/bridge.js";
import type { GatewayOptions } from "../gateway/gateway.js";
import { resolveProjectRoot } from "../telemetry/logger.js";
import { DEFAULT_TIER_MODELS, loadTierModels, type TierModels } from "./models.js";

const ModelSlug = z
  .string()
  .trim()
  .min(1, "must not be empty")
  .max(128, "must be at most 128 characters")
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/, "must be a model slug (letters, digits, '.', '_', ':', '/', '-')");

const TierModelsSchema = z.object({ fable: ModelSlug, opus: ModelSlug, sonnet: ModelSlug, haiku: ModelSlug });

const PersistedTierModels = z.object({ version: z.literal(1), tiers: TierModelsSchema });

/** Resolves the saved mapping file (CODEX2CC_TIERS_FILE, else <project>/logs/tier-models.json). */
export function resolveTierFilePath(env: NodeJS.ProcessEnv): string {
  const custom = env.CODEX2CC_TIERS_FILE?.trim();
  if (custom && custom.length > 0) return resolve(custom);
  return join(resolveProjectRoot(), "logs", "tier-models.json");
}

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

/** The mapping the gateway should use right now: live store first, then static tiers, then built-in defaults. */
export function activeTierModels(options: Pick<GatewayOptions, "tierStore" | "tiers">): TierModels {
  return options.tierStore?.current() ?? options.tiers ?? DEFAULT_TIER_MODELS;
}

function writeWarning(operation: string, message: string, path: string): void {
  process.stderr.write(`${JSON.stringify({ level: "warn", operation, message, path })}\n`);
}

/** A corrupt file is moved aside to `<path>.corrupt` so the env/default mapping applies instead. */
function readSavedTiers(filePath: string): TierModels | undefined {
  if (!existsSync(filePath)) return undefined;
  try {
    return PersistedTierModels.parse(JSON.parse(readFileSync(filePath, "utf8"))).tiers;
  } catch (err) {
    writeWarning("tier_mapping_load_failed", `Discarding unreadable tier mapping: ${(err as Error).message}`, filePath);
    try {
      renameSync(filePath, `${filePath}.corrupt`);
    } catch (renameErr) {
      writeWarning("tier_mapping_backup_failed", (renameErr as Error).message, filePath);
    }
    return undefined;
  }
}

/**
 * Filesystem adapter for the UI-editable Claude tier -> ChatGPT model mapping.
 * Precedence: saved file > CODEX2CC_MODEL_* env vars > DEFAULT_TIER_MODELS.
 */
export class TierModelStore {
  private tiers: TierModels;
  private custom: boolean;

  private constructor(
    private readonly filePath: string,
    private readonly baseline: TierModels,
    saved: TierModels | undefined,
  ) {
    this.tiers = saved ?? baseline;
    this.custom = saved !== undefined;
  }

  static open(filePath: string, env: NodeJS.ProcessEnv): TierModelStore {
    return new TierModelStore(filePath, loadTierModels(env), readSavedTiers(filePath));
  }

  current(): TierModels {
    return this.tiers;
  }

  /** The mapping that applies when nothing is saved (env overrides on top of built-in defaults). */
  defaults(): TierModels {
    return this.baseline;
  }

  isCustom(): boolean {
    return this.custom;
  }

  path(): string {
    return this.filePath;
  }

  /** Persists atomically (temp file + rename); the in-memory mapping changes only after the write succeeds. */
  save(tiers: TierModels): void {
    const next: TierModels = { fable: tiers.fable, opus: tiers.opus, sonnet: tiers.sonnet, haiku: tiers.haiku };
    const tempPath = `${this.filePath}.tmp`;
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(tempPath, `${JSON.stringify({ version: 1, tiers: next }, null, 2)}\n`, "utf8");
    renameSync(tempPath, this.filePath);
    this.tiers = next;
    this.custom = true;
  }

  /** Deletes the saved mapping and reverts to the env/default baseline. */
  reset(): void {
    rmSync(this.filePath, { force: true });
    this.tiers = this.baseline;
    this.custom = false;
  }
}
