import { randomBytes } from "node:crypto";
import { BridgeError } from "./bridge.js";
import { MIN_TOKEN_LENGTH, type GuardPolicy } from "./guard.js";

export const DEFAULT_PORT = 3456;

export type CliCommand =
  | { readonly kind: "mcp" }
  | { readonly kind: "list-models" }
  | { readonly kind: "serve"; readonly model: string | undefined; readonly port: number; readonly noAuth: boolean }
  | { readonly kind: "claude"; readonly model: string | undefined; readonly claudeArgs: readonly string[] };

function valueAfter(options: readonly string[], flag: string): string | undefined {
  const index = options.indexOf(flag);
  return index >= 0 ? options[index + 1] : undefined;
}

/**
 * Parses codex2cc arguments. Everything before `--` configures the gateway; everything
 * after it is passed to Claude Code unchanged. Mode precedence: --mcp, --list-models, --serve.
 */
export function parseCli(argv: readonly string[]): CliCommand {
  const separator = argv.indexOf("--");
  const options = separator < 0 ? argv : argv.slice(0, separator);
  const claudeArgs = separator < 0 ? [] : argv.slice(separator + 1);
  const model = valueAfter(options, "--model");

  if (options.includes("--mcp")) return { kind: "mcp" };
  if (options.includes("--list-models")) return { kind: "list-models" };
  if (options.includes("--serve")) {
    const rawPort = valueAfter(options, "--port");
    return {
      kind: "serve",
      model,
      port: rawPort ? parseInt(rawPort, 10) : DEFAULT_PORT,
      noAuth: options.includes("--no-auth"),
    };
  }

  const forwarded = [...claudeArgs];
  const skipPermissions = options.includes("--dangerously-skip-permissions") || options.includes("-y") || options.includes("--skip-permissions");
  const permissionMode = valueAfter(options, "--permission-mode");
  const printPrompt = valueAfter(options, "-p");
  const continueSession = options.includes("--continue") || options.includes("-c");
  if (skipPermissions && !forwarded.includes("--dangerously-skip-permissions")) {
    forwarded.unshift("--dangerously-skip-permissions");
  }
  if (permissionMode && !forwarded.includes("--permission-mode")) {
    forwarded.unshift("--permission-mode", permissionMode);
  }
  if (printPrompt && !forwarded.includes("-p")) {
    forwarded.push("-p", printPrompt);
  }
  if (continueSession && !forwarded.includes("--continue") && !forwarded.includes("-c")) {
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
