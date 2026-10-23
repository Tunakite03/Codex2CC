import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { BridgeError } from "../bridge/bridge.js";
import { MIN_TOKEN_LENGTH, type GuardPolicy } from "../gateway/guard.js";
import { PROVIDERS, isProviderType, type ProviderType } from "../models/models.js";

export const DEFAULT_PORT = 3456;

export type CliCommand =
  | { readonly kind: "help" }
  | { readonly kind: "ui"; readonly model: string | undefined; readonly port: number; readonly provider?: ProviderType | undefined }
  | { readonly kind: "list-models"; readonly provider?: ProviderType | undefined }
  | { readonly kind: "serve"; readonly model: string | undefined; readonly port: number; readonly noAuth: boolean; readonly provider?: ProviderType | undefined }
  | {
      readonly kind: "setup";
      readonly target: "cli" | "desktop" | "all";
      readonly gatewayUrl: string;
      readonly token: string | undefined;
      readonly model: string | undefined;
      readonly effort: string | undefined;
      readonly provider?: ProviderType | undefined;
    }
  | {
      readonly kind: "reset-config";
      readonly target: "cli" | "desktop" | "all";
    }
  | { readonly kind: "sync-desktop-sessions"; readonly dryRun: boolean; readonly allAccounts: boolean }
  | { readonly kind: "claude"; readonly model: string | undefined; readonly claudeArgs: readonly string[]; readonly provider?: ProviderType | undefined };

export const USAGE = `Usage: codex2cc [options] [-- <claude arguments>]

Run Claude Code through a subscription or API provider, or serve a local Anthropic-compatible gateway.

Modes (default: launch Claude Code):
  --ui                      Launch the Web UI control panel in your default browser
  --serve                   Run a standalone gateway
  --setup                   Configure Claude Code CLI and Claude Desktop for the gateway
  --setup-cli               Configure only Claude Code CLI (~/.claude/settings.json)
  --setup-desktop           Configure only Claude Desktop
  --reset-config            Reset both Claude Code CLI and Claude Desktop configurations
  --reset-cli               Reset Claude Code CLI configuration
  --reset-desktop           Reset Claude Desktop configuration
  --sync-desktop-sessions   Copy missing Code-tab sessions between the Desktop claude.ai and
                            gateway profiles (Claude Desktop must be closed)
  --list-models             Print the selected provider catalog (API providers: configured models, offline)
  -h, --help                Show this help

Options:
  --model <slug>            Model to use from the selected provider catalog
  --effort <level>          Reasoning effort level: low, medium, high, xhigh, max
  --port <n>                Standalone gateway port, 0-65535 (default: ${DEFAULT_PORT})
  --no-auth                 Standalone gateway without a token (not recommended)
  --gateway-url, --url <u>  Base URL for setup (default: http://127.0.0.1:${DEFAULT_PORT})
  --token <secret>          Gateway token for client setup (or CODEX2CC_TOKEN)
  --provider <name>         Backend: ${PROVIDERS.join(", ")}
  --dry-run                 With --sync-desktop-sessions: show what would be copied, change nothing
  --all-accounts            With --sync-desktop-sessions: sync every account of both profiles with
                            each other (ignores CODEX2CC_*_SESSION_SCOPE)
  -p, --print <prompt>      Run Claude Code non-interactively
  -c, --continue            Continue the previous Claude Code session
  --permission-mode <mode>  Claude Code permission mode
  -y, --dangerously-skip-permissions, --skip-permissions
                            Pass --dangerously-skip-permissions to Claude Code

Arguments after "--" are passed to Claude Code unchanged.
Provider precedence: --provider > CODEX2CC_PROVIDER > saved settings > codex.
Environment: CODEX2CC_PROVIDER, CODEX2CC_TOKEN, CODEX2CC_MODEL_FABLE/OPUS/SONNET/HAIKU.
API keys: OPENROUTER_API_KEY, OPENAI_API_KEY, OPENCODE_API_KEY, ... (shell environment or <data dir>/.env; the shell wins).
Use --ui to configure endpoint URLs, the API key environment variable name, default model,
and model catalog. Supported adapter protocols: chat-completions, responses, anthropic-messages.
Settings: CODEX2CC_SETTINGS_FILE (legacy alias: CODEX2CC_TIERS_FILE), otherwise
<data dir>/logs/settings.json. Data dir: CODEX2CC_HOME, otherwise the source checkout
or ~/.codex2cc for an installed package. API key values are never saved in settings.
--ui and --serve can start without an API key; launching Claude Code requires the selected key.
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
  "sync-desktop-sessions": { type: "boolean" },
  "dry-run": { type: "boolean" },
  "all-accounts": { type: "boolean" },
  "gateway-url": { type: "string" },
  url: { type: "string" },
  token: { type: "string" },
  provider: { type: "string" },
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
 * --help, --ui, --list-models, --sync-desktop-sessions, --reset-config/cli/desktop, --setup/cli/desktop, --serve.
 */
export function parseCli(argv: readonly string[]): CliCommand {
  const separator = argv.indexOf("--");
  const values = parseGatewayOptions(separator < 0 ? argv : argv.slice(0, separator));
  const claudeArgs = separator < 0 ? [] : argv.slice(separator + 1);
  const model = values.model || undefined;

  const rawProvider = values.provider?.trim().toLowerCase();
  const envProvider = process.env.CODEX2CC_PROVIDER?.trim().toLowerCase();
  for (const [source, value] of [["--provider", rawProvider], ["CODEX2CC_PROVIDER", envProvider]] as const) {
    if (value !== undefined && !isProviderType(value)) {
      throw new BridgeError(400, "invalid_arguments", `${source} must be one of: ${PROVIDERS.join(", ")}.`);
    }
  }
  const chosenProvider = rawProvider ?? envProvider;
  const provider = chosenProvider !== undefined && isProviderType(chosenProvider) ? chosenProvider : undefined;

  if (values.help) return { kind: "help" };
  if (values.ui) return { kind: "ui", model, port: parsePort(values.port), ...(provider !== undefined ? { provider } : {}) };
  if (values["list-models"]) return { kind: "list-models", ...(provider !== undefined ? { provider } : {}) };

  const dryRun = values["dry-run"] === true;
  const allAccounts = values["all-accounts"] === true;
  if (values["sync-desktop-sessions"]) return { kind: "sync-desktop-sessions", dryRun, allAccounts };
  if (dryRun) throw new BridgeError(400, "invalid_arguments", "--dry-run is only valid with --sync-desktop-sessions.");
  if (allAccounts) throw new BridgeError(400, "invalid_arguments", "--all-accounts is only valid with --sync-desktop-sessions.");

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
    return { kind: "setup", target, gatewayUrl, token, model, effort, ...(provider !== undefined ? { provider } : {}) };
  }

  if (values.serve) return { kind: "serve", model, port: parsePort(values.port), noAuth: values["no-auth"] === true, ...(provider !== undefined ? { provider } : {}) };

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
  return { kind: "claude", model, claudeArgs: forwarded, ...(provider !== undefined ? { provider } : {}) };
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
