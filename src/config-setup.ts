import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { BridgeError } from "./bridge.js";
import { MIN_TOKEN_LENGTH } from "./guard.js";
import { CLAUDE_GATEWAY_MODELS, DEFAULT_TIER_MODELS, type TierModels } from "./models.js";

export const CODEX2CC_DESKTOP_CONFIG_ID = "c0d3e2cc-0000-4000-8000-000000000001";
export const DEFAULT_CONFIG_NAME = "Codex2CC Gateway";
export const DEFAULT_GATEWAY_URL = "http://127.0.0.1:3456";

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
  currentEnv.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY = "1";
  currentEnv.CLAUDE_CODE_USE_GATEWAY = "1";
  currentEnv.CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK = "1";
  currentEnv.API_TIMEOUT_MS = "600000";
  if (options.effort) {
    currentEnv.CLAUDE_CODE_EFFORT_LEVEL = options.effort;
  }
  delete currentEnv.ANTHROPIC_API_KEY;

  settingsData.env = currentEnv;
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
    inferenceModels: CLAUDE_GATEWAY_MODELS.map((model) => ({ name: model.id })),
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
        "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY",
        "CLAUDE_CODE_USE_GATEWAY",
        "CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK",
        "CLAUDE_CODE_EFFORT_LEVEL",
        "API_TIMEOUT_MS",
      ];
      for (const k of keysToRemove) delete env[k];
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
