import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BridgeError } from "./bridge.js";
import {
  CODEX2CC_DESKTOP_CONFIG_ID,
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
  const { paths, cleanup } = createSandbox();
  try {
    writeFileSync(
      paths.claudeJsonPath,
      JSON.stringify({ primaryApiKey: "old-secret", customApiKeyResponses: { test: true }, otherSetting: 123 }),
      "utf8",
    );

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
    assert.equal(settings.env.API_TIMEOUT_MS, "600000");
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
      { name: "claude-sonnet-5-5" },
      { name: "claude-opus-5-5" },
      { name: "claude-haiku-5" },
      { name: "claude-fable-5-1" },
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
