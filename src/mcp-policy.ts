import { realpath, stat } from "node:fs/promises";
import { delimiter, isAbsolute, relative, resolve, sep, parse } from "node:path";

export const PERMISSION_MODES = ["plan", "default", "acceptEdits", "bypassPermissions"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];
export const DEFAULT_PERMISSION_MODE: PermissionMode = "acceptEdits";

const DEFAULT_TASK_TIMEOUT_MS = 1_800_000;
const DEFAULT_MAX_CONCURRENT = 3;
const DEFAULT_TASK_TTL_MS = 3_600_000;
const DEFAULT_MAX_STORED_TASKS = 100;
const DEFAULT_MAX_OUTPUT_CHARS = 1_000_000;

export class PolicyError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "PolicyError";
  }
}

export type McpPolicy = {
  readonly allowedRoots: readonly string[];
  readonly allowBypass: boolean;
  readonly taskTimeoutMs: number;
  readonly maxConcurrent: number;
  readonly taskTtlMs: number;
  readonly maxStoredTasks: number;
  readonly maxOutputChars: number;
  readonly claudeBinary: string;
};

const MAX_TIMER_MS = 2_147_483_647;

function positiveInteger(env: NodeJS.ProcessEnv, name: string, fallback: number, max: number = Number.MAX_SAFE_INTEGER): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) {
    throw new PolicyError("invalid_policy_value", `${name} must be a positive integer no greater than ${max}.`);
  }
  return value;
}

/**
 * Reads the MCP execution policy from the environment. When no roots are configured the
 * server working directory is the only allowed root, unless that directory is the
 * filesystem root, in which case no root is allowed until the user configures one.
 */
export function loadMcpPolicy(env: NodeJS.ProcessEnv, cwd: string): McpPolicy {
  const configured = (env.CODEX2CC_ALLOWED_ROOTS ?? "")
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  for (const entry of configured) {
    if (!isAbsolute(entry)) {
      throw new PolicyError("invalid_policy_value", "CODEX2CC_ALLOWED_ROOTS entries must be absolute paths.");
    }
  }
  const resolvedCwd = resolve(cwd);
  const allowedRoots = configured.length > 0
    ? configured.map((entry) => resolve(entry))
    : parse(resolvedCwd).root === resolvedCwd ? [] : [resolvedCwd];
  return {
    allowedRoots,
    allowBypass: env.CODEX2CC_ALLOW_BYPASS === "1",
    taskTimeoutMs: positiveInteger(env, "CODEX2CC_TASK_TIMEOUT_MS", DEFAULT_TASK_TIMEOUT_MS, MAX_TIMER_MS),
    maxConcurrent: positiveInteger(env, "CODEX2CC_MAX_CONCURRENT", DEFAULT_MAX_CONCURRENT),
    taskTtlMs: positiveInteger(env, "CODEX2CC_TASK_TTL_MS", DEFAULT_TASK_TTL_MS),
    maxStoredTasks: positiveInteger(env, "CODEX2CC_MAX_STORED_TASKS", DEFAULT_MAX_STORED_TASKS),
    maxOutputChars: positiveInteger(env, "CODEX2CC_MAX_OUTPUT_CHARS", DEFAULT_MAX_OUTPUT_CHARS),
    claudeBinary: env.CODEX2CC_CLAUDE_BIN?.trim() || "claude",
  };
}

function isWithin(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

async function realDirectory(path: string): Promise<string | undefined> {
  try {
    const real = await realpath(path);
    return (await stat(real)).isDirectory() ? real : undefined;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) return undefined;
    throw error;
  }
}

/** Resolves the working directory for a task, refusing anything outside the allowed roots. */
export async function resolveProjectDir(requested: string | undefined, policy: McpPolicy): Promise<string> {
  if (policy.allowedRoots.length === 0) {
    throw new PolicyError(
      "no_allowed_roots",
      "No allowed project roots. Set CODEX2CC_ALLOWED_ROOTS to a path-delimited list of absolute directories.",
    );
  }
  const candidate = requested ?? policy.allowedRoots[0];
  if (candidate === undefined || !isAbsolute(candidate)) {
    throw new PolicyError("invalid_project_dir", "project_dir must be an absolute path.");
  }
  const target = await realDirectory(candidate);
  if (target === undefined) throw new PolicyError("invalid_project_dir", "project_dir does not exist or is not a directory.");
  for (const root of policy.allowedRoots) {
    const realRoot = await realDirectory(root);
    if (realRoot !== undefined && isWithin(realRoot, target)) return target;
  }
  throw new PolicyError("project_dir_not_allowed", "project_dir is outside CODEX2CC_ALLOWED_ROOTS.");
}

/** Maps a permission mode to Claude CLI flags. Bypass needs both the caller request and operator opt-in. */
export function permissionArgs(mode: PermissionMode, policy: McpPolicy): string[] {
  if (mode !== "bypassPermissions") return ["--permission-mode", mode];
  if (!policy.allowBypass) {
    throw new PolicyError("bypass_not_allowed", "bypassPermissions requires the operator to set CODEX2CC_ALLOW_BYPASS=1.");
  }
  return ["--dangerously-skip-permissions"];
}

/** Drops finished tasks past their TTL, then the oldest finished tasks beyond the storage cap. */
export function pruneTasks(
  tasks: Map<string, { readonly completedAt?: number | undefined }>,
  now: number,
  ttlMs: number,
  maxStored: number,
): void {
  for (const [id, task] of tasks) {
    if (task.completedAt !== undefined && now - task.completedAt > ttlMs) tasks.delete(id);
  }
  if (tasks.size <= maxStored) return;
  const finished = [...tasks].filter(([, task]) => task.completedAt !== undefined)
    .sort(([, a], [, b]) => (a.completedAt ?? 0) - (b.completedAt ?? 0));
  for (const [id] of finished) {
    if (tasks.size <= maxStored) return;
    tasks.delete(id);
  }
}
