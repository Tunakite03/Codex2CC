import { PROVIDERS } from "../models/models.js";
import assert from "node:assert/strict";
import test from "node:test";
import { BridgeError } from "../bridge/bridge.js";
import { DEFAULT_PORT, parseCli, standalonePolicy } from "./cli.js";

test("parseCli gives --help precedence, then --ui, then --list-models, then --serve", () => {
  assert.deepEqual(parseCli(["--ui", "-h"]), { kind: "help" });
  assert.deepEqual(parseCli(["--ui", "--serve", "--list-models"]), { kind: "ui", model: undefined, port: DEFAULT_PORT });
  assert.deepEqual(parseCli(["--list-models", "--serve"]), { kind: "list-models" });
});

test("parseCli reads serve and ui options and defaults the port", () => {
  assert.deepEqual(parseCli(["--serve"]), { kind: "serve", model: undefined, port: DEFAULT_PORT, noAuth: false });
  assert.deepEqual(parseCli(["--serve", "--port", "4000", "--model", "gpt-6-sol", "--no-auth"]), {
    kind: "serve",
    model: "gpt-6-sol",
    port: 4000,
    noAuth: true,
  });
  assert.deepEqual(parseCli(["--ui"]), { kind: "ui", model: undefined, port: DEFAULT_PORT });
  assert.deepEqual(parseCli(["--ui", "--port", "3900", "--model", "gpt-6.1-sol"]), {
    kind: "ui",
    model: "gpt-6.1-sol",
    port: 3900,
  });
});

test("parseCli parses setup and reset options with proper targets and defaults", () => {
  assert.deepEqual(parseCli(["--setup"]), {
    kind: "setup",
    target: "all",
    gatewayUrl: `http://127.0.0.1:${DEFAULT_PORT}`,
    token: undefined,
    model: undefined,
    effort: undefined,
  });
  assert.deepEqual(parseCli(["--setup-cli", "--gateway-url", "https://my-gateway.com", "--token", "secret1234567890", "--model", "gpt-6-sol", "--effort", "high"]), {
    kind: "setup",
    target: "cli",
    gatewayUrl: "https://my-gateway.com",
    token: "secret1234567890",
    model: "gpt-6-sol",
    effort: "high",
  });
  assert.deepEqual(parseCli(["--setup-desktop", "--port", "8080"]), {
    kind: "setup",
    target: "desktop",
    gatewayUrl: "http://127.0.0.1:8080",
    token: undefined,
    model: undefined,
    effort: undefined,
  });
  assert.deepEqual(parseCli(["--reset-config"]), { kind: "reset-config", target: "all" });
  assert.deepEqual(parseCli(["--reset-cli"]), { kind: "reset-config", target: "cli" });
  assert.deepEqual(parseCli(["--reset-desktop"]), { kind: "reset-config", target: "desktop" });
});

test("parseCli treats an empty --model value as not provided", () => {
  assert.deepEqual(parseCli(["--model", ""]), { kind: "claude", model: undefined, claudeArgs: [] });
});

test("parseCli passes arguments after -- to Claude Code untouched", () => {
  assert.deepEqual(parseCli(["--model", "gpt-6-sol", "--", "--resume", "abc"]), {
    kind: "claude",
    model: "gpt-6-sol",
    claudeArgs: ["--resume", "abc"],
  });
});

test("parseCli translates shorthand flags into Claude Code arguments without duplicating them", () => {
  const command = parseCli(["-y", "--permission-mode", "plan", "-p", "fix it", "-c"]);
  assert.deepEqual(command, {
    kind: "claude",
    model: undefined,
    claudeArgs: ["--permission-mode", "plan", "--dangerously-skip-permissions", "-p", "fix it", "--continue"],
  });
  const deduplicated = parseCli(["-y", "-c", "--", "--dangerously-skip-permissions", "--continue"]);
  assert.deepEqual(deduplicated, { kind: "claude", model: undefined, claudeArgs: ["--dangerously-skip-permissions", "--continue"] });
});

test("standalonePolicy opens only on --no-auth, generates a token by default, and rejects weak tokens", () => {
  assert.deepEqual(standalonePolicy(true, undefined), { mode: "open" });
  const generated = standalonePolicy(false, undefined);
  assert.equal(generated.mode, "token");
  assert.ok(generated.mode === "token" && generated.token.length >= 32);
  assert.notDeepEqual(standalonePolicy(false, "  "), standalonePolicy(false, "  "), "blank token generates fresh secrets");
  assert.deepEqual(standalonePolicy(false, "  configured-token-123  "), { mode: "token", token: "configured-token-123" });
  assert.throws(() => standalonePolicy(false, "short"), (error: unknown) => error instanceof BridgeError && error.code === "weak_gateway_token");
});

test("parseCli rejects unknown options, stray arguments and bad ports instead of ignoring them", () => {
  const invalid = (argv: string[], code: string): void => {
    assert.throws(() => parseCli(argv), (error: unknown) => error instanceof BridgeError && error.status === 400 && error.code === code, argv.join(" "));
  };
  invalid(["--bogus"], "invalid_arguments");
  invalid(["stray"], "invalid_arguments");
  invalid(["--model"], "invalid_arguments");
  invalid(["--serve", "--port", "abc"], "invalid_port");
  invalid(["--serve", "--port", "70000"], "invalid_port");
  invalid(["--serve", "--port", "-1"], "invalid_arguments");
  assert.deepEqual(parseCli(["--serve", "--port", "0"]), { kind: "serve", model: undefined, port: 0, noAuth: false });
  assert.deepEqual(parseCli(["--serve", "--port", ""]), { kind: "serve", model: undefined, port: DEFAULT_PORT, noAuth: false });
});

test("arguments after -- are not validated as codex2cc options", () => {
  assert.deepEqual(parseCli(["--", "--bogus", "stray"]), { kind: "claude", model: undefined, claudeArgs: ["--bogus", "stray"] });
});

test("parseCli reads --sync-desktop-sessions with an optional --dry-run and rejects a stray --dry-run", () => {
  assert.deepEqual(parseCli(["--sync-desktop-sessions"]), { kind: "sync-desktop-sessions", dryRun: false });
  assert.deepEqual(parseCli(["--sync-desktop-sessions", "--dry-run"]), { kind: "sync-desktop-sessions", dryRun: true });
  assert.deepEqual(parseCli(["--sync-desktop-sessions", "--setup-desktop"]), { kind: "sync-desktop-sessions", dryRun: false });
  for (const argv of [["--dry-run"], ["--setup", "--dry-run"], ["--reset-desktop", "--dry-run"]]) {
    assert.throws(() => parseCli(argv), (error: unknown) => error instanceof BridgeError && error.code === "invalid_arguments" && /--dry-run/.test(error.message), argv.join(" "));
  }
});


test("parseCli accepts each provider across launch and setup modes", () => {
  for (const provider of PROVIDERS) {
    for (const flags of [[], ["--ui"], ["--serve"], ["--list-models"], ["--setup"], ["--setup-cli"], ["--setup-desktop"]]) {
      const command = parseCli([...flags, "--provider", provider]);
      assert.ok("provider" in command);
      assert.equal(command.provider, provider);
    }
  }
});

test("parseCli validates environment providers and respects explicit precedence", () => {
  const previous = process.env.CODEX2CC_PROVIDER;
  try {
    process.env.CODEX2CC_PROVIDER = " openrouter ";
    assert.deepEqual(parseCli(["--list-models"]), { kind: "list-models", provider: "openrouter" });
    assert.deepEqual(parseCli(["--list-models", "--provider", "OPENAI"]), { kind: "list-models", provider: "openai" });
    for (const invalid of ["", "unknown", "open-ai"]) {
      process.env.CODEX2CC_PROVIDER = invalid;
      assert.throws(() => parseCli(["--serve"]), (error: unknown) => error instanceof BridgeError && error.code === "invalid_arguments" && /CODEX2CC_PROVIDER/.test(error.message));
    }
    delete process.env.CODEX2CC_PROVIDER;
    for (const invalid of ["", "unknown", "open-ai"]) {
      assert.throws(() => parseCli(["--provider", invalid]), (error: unknown) => error instanceof BridgeError && error.code === "invalid_arguments" && /--provider/.test(error.message));
    }
  } finally {
    if (previous === undefined) delete process.env.CODEX2CC_PROVIDER;
    else process.env.CODEX2CC_PROVIDER = previous;
  }
});
