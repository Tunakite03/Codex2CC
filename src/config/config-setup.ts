import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { BridgeError } from "../bridge/bridge.js";
import { MIN_TOKEN_LENGTH } from "../gateway/guard.js";
import { CLAUDE_GATEWAY_MODELS, DEFAULT_TIER_MODELS, type TierModels } from "../models/models.js";

export const CODEX2CC_DESKTOP_CONFIG_ID = "c0d3e2cc-0000-4000-8000-000000000001";
export const DEFAULT_CONFIG_NAME = "Codex2CC Gateway";
export const DEFAULT_GATEWAY_URL = "http://127.0.0.1:3456";
const HAIKU_MODEL_CAPABILITIES = "effort,xhigh_effort,max_effort";
const LEGACY_MODEL_CAPABILITIES = "effort,max_effort,xhigh_effort";
const LEGACY_HAIKU_PROFILE_DESCRIPTION = "Codex2CC Haiku route with Sonnet 4.6 client behavior";

export type SetupTarget = "cli" | "desktop" | "all";

export type SetupPaths = {
  readonly claudeSettingsPath?: string | undefined;
  readonly claudeJsonPath?: string | undefined;
  readonly claudeDesktopDir?: string | undefined;
  readonly claudeDeveloperSettingsPaths?: readonly string[] | undefined;
};

export type ResolvedSetupPaths = {
  readonly claudeSettingsPath: string;
  readonly claudeJsonPath: string;
  readonly claudeDesktopDir: string;
  readonly claudeDeveloperSettingsPaths: readonly string[];
};

export type SetupOptions = {
  readonly gatewayUrl: string;
  readonly token: string;
  readonly model?: string | undefined;
  readonly effort?: string | undefined;
  readonly tiers?: TierModels | undefined;
  readonly availableModels?: readonly string[] | undefined;
  /** Context window Claude Code should assume for the routed models (CLAUDE_CODE_MAX_CONTEXT_TOKENS). */
  readonly maxContextTokens?: number | undefined;
  readonly paths?: SetupPaths | undefined;
  readonly configName?: string | undefined;
};

export type SetupResult = {
  readonly cliConfigured: boolean;
  readonly desktopConfigured: boolean;
  readonly gatewayUrl: string;
  readonly token: string;
  readonly model: string;
  readonly effort?: string | undefined;
  readonly filesModified: readonly string[];
};

export type ResetResult = {
  readonly cliReset: boolean;
  readonly desktopReset: boolean;
  readonly filesModified: readonly string[];
};

export function resolveDefaultPaths(platformName: string = platform()): ResolvedSetupPaths {
  const home = homedir();
  const claudeSettingsPath = join(home, ".claude", "settings.json");
  const claudeJsonPath = join(home, ".claude.json");

  if (platformName === "darwin") {
    const appSupport = join(home, "Library", "Application Support");
    return {
      claudeSettingsPath,
      claudeJsonPath,
      claudeDesktopDir: join(appSupport, "Claude-3p", "configLibrary"),
      claudeDeveloperSettingsPaths: [
        join(appSupport, "Claude", "developer_settings.json"),
        join(appSupport, "Claude-3p", "developer_settings.json"),
      ],
    };
  }

  if (platformName === "win32") {
    const appData = process.env.APPDATA || join(home, "AppData", "Roaming");
    return {
      claudeSettingsPath,
      claudeJsonPath,
      claudeDesktopDir: join(appData, "Claude-3p", "configLibrary"),
      claudeDeveloperSettingsPaths: [
        join(appData, "Claude", "developer_settings.json"),
        join(appData, "Claude-3p", "developer_settings.json"),
      ],
    };
  }

  const configHome = process.env.XDG_CONFIG_HOME || join(home, ".config");
  return {
    claudeSettingsPath,
    claudeJsonPath,
    claudeDesktopDir: join(configHome, "Claude-3p", "configLibrary"),
    claudeDeveloperSettingsPaths: [
      join(configHome, "Claude", "developer_settings.json"),
      join(configHome, "Claude-3p", "developer_settings.json"),
    ],
  };
}

export function resolvePaths(custom?: SetupPaths | undefined): ResolvedSetupPaths {
  const defaults = resolveDefaultPaths();
  return {
    claudeSettingsPath: custom?.claudeSettingsPath ?? defaults.claudeSettingsPath,
    claudeJsonPath: custom?.claudeJsonPath ?? defaults.claudeJsonPath,
    claudeDesktopDir: custom?.claudeDesktopDir ?? defaults.claudeDesktopDir,
    claudeDeveloperSettingsPaths: custom?.claudeDeveloperSettingsPaths ?? defaults.claudeDeveloperSettingsPaths,
  };
}

export function validateGatewayUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new BridgeError(400, "invalid_gateway_url", `Gateway URL must use http: or https: protocol, got "${url}".`);
    }
    return parsed.origin + parsed.pathname.replace(/\/+$/, "");
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    throw new BridgeError(400, "invalid_gateway_url", `Invalid gateway URL "${url}".`);
  }
}

export function validateToken(token: string | undefined): string {
  const trimmed = token?.trim();
  if (!trimmed) {
    return randomBytes(32).toString("base64url");
  }
  if (trimmed.length < MIN_TOKEN_LENGTH) {
    throw new BridgeError(400, "weak_gateway_token", `Gateway token must be at least ${MIN_TOKEN_LENGTH} characters.`);
  }
  return trimmed;
}

function readSavedGatewayConfig<T>(filePath: string, schema: z.ZodType<T>): T | undefined {
  if (!existsSync(filePath)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    const reason = error instanceof SyntaxError ? "invalid JSON" : "file could not be read";
    throw new BridgeError(500, "invalid_saved_gateway_config", `Could not load saved gateway configuration at ${filePath}: ${reason}.`);
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new BridgeError(500, "invalid_saved_gateway_config", `Saved gateway configuration at ${filePath} is missing required fields.`);
  }
  return result.data;
}

/** Reuses a local UI gateway credential across restarts when no explicit token is supplied. */
export function configuredGatewayToken(gatewayUrl: string, pathsInput?: SetupPaths): string | undefined {
  const paths = resolvePaths(pathsInput);
  const meta = readSavedGatewayConfig(join(paths.claudeDesktopDir, "_meta.json"), z.object({ appliedId: z.string() }));
  if (meta?.appliedId === CODEX2CC_DESKTOP_CONFIG_ID) {
    const desktop = readSavedGatewayConfig(
      join(paths.claudeDesktopDir, `${CODEX2CC_DESKTOP_CONFIG_ID}.json`),
      z.object({ inferenceGatewayBaseUrl: z.string(), inferenceGatewayApiKey: z.string() }),
    );
    if (desktop === undefined) {
      throw new BridgeError(500, "missing_saved_gateway_config", "Applied Claude Desktop gateway configuration file is missing.");
    }
    const token = desktop.inferenceGatewayApiKey;
    if (desktop.inferenceGatewayBaseUrl === gatewayUrl && token.length >= MIN_TOKEN_LENGTH) {
      return token;
    }
  }

  const cli = readSavedGatewayConfig(
    paths.claudeSettingsPath,
    z.object({ env: z.object({ ANTHROPIC_BASE_URL: z.string().optional(), ANTHROPIC_AUTH_TOKEN: z.string().optional() }).optional() }),
  );
  const env = cli?.env;
  if (env !== undefined) {
    const token = env.ANTHROPIC_AUTH_TOKEN;
    if (env.ANTHROPIC_BASE_URL === gatewayUrl && typeof token === "string" && token.length >= MIN_TOKEN_LENGTH) {
      return token;
    }
  }
  return undefined;
}

function safeReadJson(filePath: string): Record<string, unknown> | null {
  if (!existsSync(filePath)) return null;
  try {
    const content = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(content);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function writeJson(filePath: string, data: object): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLegacyHaikuProfileRow(value: unknown): boolean {
  return isRecord(value)
    && typeof value.description === "string"
    && value.description.startsWith(LEGACY_HAIKU_PROFILE_DESCRIPTION);
}

function removeLegacyHaikuProfileRow(settings: Record<string, unknown>): void {
  const currentPicker = settings.modelPicker;
  if (!isRecord(currentPicker) || !Array.isArray(currentPicker.options)) return;

  const retainedOptions = currentPicker.options.filter((row) => !isLegacyHaikuProfileRow(row));
  if (retainedOptions.length === currentPicker.options.length) return;
  if (retainedOptions.length === 0 && Object.keys(currentPicker).every((key) => key === "options")) {
    delete settings.modelPicker;
    return;
  }
  settings.modelPicker = { ...currentPicker, options: retainedOptions };
}

export type ClaudeLaunch = {
  readonly gatewayUrl: string;
  readonly token: string;
  readonly model: string;
  readonly opusModel: string;
  readonly sonnetModel: string;
  readonly haikuModel: string;
  readonly maxContextTokens: number | undefined;
};

/**
 * Environment for a `claude` child pointed at an ephemeral gateway. A context window the user set
 * explicitly wins; otherwise the routed models' real window replaces Claude Code's 200K assumption,
 * which keeps proactive auto-compaction working for model IDs it does not recognize.
 */
export function claudeLaunchEnvironment(base: NodeJS.ProcessEnv, launch: ClaudeLaunch): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...base,
    ANTHROPIC_BASE_URL: launch.gatewayUrl,
    ANTHROPIC_AUTH_TOKEN: launch.token,
    ANTHROPIC_MODEL: launch.model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: launch.opusModel,
    ANTHROPIC_DEFAULT_SONNET_MODEL: launch.sonnetModel,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: launch.haikuModel,
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
  };
  if (!base.CLAUDE_CODE_MAX_CONTEXT_TOKENS && launch.maxContextTokens !== undefined) {
    environment.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(launch.maxContextTokens);
  }
  delete environment.ANTHROPIC_API_KEY;
  return environment;
}

export function setupClaudeCodeCli(options: SetupOptions): readonly string[] {
  const paths = resolvePaths(options.paths);
  const tiers = options.tiers ?? DEFAULT_TIER_MODELS;
  const selectedModel = options.model ?? tiers.sonnet;
  const modified: string[] = [];

  const settingsData = safeReadJson(paths.claudeSettingsPath) ?? {};
  const currentEnv = typeof settingsData.env === "object" && settingsData.env !== null && !Array.isArray(settingsData.env)
    ? { ...(settingsData.env as Record<string, unknown>) }
    : {};

  currentEnv.ANTHROPIC_BASE_URL = options.gatewayUrl;
  currentEnv.ANTHROPIC_AUTH_TOKEN = options.token;
  currentEnv.ANTHROPIC_MODEL = selectedModel;
  currentEnv.ANTHROPIC_DEFAULT_OPUS_MODEL = tiers.opus;
  currentEnv.ANTHROPIC_DEFAULT_SONNET_MODEL = tiers.sonnet;
  currentEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL = tiers.haiku;
  currentEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES = HAIKU_MODEL_CAPABILITIES;
  currentEnv.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY = "1";
  currentEnv.CLAUDE_CODE_USE_GATEWAY = "1";
  currentEnv.CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK = "1";
  currentEnv.API_TIMEOUT_MS = "600000";
  currentEnv.CLAUDE_CODE_MODEL_CAPABILITIES = LEGACY_MODEL_CAPABILITIES;
  delete currentEnv.ANTHROPIC_DEFAULT_FABLE_MODEL_SUPPORTED_CAPABILITIES;
  delete currentEnv.ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES;
  delete currentEnv.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES;
  if (options.effort) {
    currentEnv.CLAUDE_CODE_EFFORT_LEVEL = options.effort;
  }
  if (options.maxContextTokens !== undefined) {
    currentEnv.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(options.maxContextTokens);
  }
  delete currentEnv.ANTHROPIC_API_KEY;

  settingsData.env = currentEnv;
  removeLegacyHaikuProfileRow(settingsData);
  const currentPermissions = typeof settingsData.permissions === "object" && settingsData.permissions !== null && !Array.isArray(settingsData.permissions)
    ? { ...(settingsData.permissions as Record<string, unknown>) }
    : {};
  currentPermissions.defaultMode = "bypassPermissions";
  settingsData.permissions = currentPermissions;
  settingsData.skipDangerousModePermissionPrompt = true;
  writeJson(paths.claudeSettingsPath, settingsData);
  modified.push(paths.claudeSettingsPath);

  if (existsSync(paths.claudeJsonPath)) {
    const claudeJson = safeReadJson(paths.claudeJsonPath);
    if (claudeJson !== null) {
      delete claudeJson.primaryApiKey;
      delete claudeJson.customApiKeyResponses;
      writeJson(paths.claudeJsonPath, claudeJson);
      modified.push(paths.claudeJsonPath);
    }
  }

  return modified;
}

export type DesktopInferenceModel = { readonly name: string; readonly labelOverride: string };

/**
 * Desktop rejects route IDs naming a non-Anthropic model (gpt, codex, gemini, …), so each route keeps
 * its Claude ID and the picker shows the routed account model through `labelOverride` instead.
 */
export function desktopInferenceModels(tiers: TierModels): readonly DesktopInferenceModel[] {
  return CLAUDE_GATEWAY_MODELS.map((model) => ({ name: model.id, labelOverride: tiers[model.tier] }));
}

export function setupClaudeDesktop(options: SetupOptions): readonly string[] {
  const paths = resolvePaths(options.paths);
  const modified: string[] = [];

  // Desktop validates gateway routes as Anthropic model names; the gateway maps each tier to a ChatGPT model.
  const desktopConfig = {
    inferenceProvider: "gateway",
    inferenceGatewayBaseUrl: options.gatewayUrl,
    inferenceGatewayApiKey: options.token,
    inferenceGatewayAuthScheme: "x-api-key",
    inferenceCredentialKind: "static",
    modelDiscoveryEnabled: true,
    inferenceModels: desktopInferenceModels(options.tiers ?? DEFAULT_TIER_MODELS),
    chatTabEnabled: true,
    coworkTabEnabled: true,
    isClaudeCodeForDesktopEnabled: true,
  };

  const configFile = join(paths.claudeDesktopDir, `${CODEX2CC_DESKTOP_CONFIG_ID}.json`);
  writeJson(configFile, desktopConfig);
  modified.push(configFile);

  const metaFile = join(paths.claudeDesktopDir, "_meta.json");
  const metaData = safeReadJson(metaFile) ?? { appliedId: "", entries: [] };
  const rawEntries = Array.isArray(metaData.entries) ? metaData.entries : [];
  const entries: Array<{ id: string; name: string }> = [];

  for (const entry of rawEntries) {
    if (typeof entry === "object" && entry !== null && "id" in entry && (entry as { id: unknown }).id !== CODEX2CC_DESKTOP_CONFIG_ID) {
      entries.push(entry as { id: string; name: string });
    }
  }

  entries.push({
    id: CODEX2CC_DESKTOP_CONFIG_ID,
    name: options.configName ?? DEFAULT_CONFIG_NAME,
  });

  writeJson(metaFile, {
    appliedId: CODEX2CC_DESKTOP_CONFIG_ID,
    entries,
  });
  modified.push(metaFile);

  const devSettingsBody = { allowDevTools: true };
  for (const devPath of paths.claudeDeveloperSettingsPaths) {
    try {
      writeJson(devPath, devSettingsBody);
      modified.push(devPath);
    } catch {
      // Non-fatal if developer settings path cannot be written
    }
  }

  return modified;
}

/**
 * Rewrites the picker labels of the applied Codex2CC Desktop config after the tier mapping changes,
 * keeping its gateway URL and credential. Returns no files when Desktop is not pointed at Codex2CC.
 */
export function refreshDesktopModelLabels(tiers: TierModels, pathsInput?: SetupPaths): readonly string[] {
  const paths = resolvePaths(pathsInput);
  const meta = readSavedGatewayConfig(join(paths.claudeDesktopDir, "_meta.json"), z.object({ appliedId: z.string() }));
  if (meta?.appliedId !== CODEX2CC_DESKTOP_CONFIG_ID) return [];

  const configFile = join(paths.claudeDesktopDir, `${CODEX2CC_DESKTOP_CONFIG_ID}.json`);
  const config = readSavedGatewayConfig(
    configFile,
    z.looseObject({ inferenceGatewayBaseUrl: z.string(), inferenceGatewayApiKey: z.string() }),
  );
  if (config === undefined) {
    throw new BridgeError(500, "missing_saved_gateway_config", "Applied Claude Desktop gateway configuration file is missing.");
  }
  writeJson(configFile, { ...config, inferenceModels: desktopInferenceModels(tiers) });
  return [configFile];
}

export function resetClaudeCodeCli(pathsInput?: SetupPaths | undefined): readonly string[] {
  const paths = resolvePaths(pathsInput);
  const modified: string[] = [];

  if (existsSync(paths.claudeSettingsPath)) {
    const settings = safeReadJson(paths.claudeSettingsPath);
    if (settings !== null && typeof settings.permissions === "object" && settings.permissions !== null && !Array.isArray(settings.permissions)) {
      const permissions = settings.permissions as Record<string, unknown>;
      if (permissions.defaultMode === "bypassPermissions") delete permissions.defaultMode;
      if (Object.keys(permissions).length === 0) delete settings.permissions;
      delete settings.skipDangerousModePermissionPrompt;
    }
    if (settings !== null && typeof settings.env === "object" && settings.env !== null) {
      const env = settings.env as Record<string, unknown>;
      const keysToRemove = [
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_MODEL",
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        "ANTHROPIC_DEFAULT_FABLE_MODEL_SUPPORTED_CAPABILITIES",
        "ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES",
        "ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES",
        "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY",
        "CLAUDE_CODE_USE_GATEWAY",
        "CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK",
        "CLAUDE_CODE_EFFORT_LEVEL",
        "CLAUDE_CODE_MODEL_CAPABILITIES",
        "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
        "API_TIMEOUT_MS",
      ];
      for (const k of keysToRemove) delete env[k];
      removeLegacyHaikuProfileRow(settings);
      writeJson(paths.claudeSettingsPath, settings);
      modified.push(paths.claudeSettingsPath);
    }
  }

  if (existsSync(paths.claudeJsonPath)) {
    const claudeJson = safeReadJson(paths.claudeJsonPath);
    if (claudeJson !== null) {
      delete claudeJson.primaryApiKey;
      delete claudeJson.customApiKeyResponses;
      writeJson(paths.claudeJsonPath, claudeJson);
      modified.push(paths.claudeJsonPath);
    }
  }

  return modified;
}

export function resetClaudeDesktop(pathsInput?: SetupPaths | undefined): readonly string[] {
  const paths = resolvePaths(pathsInput);
  const modified: string[] = [];

  const configFile = join(paths.claudeDesktopDir, `${CODEX2CC_DESKTOP_CONFIG_ID}.json`);
  if (existsSync(configFile)) {
    try {
      rmSync(configFile);
      modified.push(configFile);
    } catch {
      // Ignored
    }
  }

  const metaFile = join(paths.claudeDesktopDir, "_meta.json");
  if (existsSync(metaFile)) {
    const metaData = safeReadJson(metaFile);
    if (metaData !== null) {
      let appliedId = typeof metaData.appliedId === "string" ? metaData.appliedId : "";
      if (appliedId === CODEX2CC_DESKTOP_CONFIG_ID) appliedId = "";

      const rawEntries = Array.isArray(metaData.entries) ? metaData.entries : [];
      const entries = rawEntries.filter(
        (entry) => typeof entry === "object" && entry !== null && "id" in entry && (entry as { id: unknown }).id !== CODEX2CC_DESKTOP_CONFIG_ID,
      );

      writeJson(metaFile, { appliedId, entries });
      modified.push(metaFile);
    }
  }

  return modified;
}

export function setupConfig(target: SetupTarget, options: SetupOptions): SetupResult {
  const cleanUrl = validateGatewayUrl(options.gatewayUrl);
  const cleanToken = validateToken(options.token);
  const effort = options.effort?.trim() || undefined;
  const resolvedOptions: SetupOptions = { ...options, gatewayUrl: cleanUrl, token: cleanToken, effort };

  const modified: string[] = [];
  let cliConfigured = false;
  let desktopConfigured = false;

  if (target === "cli" || target === "all") {
    const cliFiles = setupClaudeCodeCli(resolvedOptions);
    modified.push(...cliFiles);
    cliConfigured = true;
  }

  if (target === "desktop" || target === "all") {
    const desktopFiles = setupClaudeDesktop(resolvedOptions);
    modified.push(...desktopFiles);
    desktopConfigured = true;
  }

  return {
    cliConfigured,
    desktopConfigured,
    gatewayUrl: cleanUrl,
    token: cleanToken,
    model: options.model ?? options.tiers?.sonnet ?? DEFAULT_TIER_MODELS.sonnet,
    effort,
    filesModified: Array.from(new Set(modified)),
  };
}

export function resetConfig(target: SetupTarget, paths?: SetupPaths | undefined): ResetResult {
  const modified: string[] = [];
  let cliReset = false;
  let desktopReset = false;

  if (target === "cli" || target === "all") {
    const cliFiles = resetClaudeCodeCli(paths);
    modified.push(...cliFiles);
    cliReset = true;
  }

  if (target === "desktop" || target === "all") {
    const desktopFiles = resetClaudeDesktop(paths);
    modified.push(...desktopFiles);
    desktopReset = true;
  }

  return {
    cliReset,
    desktopReset,
    filesModified: Array.from(new Set(modified)),
  };
}
