import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { resolveDataDir } from "./logger.js";

export type ModelUsage = {
  readonly model: string;
  readonly requests: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedTokens: number;
  readonly totalTokens: number;
  readonly lastUsed: string;
};

export type TokenUsageSummary = {
  readonly totalRequests: number;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly totalCachedTokens: number;
  readonly grandTotalTokens: number;
  readonly models: readonly ModelUsage[];
};

type ModelUsageState = {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  lastUsed: string;
};

const usageStore = new Map<string, ModelUsageState>();

export type UsageSubscriber = (summary: TokenUsageSummary) => void;
const usageSubscribers = new Set<UsageSubscriber>();

export function onUsageUpdated(subscriber: UsageSubscriber): () => void {
  usageSubscribers.add(subscriber);
  return () => {
    usageSubscribers.delete(subscriber);
  };
}

function notifyUsageSubscribers(): void {
  if (usageSubscribers.size === 0) return;
  const summary = getTokenUsageStats();
  for (const subscriber of usageSubscribers) {
    try {
      subscriber(summary);
    } catch {
      // Ignore subscriber failures to maintain usage tracker resilience
    }
  }
}

const persistedUsageSchema = z.object({
  version: z.literal(1),
  models: z.record(
    z.string(),
    z.object({
      requests: z.number().int().nonnegative(),
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
      cachedTokens: z.number().int().nonnegative(),
      lastUsed: z.string(),
    }),
  ),
});

let usageFilePath: string | null = null;

/**
 * Resolves the usage persistence file (CODEX2CC_USAGE_FILE, else <data dir>/logs/usage.json).
 */
export function resolveUsageFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const custom = env.CODEX2CC_USAGE_FILE?.trim();
  if (custom && custom.length > 0) return resolve(custom);
  return join(resolveDataDir(env), "logs", "usage.json");
}

function writeWarning(operation: string, message: string, path: string): void {
  process.stderr.write(`${JSON.stringify({ level: "warn", operation, message, path })}\n`);
}

function saveUsage(): void {
  if (usageFilePath === null) return;
  const models: Record<string, ModelUsageState> = {};
  for (const [model, state] of usageStore.entries()) models[model] = { ...state };
  const tempPath = `${usageFilePath}.tmp`;
  try {
    mkdirSync(dirname(usageFilePath), { recursive: true });
    writeFileSync(tempPath, JSON.stringify({ version: 1, models }), "utf8");
    renameSync(tempPath, usageFilePath);
  } catch (err) {
    writeWarning("usage_save_failed", (err as Error).message, usageFilePath);
  }
}

/**
 * Enables on-disk persistence: loads existing counters from `path` and saves after every change.
 * A corrupt file is moved aside to `<path>.corrupt` and counters start empty.
 */
export function enableUsagePersistence(path: string): void {
  usageFilePath = path;
  usageStore.clear();
  if (!existsSync(path)) return;
  try {
    const parsed = persistedUsageSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    for (const [model, state] of Object.entries(parsed.models)) usageStore.set(model, { ...state });
  } catch (err) {
    writeWarning("usage_load_failed", `Discarding unreadable usage file: ${(err as Error).message}`, path);
    try {
      renameSync(path, `${path}.corrupt`);
    } catch (renameErr) {
      writeWarning("usage_backup_failed", (renameErr as Error).message, path);
    }
  }
}

/**
 * Records tokens consumed by a completed inference request.
 */
export function recordTokenUsage(params: {
  readonly model: string;
  readonly inputTokens?: number | undefined;
  readonly outputTokens?: number | undefined;
  readonly cachedTokens?: number | undefined;
}): void {
  const model = params.model.trim() || "unknown";
  const input = Math.max(0, Math.floor(params.inputTokens ?? 0));
  const output = Math.max(0, Math.floor(params.outputTokens ?? 0));
  const cached = Math.max(0, Math.floor(params.cachedTokens ?? 0));

  const existing = usageStore.get(model);
  if (existing) {
    existing.requests += 1;
    existing.inputTokens += input;
    existing.outputTokens += output;
    existing.cachedTokens += cached;
    existing.lastUsed = new Date().toISOString();
  } else {
    usageStore.set(model, {
      requests: 1,
      inputTokens: input,
      outputTokens: output,
      cachedTokens: cached,
      lastUsed: new Date().toISOString(),
    });
  }
  saveUsage();
  notifyUsageSubscribers();
}

/**
 * Aggregates token usage across all models and computes summary statistics.
 */
export function getTokenUsageStats(): TokenUsageSummary {
  let totalRequests = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCachedTokens = 0;
  let grandTotalTokens = 0;

  const models: ModelUsage[] = [];

  for (const [model, stats] of usageStore.entries()) {
    const totalTokens = stats.inputTokens + stats.outputTokens + stats.cachedTokens;
    totalRequests += stats.requests;
    totalInputTokens += stats.inputTokens;
    totalOutputTokens += stats.outputTokens;
    totalCachedTokens += stats.cachedTokens;
    grandTotalTokens += totalTokens;

    models.push({
      model,
      requests: stats.requests,
      inputTokens: stats.inputTokens,
      outputTokens: stats.outputTokens,
      cachedTokens: stats.cachedTokens,
      totalTokens,
      lastUsed: stats.lastUsed,
    });
  }

  models.sort((a, b) => b.totalTokens - a.totalTokens || a.model.localeCompare(b.model));

  return {
    totalRequests,
    totalInputTokens,
    totalOutputTokens,
    totalCachedTokens,
    grandTotalTokens,
    models,
  };
}

/**
 * Resets all recorded token counters to zero.
 */
export function resetTokenUsage(): void {
  usageStore.clear();
  saveUsage();
  notifyUsageSubscribers();
}
