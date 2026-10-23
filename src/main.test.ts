import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { TierModelStore } from "./models/tier-store.js";
import { API_PROVIDERS, defaultApiProviderConfig } from "./providers/config.js";

function startupEnvironment(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, CODEX2CC_HOME: home, CODEX2CC_SETTINGS_FILE: join(home, "settings.json"), CODEX2CC_LOG_FILE: join(home, "gateway.log"), CODEX2CC_USAGE_FILE: join(home, "usage.json") };
  for (const name of ["CODEX2CC_PROVIDER", "OPENROUTER_API_KEY", "OPENAI_API_KEY", "OPENCODE_API_KEY"]) delete env[name];
  return env;
}

function launch(args: string[], env: NodeJS.ProcessEnv): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [fileURLToPath(new URL("./main.js", import.meta.url)), ...args], { env, encoding: "utf8", timeout: 15000 });
}

test("startup lists configured API catalogs without keys or a Codex login", () => {
  const home = mkdtempSync(join(tmpdir(), "codex2cc-startup-"));
  try {
    const env = startupEnvironment(home);
    const store = TierModelStore.open(env.CODEX2CC_SETTINGS_FILE!, {});
    for (const provider of API_PROVIDERS) {
      const config = defaultApiProviderConfig(provider);
      store.saveApiProviderConfig(provider, config);
      const result = launch(["--list-models", "--provider", provider], env);
      assert.equal(result.status, 0, String(result.stderr));
      for (const model of config.models) assert.ok(String(result.stdout).includes(`${model.slug}\t${model.displayName}`));
      assert.doesNotMatch(String(result.stderr), /ChatGPT|codex login/);
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("startup precedence is explicit provider, environment, saved settings", () => {
  const home = mkdtempSync(join(tmpdir(), "codex2cc-precedence-"));
  try {
    const env = startupEnvironment(home);
    const store = TierModelStore.open(env.CODEX2CC_SETTINGS_FILE!, {});
    store.setProvider("opencode");
    const saved = launch(["--list-models"], env);
    assert.equal(saved.status, 0, String(saved.stderr));
    assert.match(String(saved.stdout), /deepseek/);
    const environment = launch(["--list-models"], { ...env, CODEX2CC_PROVIDER: "openrouter" });
    assert.equal(environment.status, 0, String(environment.stderr));
    assert.match(String(environment.stdout), /anthropic\/claude/);
    const explicit = launch(["--list-models", "--provider", "openai"], { ...env, CODEX2CC_PROVIDER: "openrouter" });
    assert.equal(explicit.status, 0, String(explicit.stderr));
    assert.doesNotMatch(String(explicit.stdout), /anthropic|deepseek/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("Claude launch fails fast for a missing API key without trying a Codex login", () => {
  const home = mkdtempSync(join(tmpdir(), "codex2cc-key-"));
  try {
    for (const provider of API_PROVIDERS) {
      const result = launch(["--provider", provider], startupEnvironment(home));
      assert.equal(result.status, 1);
      assert.match(String(result.stderr), /missing_provider_key/);
      assert.doesNotMatch(String(result.stderr), /Not logged into ChatGPT|ENOENT.*claude/);
      assert.equal(String(result.stdout), "");
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("API CLI setup uses saved mappings and configured default without a key", () => {
  const home = mkdtempSync(join(tmpdir(), "codex2cc-api-setup-"));
  try {
    const env = startupEnvironment(home);
    const store = TierModelStore.open(env.CODEX2CC_SETTINGS_FILE!, {});
    const config = defaultApiProviderConfig("openai");
    store.saveApiProviderConfig("openai", { ...config, defaultModel: "custom-model", models: [{ slug: "custom-model", displayName: "Custom", protocol: "responses", reasoning: "none", contextWindow: 64000 }] });
    store.setProvider("openai");
    const result = launch(["--setup-cli", "--token", "test-gateway-token-1234567890"], env);
    assert.equal(result.status, 0, String(result.stderr));
    const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8")) as { env: Record<string, string> };
    assert.equal(settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL, "custom-model");
    assert.equal(settings.env.ANTHROPIC_MODEL, "custom-model");
    assert.equal(settings.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "64000");
    assert.doesNotMatch(String(result.stderr), /ChatGPT/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});


test("API standalone startup permits a missing key and keeps the saved provider after restart", { timeout: 20000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "codex2cc-api-serve-"));
  const env = startupEnvironment(home);
  const store = TierModelStore.open(env.CODEX2CC_SETTINGS_FILE!, {});
  store.setProvider("opencode");
  const child = spawn(process.execPath, [fileURLToPath(new URL("./main.js", import.meta.url)), "--serve", "--port", "0", "--no-auth"], { env, stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  let output = "";
  let errors = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { errors += chunk; });
  try {
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Standalone gateway did not start: ${errors}`)), 10000);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Standalone exited with ${code}: ${errors}`)); });
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        output += chunk;
        const url = output.match(/Base URL: (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
        if (url) { clearTimeout(timer); resolve(url); }
      });
    });
    const response = await fetch(`${url}/api/ui/status`);
    assert.equal(response.status, 200);
    const status = await response.json() as { provider: { active: string; keyConfigured: boolean }; tierMapping: { models: { slug: string }[] } };
    assert.equal(status.provider.active, "opencode");
    assert.equal(status.provider.keyConfigured, false);
    assert.ok(status.tierMapping.models.some((model) => model.slug === "kimi-k3"));
    assert.doesNotMatch(errors, /ChatGPT/);
    const switched = await fetch(`${url}/api/ui/provider`, { method: "POST", headers: { "Content-Type": "application/json", Origin: url }, body: JSON.stringify({ provider: "openrouter" }) });
    assert.equal(switched.status, 200);
    await switched.text();
    assert.equal(TierModelStore.open(env.CODEX2CC_SETTINGS_FILE!, {}).getProvider(), "openrouter");
    const codex = await fetch(`${url}/api/ui/provider`, { method: "POST", headers: { "Content-Type": "application/json", Origin: url }, body: JSON.stringify({ provider: "codex" }) });
    assert.equal(codex.status, 200);
    await codex.text();
    // The optional Codex session is opened only when the newly selected provider uses it.
    const usage = await fetch(`${url}/api/ui/usage`);
    assert.equal(usage.status, 200);
    await usage.text();
    const logs = await fetch(`${url}/api/ui/logs`);
    const logBody = await logs.json() as { logs: { operation: string }[] };
    assert.ok(logBody.logs.some((entry) => entry.operation === "usage_limits_unavailable"));
  } finally {
    child.kill("SIGTERM");
    await exited;
    rmSync(home, { recursive: true, force: true });
  }
});

test("offline Codex setup retains support for an external gateway model", () => {
  const home = mkdtempSync(join(tmpdir(), "codex2cc-offline-setup-"));
  try {
    const result = launch(["--setup-cli", "--model", "external-model", "--token", "test-gateway-token-1234567890"], startupEnvironment(home));
    assert.equal(result.status, 0, String(result.stderr));
    const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8")) as { env: Record<string, string> };
    assert.equal(settings.env.ANTHROPIC_MODEL, "external-model");
  } finally { rmSync(home, { recursive: true, force: true }); }
});
