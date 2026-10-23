import type { GatewayOptions } from "../gateway/gateway.js";
import { ANTIGRAVITY_DEFAULT_MODEL, ANTIGRAVITY_MODELS, type ModelCatalogItem, type ProviderType } from "../models/models.js";
import { defaultApiProviderConfig, isApiProvider, type ApiProvider, type ApiProviderConfig } from "./config.js";

export function currentProvider(options: GatewayOptions): ProviderType {
  return options.provider ?? options.tierStore?.getProvider() ?? "codex";
}

export function getProviderConfig(options: GatewayOptions, provider: ApiProvider): ApiProviderConfig {
  return options.tierStore?.getApiProviderConfig(provider) ?? defaultApiProviderConfig(provider);
}

export function providerModels(options: GatewayOptions, provider: ProviderType): readonly ModelCatalogItem[] {
  if (isApiProvider(provider)) return getProviderConfig(options, provider).models.map(({ slug, displayName, contextWindow }) => ({ slug, displayName, ...(contextWindow === undefined ? {} : { contextWindow }) }));
  return provider === "antigravity" ? options.antigravityModels ?? ANTIGRAVITY_MODELS : options.availableModels;
}

export function providerDefaultModel(options: GatewayOptions, provider: ProviderType): string {
  const models = providerModels(options, provider);
  const override = options.defaultModels?.[provider];
  if (override !== undefined && models.some((model) => model.slug === override)) return override;
  if (isApiProvider(provider)) return getProviderConfig(options, provider).defaultModel;
  if (models.some((model) => model.slug === options.defaultModel)) return options.defaultModel;
  return provider === "antigravity" ? ANTIGRAVITY_DEFAULT_MODEL : models[0]?.slug ?? options.defaultModel;
}
