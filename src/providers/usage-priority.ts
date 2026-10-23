import type { ApiProvider } from "./config.js";

/**
 * Model ids ranked by token usage, most used first. Snapshot of the public OpenRouter rankings for 2026-10-22.
 * Ids are the `id` values from /api/v1/models, so `:free` and `:batch` variants are listed explicitly.
 * Ids the provider no longer lists are ignored. Refresh this list by hand when the rankings change.
 */
export const USAGE_PRIORITY: Readonly<Partial<Record<ApiProvider, readonly string[]>>> = {
  openrouter: [
    "deepseek/deepseek-v4.1-flash",
    "minimax/minimax-m3.1-flash",
    "z-ai/glm-5.3-flash",
    "tencent/hy4-preview",
    "xiaomi/mimo-v2.6-flash",
    "anthropic/claude-opus-5.5",
    "openai/gpt-6-luna",
    "z-ai/glm-5.3",
    "nvidia/nemotron-3-ultra-550b-a55b:free",
    "deepseek/deepseek-v4-flash",
    "meta/muse-spark-1.3-contributor",
    "tencent/hy3",
    "anthropic/claude-sonnet-5.5",
    "anthropic/claude-haiku-5.5",
    "openai/gpt-6.1-sol",
    "moonshotai/kimi-k3",
    "openai/gpt-5.6-luna",
  ],
};
