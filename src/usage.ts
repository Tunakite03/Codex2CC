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
}
