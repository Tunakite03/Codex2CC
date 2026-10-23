import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BridgeError } from "../bridge/bridge.js";
import {
  claudeLaunchEnvironment,
  CODEX2CC_DESKTOP_CONFIG_ID,
  configuredGatewayToken,
  refreshDesktopModelLabels,
  resolveDefaultPaths,
  resetConfig,
  setupConfig,
  validateGatewayUrl,
  validateToken,
  type ResolvedSetupPaths,
} from "./config-setup.js";

function createSandbox(): { sandboxDir: string; paths: ResolvedSetupPaths; cleanup: () => void } {
  const sandboxDir = mkdtempSync(join(tmpdir(), "codex2cc-setup-test-"));
  const paths: ResolvedSetupPaths = {
    claudeSettingsPath: join(sandboxDir, ".claude", "settings.json"),
    claudeJsonPath: join(sandboxDir, ".claude.json"),
    claudeDesktopDir: join(sandboxDir, "Claude-3p", "configLibrary"),
    claudeDeveloperSettingsPaths: [
      join(sandboxDir, "Claude", "developer_settings.json"),
      join(sandboxDir, "Claude-3p", "developer_settings.json"),
    ],
  };
  return {
    sandboxDir,
    paths,
    cleanup: () => rmSync(sandboxDir, { recursive: true, force: true }),
  };
}

test("Windows Desktop setup writes the gateway library to LocalAppData instead of Roaming", () => {
  const { sandboxDir, cleanup } = createSandbox();
  const previousAppData = process.env.APPDATA;
  const previousLocalAppData = process.env.LOCALAPPDATA;
  const roaming = join(sandboxDir, "Roaming");
  const local = join(sandboxDir, "Local");
  process.env.APPDATA = roaming;
  process.env.LOCALAPPDATA = local;
  try {
    const paths = resolveDefaultPaths("win32");
    const result = setupConfig("desktop", {
      gatewayUrl: "http://127.0.0.1:3456",
      token: "secure-token-1234567890123456",
      paths,
    });
    const library = join(local, "Claude-3p", "configLibrary");
    assert.equal(paths.claudeDesktopDir, library);
    assert.ok(result.filesModified.includes(join(library, `${CODEX2CC_DESKTOP_CONFIG_ID}.json`)));
    const meta = JSON.parse(readFileSync(join(library, "_meta.json"), "utf8")) as { appliedId: string };
    assert.equal(meta.appliedId, CODEX2CC_DESKTOP_CONFIG_ID);
    assert.ok(paths.claudeDeveloperSettingsPaths.includes(join(roaming, "Claude", "developer_settings.json")));
    assert.ok(paths.claudeDeveloperSettingsPaths.includes(join(local, "Claude-3p", "developer_settings.json")));
  } finally {
    if (previousAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = previousAppData;
    if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previousLocalAppData;
    cleanup();
  }
});

test("validateGatewayUrl accepts http and https and strips trailing slashes", () => {
  assert.equal(validateGatewayUrl("http://127.0.0.1:3456/"), "http://127.0.0.1:3456");
  assert.equal(validateGatewayUrl("https://my-gateway.internal/api/"), "https://my-gateway.internal/api");
  assert.throws(
    () => validateGatewayUrl("ftp://gateway.local"),
    (err: unknown) => err instanceof BridgeError && err.code === "invalid_gateway_url",
  );
  assert.throws(
    () => validateGatewayUrl("not-a-valid-url"),
    (err: unknown) => err instanceof BridgeError && err.code === "invalid_gateway_url",
  );
});

test("macOS Desktop setup paths stay under Application Support", () => {
  const paths = resolveDefaultPaths("darwin");
  const appSupport = join(homedir(), "Library", "Application Support");
  assert.equal(paths.claudeDesktopDir, join(appSupport, "Claude-3p", "configLibrary"));
  assert.deepEqual(paths.claudeDeveloperSettingsPaths, [
    join(appSupport, "Claude", "developer_settings.json"),
    join(appSupport, "Claude-3p", "developer_settings.json"),
  ]);
});

test("Desktop setup reactivates gateway mode after reset and preserves profile preferences", () => {
  const { sandboxDir, paths, cleanup } = createSandbox();
  try {
    const profileDir = join(sandboxDir, "Claude-3p");
    const profileConfig = join(profileDir, "claude_desktop_config.json");
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(profileConfig, JSON.stringify({ deploymentMode: "1p", preferences: { locale: "vi" } }));
    const options = { gatewayUrl: "http://127.0.0.1:3456", token: "secure-token-1234567890123456", paths };
    for (let cycle = 0; cycle < 2; cycle += 1) {
      const setup = setupConfig("desktop", options);
      assert.deepEqual(JSON.parse(readFileSync(profileConfig, "utf8")), {
        deploymentMode: "3p", preferences: { locale: "vi" },
      });
      assert.ok(setup.filesModified.includes(profileConfig));
      resetConfig("desktop", paths);
      assert.deepEqual(JSON.parse(readFileSync(profileConfig, "utf8")), {
        deploymentMode: "1p", preferences: { locale: "vi" },
      });
    }
  } finally {
    cleanup();
  }
});

test("validateToken generates fresh tokens when empty and enforces length", () => {
  const generated = validateToken(undefined);
  assert.ok(generated.length >= 32);
  const fromEnv = validateToken("  super-secure-token-1234567890  ");
  assert.equal(fromEnv, "super-secure-token-1234567890");
  assert.throws(
    () => validateToken("short"),
    (err: unknown) => err instanceof BridgeError && err.code === "weak_gateway_token",
  );
});

test("setupConfig configures Claude Code CLI atomically and cleans old credentials", () => {
  const { sandboxDir, paths, cleanup } = createSandbox();
  try {
    writeFileSync(
      paths.claudeJsonPath,
      JSON.stringify({ primaryApiKey: "old-secret", customApiKeyResponses: { test: true }, otherSetting: 123 }),
      "utf8",
    );
    mkdirSync(join(sandboxDir, ".claude"), { recursive: true });
    writeFileSync(paths.claudeSettingsPath, JSON.stringify({
      modelPicker: {
        options: [
          {
            model: "gpt-6-luna",
            label: "Sonnet 4.6 via gpt-6-luna",
            description: "Codex2CC Haiku route with Sonnet 4.6 client behavior; GPT backend model: gpt-6-luna",
            behavesAs: "claude-sonnet-4-6",
          },
          { model: "custom-model", label: "My model", description: "Keep this user option" },
        ],
      },
    }), "utf8");

    const result = setupConfig("cli", {
      gatewayUrl: "http://127.0.0.1:3456",
      token: "secure-token-1234567890123456",
      effort: "high",
      paths,
    });

    assert.equal(result.cliConfigured, true);
    assert.equal(result.desktopConfigured, false);
    assert.equal(result.effort, "high");

    const settings = JSON.parse(readFileSync(paths.claudeSettingsPath, "utf8"));
    assert.equal(settings.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:3456");
    assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, "secure-token-1234567890123456");
    assert.equal(settings.env.ANTHROPIC_MODEL, "gpt-6-sol");
    assert.equal(settings.env.CLAUDE_CODE_EFFORT_LEVEL, "high");
    assert.equal(settings.env.CLAUDE_CODE_USE_GATEWAY, "1");
    assert.equal(settings.env.ANTHROPIC_DEFAULT_FABLE_MODEL_SUPPORTED_CAPABILITIES, undefined);
    assert.equal(settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES, undefined);
    assert.equal(settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES, undefined);
    assert.equal(settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES, "effort,xhigh_effort,max_effort");
    assert.equal(settings.env.CLAUDE_CODE_MODEL_CAPABILITIES, "effort,max_effort,xhigh_effort");
    assert.equal(settings.env.API_TIMEOUT_MS, "600000");
    assert.deepEqual(settings.modelPicker.options, [
      { model: "custom-model", label: "My model", description: "Keep this user option" },
    ]);
    assert.equal(settings.permissions.defaultMode, "bypassPermissions");
    assert.equal(settings.skipDangerousModePermissionPrompt, true);

    const claudeJson = JSON.parse(readFileSync(paths.claudeJsonPath, "utf8"));
    assert.equal(claudeJson.primaryApiKey, undefined);
    assert.equal(claudeJson.customApiKeyResponses, undefined);
    assert.equal(claudeJson.otherSetting, 123);
  } finally {
    cleanup();
  }
});

test("setupConfig configures Claude Desktop library, models and _meta.json", () => {
  const { paths, cleanup } = createSandbox();
  try {
    const result = setupConfig("desktop", {
      gatewayUrl: "http://127.0.0.1:3456",
      token: "secure-token-1234567890123456",
      availableModels: ["gpt-6-sol", "gpt-6.1-sol"],
      paths,
    });

    assert.equal(result.cliConfigured, false);
    assert.equal(result.desktopConfigured, true);

    const configFile = join(paths.claudeDesktopDir, `${CODEX2CC_DESKTOP_CONFIG_ID}.json`);
    const config = JSON.parse(readFileSync(configFile, "utf8"));
    assert.equal(config.inferenceProvider, "gateway");
    assert.equal(config.inferenceGatewayBaseUrl, "http://127.0.0.1:3456");
    assert.equal(config.inferenceGatewayApiKey, "secure-token-1234567890123456");
    assert.equal(config.inferenceGatewayAuthScheme, "x-api-key");
    assert.equal(config.modelDiscoveryEnabled, true);
    assert.deepEqual(config.inferenceModels, [
      { name: "claude-sonnet-5-5", labelOverride: "gpt-6-sol" },
      { name: "claude-opus-5-5", labelOverride: "gpt-6.1-sol" },
      { name: "claude-haiku-5", labelOverride: "gpt-6-luna" },
      { name: "claude-fable-5-1", labelOverride: "gpt-6-astra" },
    ]);

    const metaFile = join(paths.claudeDesktopDir, "_meta.json");
    const meta = JSON.parse(readFileSync(metaFile, "utf8"));
    assert.equal(meta.appliedId, CODEX2CC_DESKTOP_CONFIG_ID);
    assert.ok(meta.entries.some((e: { id: string }) => e.id === CODEX2CC_DESKTOP_CONFIG_ID));

    for (const devPath of paths.claudeDeveloperSettingsPaths) {
      const devSettings = JSON.parse(readFileSync(devPath, "utf8"));
      assert.equal(devSettings.allowDevTools, true);
    }
  } finally {
    cleanup();
  }
});

test("refreshDesktopModelLabels relabels only an applied Codex2CC Desktop config and keeps its credential", () => {
  const { paths, cleanup } = createSandbox();
  const tiers = { fable: "gpt-6-sol", opus: "gpt-6-sol", sonnet: "gpt-6.1-sol", haiku: "gpt-6-luna" };
  try {
    assert.deepEqual(refreshDesktopModelLabels(tiers, paths), [], "nothing to relabel before setup");

    setupConfig("desktop", { gatewayUrl: "http://127.0.0.1:3456", token: "secure-token-1234567890123456", paths });
    const configFile = join(paths.claudeDesktopDir, `${CODEX2CC_DESKTOP_CONFIG_ID}.json`);
    assert.deepEqual(refreshDesktopModelLabels(tiers, paths), [configFile]);

    const config = JSON.parse(readFileSync(configFile, "utf8"));
    assert.deepEqual(config.inferenceModels, [
      { name: "claude-sonnet-5-5", labelOverride: "gpt-6.1-sol" },
      { name: "claude-opus-5-5", labelOverride: "gpt-6-sol" },
      { name: "claude-haiku-5", labelOverride: "gpt-6-luna" },
      { name: "claude-fable-5-1", labelOverride: "gpt-6-sol" },
    ]);
    assert.equal(config.inferenceGatewayBaseUrl, "http://127.0.0.1:3456");
    assert.equal(config.inferenceGatewayApiKey, "secure-token-1234567890123456");
    assert.equal(config.modelDiscoveryEnabled, true);

    resetConfig("desktop", paths);
    assert.deepEqual(refreshDesktopModelLabels(tiers, paths), [], "a reset Desktop is left alone");

    setupConfig("desktop", { gatewayUrl: "http://127.0.0.1:3456", token: "secure-token-1234567890123456", paths });
    writeFileSync(configFile, "{ broken", "utf8");
    assert.throws(
      () => refreshDesktopModelLabels(tiers, paths),
      (error: unknown) => error instanceof BridgeError && error.code === "invalid_saved_gateway_config",
    );
    assert.equal(readFileSync(configFile, "utf8"), "{ broken", "a corrupt config is reported, not overwritten");
  } finally {
    cleanup();
  }
});

test("configuredGatewayToken reuses only a credential for the requested local gateway", () => {
  const { paths, cleanup } = createSandbox();
  try {
    setupConfig("all", {
      gatewayUrl: "http://127.0.0.1:3456",
      token: "persistent-token-1234567890",
      paths,
    });
    assert.equal(configuredGatewayToken("http://127.0.0.1:3456", paths), "persistent-token-1234567890");
    assert.equal(configuredGatewayToken("http://127.0.0.1:4567", paths), undefined);

    resetConfig("desktop", paths);
    assert.equal(configuredGatewayToken("http://127.0.0.1:3456", paths), "persistent-token-1234567890");

    writeFileSync(join(paths.claudeDesktopDir, "_meta.json"), "{invalid json", "utf8");
    assert.throws(
      () => configuredGatewayToken("http://127.0.0.1:3456", paths),
      (error: unknown) => error instanceof BridgeError && error.code === "invalid_saved_gateway_config",
    );
  } finally {
    cleanup();
  }
});

test("resetConfig cleanly strips gateway settings from CLI and Desktop without corrupting files", () => {
  const { paths, cleanup } = createSandbox();
  try {
    // 1. Setup all
    setupConfig("all", {
      gatewayUrl: "http://127.0.0.1:3456",
      token: "secure-token-1234567890123456",
      paths,
    });

    // Add custom env setting that must be preserved
    const settingsBefore = JSON.parse(readFileSync(paths.claudeSettingsPath, "utf8"));
    settingsBefore.env.MY_CUSTOM_VAR = "keep-me";
    writeFileSync(paths.claudeSettingsPath, JSON.stringify(settingsBefore), "utf8");

    // 2. Reset all
    const resetResult = resetConfig("all", paths);
    assert.equal(resetResult.cliReset, true);
    assert.equal(resetResult.desktopReset, true);

    // Verify CLI
    const settingsAfter = JSON.parse(readFileSync(paths.claudeSettingsPath, "utf8"));
    assert.equal(settingsAfter.env.ANTHROPIC_BASE_URL, undefined);
    assert.equal(settingsAfter.env.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(settingsAfter.env.CLAUDE_CODE_EFFORT_LEVEL, undefined);
    assert.equal(settingsAfter.env.CLAUDE_CODE_MODEL_CAPABILITIES, undefined);
    assert.equal(settingsAfter.env.ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES, undefined);
    assert.equal(settingsAfter.env.ANTHROPIC_DEFAULT_FABLE_MODEL_SUPPORTED_CAPABILITIES, undefined);
    assert.equal(settingsAfter.env.ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES, undefined);
    assert.equal(settingsAfter.env.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES, undefined);
    assert.equal(settingsAfter.modelPicker, undefined);
    assert.equal(settingsAfter.env.MY_CUSTOM_VAR, "keep-me");
    assert.equal(settingsAfter.permissions, undefined);
    assert.equal(settingsAfter.skipDangerousModePermissionPrompt, undefined);

    // Verify Desktop
    const metaAfter = JSON.parse(readFileSync(join(paths.claudeDesktopDir, "_meta.json"), "utf8"));
    assert.equal(metaAfter.appliedId, "");
    assert.equal(
      metaAfter.entries.some((e: { id: string }) => e.id === CODEX2CC_DESKTOP_CONFIG_ID),
      false,
    );
  } finally {
    cleanup();
  }
});

test("Desktop reset restores account mode while preserving profile preferences", () => {
  const { sandboxDir, paths, cleanup } = createSandbox();
  try {
    setupConfig("desktop", { gatewayUrl: "http://127.0.0.1:3456", token: "secure-token-1234567890123456", paths });
    const profileConfig = join(sandboxDir, "Claude-3p", "claude_desktop_config.json");
    writeFileSync(profileConfig, JSON.stringify({ deploymentMode: "3p", preferences: { locale: "vi" } }));

    const result = resetConfig("desktop", paths);
    assert.deepEqual(JSON.parse(readFileSync(profileConfig, "utf8")), {
      deploymentMode: "1p",
      preferences: { locale: "vi" },
    });
    assert.ok(result.filesModified.includes(profileConfig));
    assert.deepEqual(resetConfig("desktop", paths).filesModified, [join(paths.claudeDesktopDir, "_meta.json")]);
  } finally {
    cleanup();
  }
});

test("Desktop reset keeps another gateway's active deployment mode", () => {
  const { sandboxDir, paths, cleanup } = createSandbox();
  try {
    setupConfig("desktop", { gatewayUrl: "http://127.0.0.1:3456", token: "secure-token-1234567890123456", paths });
    const profileConfig = join(sandboxDir, "Claude-3p", "claude_desktop_config.json");
    writeFileSync(profileConfig, JSON.stringify({ deploymentMode: "3p" }));
    writeFileSync(join(paths.claudeDesktopDir, "_meta.json"), JSON.stringify({
      appliedId: "another-gateway",
      entries: [{ id: CODEX2CC_DESKTOP_CONFIG_ID, name: "Codex2CC" }, { id: "another-gateway", name: "Other" }],
    }));

    resetConfig("desktop", paths);
    assert.deepEqual(JSON.parse(readFileSync(profileConfig, "utf8")), { deploymentMode: "3p" });
  } finally {
    cleanup();
  }
});

test("setupConfig writes the routed models' context window and resetConfig removes it", () => {
  const { paths, cleanup } = createSandbox();
  try {
    setupConfig("cli", { gatewayUrl: "http://127.0.0.1:3456", token: "secure-token-1234567890123456", maxContextTokens: 272_000, paths });
    const settings = JSON.parse(readFileSync(paths.claudeSettingsPath, "utf8"));
    assert.equal(settings.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "272000");
    assert.equal(settings.env.CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT, undefined);

    resetConfig("cli", paths);
    assert.equal(JSON.parse(readFileSync(paths.claudeSettingsPath, "utf8")).env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, undefined);
  } finally {
    cleanup();
  }
});

test("claudeLaunchEnvironment keeps auto-compaction on and declares the real context window", () => {
  const launch = {
    gatewayUrl: "http://127.0.0.1:4000",
    token: "secret",
    model: "gpt-6-sol",
    opusModel: "gpt-6.1-sol",
    sonnetModel: "gpt-6-sol",
    haikuModel: "gpt-6-luna",
    maxContextTokens: 272_000,
  };
  const environment = claudeLaunchEnvironment({ PATH: "/bin", ANTHROPIC_API_KEY: "sk-ant-real" }, launch);
  assert.equal(environment.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "272000");
  assert.equal(environment.CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT, undefined);
  assert.equal(environment.ANTHROPIC_BASE_URL, "http://127.0.0.1:4000");
  assert.equal(environment.ANTHROPIC_DEFAULT_HAIKU_MODEL, "gpt-6-luna");
  assert.equal(environment.ANTHROPIC_API_KEY, undefined);
  assert.equal(environment.PATH, "/bin");

  assert.equal(claudeLaunchEnvironment({ CLAUDE_CODE_MAX_CONTEXT_TOKENS: "100000" }, launch).CLAUDE_CODE_MAX_CONTEXT_TOKENS, "100000", "an explicit user value wins");
  assert.equal(claudeLaunchEnvironment({}, { ...launch, maxContextTokens: undefined }).CLAUDE_CODE_MAX_CONTEXT_TOKENS, undefined);
});
