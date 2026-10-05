import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { BridgeError } from "../bridge/bridge.js";
import { MIN_TOKEN_LENGTH, type GuardPolicy } from "../gateway/guard.js";

export const DEFAULT_PORT = 3456;

export type CliCommand =
  | { readonly kind: "help" }
  | { readonly kind: "ui"; readonly model: string | undefined; readonly port: number }
  | { readonly kind: "list-models" }
  | { readonly kind: "serve"; readonly model: string | undefined; readonly port: number; readonly noAuth: boolean }
  | {
      readonly kind: "setup";
      readonly target: "cli" | "desktop" | "all";
      readonly gatewayUrl: string;
      readonly token: string | undefined;
      readonly model: string | undefined;
      readonly effort: string | undefined;
    }
  | {
      readonly kind: "reset-config";
      readonly target: "cli" | "desktop" | "all";
    }
  | { readonly kind: "claude"; readonly model: string | undefined; readonly claudeArgs: readonly string[] };

export const USAGE = `Usage: codex2cc [options] [-- <claude arguments>]

Run Claude Code on your ChatGPT (Codex) login, or serve a local Anthropic-compatible gateway.

Modes (default: launch Claude Code):
  --ui                      Launch the Web UI control panel in your default browser
  --serve                   Run a standalone gateway
  --setup                   Configure Claude Code CLI and Claude Desktop for the gateway
  --setup-cli               Configure only Claude Code CLI (~/.claude/settings.json)
  --setup-desktop           Configure only Claude Desktop
  --reset-config            Reset both Claude Code CLI and Claude Desktop configurations
  --reset-cli               Reset Claude Code CLI configuration
  --reset-desktop           Reset Claude Desktop configuration
  --list-models             Print the models available to your ChatGPT account
  -h, --help                Show this help

Options:
  --model <slug>            Model to use (default: first model of your account)
  --effort <level>          Reasoning effort level: low, medium, high, xhigh, max
  --port <n>                Standalone gateway port, 0-65535 (default: ${DEFAULT_PORT})
  --no-auth                 Standalone gateway without a token (not recommended)
  --gateway-url, --url <u>  Base URL for setup (default: http://127.0.0.1:${DEFAULT_PORT})
  --token <secret>          API key/token for setup (or CODEX2CC_TOKEN)
  -p, --print <prompt>      Run Claude Code non-interactively
  -c, --continue            Continue the previous Claude Code session
  --permission-mode <mode>  Claude Code permission mode
  -y, --dangerously-skip-permissions, --skip-permissions
                            Pass --dangerously-skip-permissions to Claude Code

Arguments after "--" are passed to Claude Code unchanged.
Environment: CODEX2CC_TOKEN, CODEX2CC_MODEL_FABLE/OPUS/SONNET/HAIKU, CODEX2CC_TIERS_FILE.
`;

const OPTIONS = {
  help: { type: "boolean", short: "h" },
  ui: { type: "boolean" },
  "list-models": { type: "boolean" },
  serve: { type: "boolean" },
  "no-auth": { type: "boolean" },
  model: { type: "string" },
  effort: { type: "string" },
  port: { type: "string" },
  "permission-mode": { type: "string" },
  print: { type: "string", short: "p" },
  continue: { type: "boolean", short: "c" },
  "dangerously-skip-permissions": { type: "boolean", short: "y" },
  "skip-permissions": { type: "boolean" },
  setup: { type: "boolean" },
  "setup-cli": { type: "boolean" },
  "setup-desktop": { type: "boolean" },
  "reset-config": { type: "boolean" },
  "reset-cli": { type: "boolean" },
  "reset-desktop": { type: "boolean" },
  "gateway-url": { type: "string" },
  url: { type: "string" },
  token: { type: "string" },
} as const;

function parseGatewayOptions(options: readonly string[]) {
  try {
    return parseArgs({ args: [...options], options: OPTIONS, strict: true, allowPositionals: false }).values;
  } catch (error) {
    if (error instanceof Error && "code" in error && typeof error.code === "string" && error.code.startsWith("ERR_PARSE_ARGS_")) {
      throw new BridgeError(400, "invalid_arguments", `${error.message.replace(/\.?$/, ".")} Pass Claude Code arguments after "--". Run codex2cc --help for usage.`);
    }
    throw error;
  }
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_PORT;
  if (!/^\d+$/.test(raw) || Number(raw) > 65_535) {
    throw new BridgeError(400, "invalid_port", `--port must be an integer between 0 and 65535, got "${raw}".`);
  }
  return Number(raw);
}

/**
 * Parses codex2cc arguments. Everything before `--` configures the gateway and is validated
 * strictly; everything after it is passed to Claude Code unchanged. Mode precedence:
 * --help, --ui, --list-models, --reset-config/cli/desktop, --setup/cli/desktop, --serve.
 */
export function parseCli(argv: readonly string[]): CliCommand {
  const separator = argv.indexOf("--");
  const values = parseGatewayOptions(separator < 0 ? argv : argv.slice(0, separator));
  const claudeArgs = separator < 0 ? [] : argv.slice(separator + 1);
  const model = values.model || undefined;

  if (values.help) return { kind: "help" };
  if (values.ui) return { kind: "ui", model, port: parsePort(values.port) };
  if (values["list-models"]) return { kind: "list-models" };

  if (values["reset-config"] || values["reset-cli"] || values["reset-desktop"]) {
    const target = values["reset-config"] ? "all" : values["reset-desktop"] ? "desktop" : "cli";
    return { kind: "reset-config", target };
  }

  if (values.setup || values["setup-cli"] || values["setup-desktop"]) {
    const target = values.setup ? "all" : values["setup-desktop"] ? "desktop" : "cli";
    const port = values.port ? parsePort(values.port) : DEFAULT_PORT;
    const gatewayUrl = values["gateway-url"] || values.url || `http://127.0.0.1:${port}`;
    const token = values.token?.trim() || undefined;
    const effort = values.effort?.trim() || undefined;
    return { kind: "setup", target, gatewayUrl, token, model, effort };
  }

  if (values.serve) return { kind: "serve", model, port: parsePort(values.port), noAuth: values["no-auth"] === true };

  const forwarded = [...claudeArgs];
  const skipPermissions = values["dangerously-skip-permissions"] === true || values["skip-permissions"] === true;
  if (skipPermissions && !forwarded.includes("--dangerously-skip-permissions")) {
    forwarded.unshift("--dangerously-skip-permissions");
  }
  if (values["permission-mode"] && !forwarded.includes("--permission-mode")) {
    forwarded.unshift("--permission-mode", values["permission-mode"]);
  }
  if (values.effort && !forwarded.includes("--effort")) {
    forwarded.unshift("--effort", values.effort);
  }
  if (values.print && !forwarded.includes("-p")) {
    forwarded.push("-p", values.print);
  }
  if (values.continue === true && !forwarded.includes("--continue") && !forwarded.includes("-c")) {
    forwarded.push("--continue");
  }
  return { kind: "claude", model, claudeArgs: forwarded };
}

/** Chooses the standalone gateway credential policy from --no-auth and CODEX2CC_TOKEN. */
export function standalonePolicy(noAuth: boolean, configuredToken: string | undefined): GuardPolicy {
  if (noAuth) return { mode: "open" };
  const token = configuredToken?.trim();
  if (token === undefined || token.length === 0) return { mode: "token", token: randomBytes(32).toString("base64url") };
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new BridgeError(400, "weak_gateway_token", `CODEX2CC_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters.`);
  }
  return { mode: "token", token };
}
