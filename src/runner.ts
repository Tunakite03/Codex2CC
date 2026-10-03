import { spawn, type ChildProcess } from "node:child_process";

const DEFAULT_KILL_GRACE_MS = 5_000;
const PIPE_DRAIN_GRACE_MS = 1_000;

export type RunOptions = {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly maxOutputChars: number;
  readonly killGraceMs?: number;
  readonly onStdout?: (chunk: string) => void;
};

export type RunResult = {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly outputTruncated: boolean;
  readonly timedOut: boolean;
};

const activeChildren = new Set<ChildProcess>();

function logSignalFailure(pid: number, signal: NodeJS.Signals, error: unknown): void {
  process.stderr.write(`${JSON.stringify({
    level: "warn",
    operation: "signal_process_group",
    pid,
    signal,
    message: error instanceof Error ? error.message : String(error),
  })}\n`);
}

/** Signals the child's process group. A group that is already gone is not an error; other failures are logged. */
function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return;
    logSignalFailure(child.pid, signal, error);
  }
}

/** Force-kills every process group started through runProcess. Safe to call repeatedly. */
export function killAllProcesses(): void {
  for (const child of activeChildren) signalGroup(child, "SIGKILL");
}

function appendBounded(current: string, chunk: string, max: number): { text: string; truncated: boolean } {
  const joined = current + chunk;
  return joined.length > max ? { text: joined.slice(-max), truncated: true } : { text: joined, truncated: false };
}

/**
 * Runs a child in its own process group so timeouts and shutdown also reach its descendants.
 * Output keeps only the last `maxOutputChars` characters. After a timeout the group is
 * terminated, then killed, and if a descendant that left the group still holds the output
 * pipes open the call settles anyway. Rejects only when the spawn itself fails.
 */
export function runProcess(options: RunOptions): Promise<RunResult> {
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn(options.command, [...options.args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    activeChildren.add(child);

    let stdout = "";
    let stderr = "";
    let outputTruncated = false;
    let timedOut = false;
    let settled = false;
    const timers: NodeJS.Timeout[] = [];

    const settle = (): boolean => {
      if (settled) return false;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      activeChildren.delete(child);
      return true;
    };

    timers.push(setTimeout(() => {
      timedOut = true;
      signalGroup(child, "SIGTERM");
      timers.push(setTimeout(() => {
        signalGroup(child, "SIGKILL");
        timers.push(setTimeout(() => {
          if (!settle()) return;
          child.stdout.destroy();
          child.stderr.destroy();
          resolve({ exitCode: child.exitCode, signal: child.signalCode ?? "SIGKILL", stdout, stderr, outputTruncated, timedOut });
        }, PIPE_DRAIN_GRACE_MS));
      }, killGraceMs));
    }, options.timeoutMs));

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      const next = appendBounded(stdout, chunk, options.maxOutputChars);
      stdout = next.text;
      outputTruncated ||= next.truncated;
      options.onStdout?.(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      const next = appendBounded(stderr, chunk, options.maxOutputChars);
      stderr = next.text;
      outputTruncated ||= next.truncated;
    });
    child.once("error", (error) => {
      if (settle()) reject(error);
    });
    // The child itself is done; a descendant holding the pipes must not turn this into a timeout or a hang.
    child.once("exit", (exitCode, signal) => {
      for (const timer of timers) clearTimeout(timer);
      timers.push(setTimeout(() => {
        if (!settle()) return;
        child.stdout.destroy();
        child.stderr.destroy();
        resolve({ exitCode, signal, stdout, stderr, outputTruncated, timedOut });
      }, PIPE_DRAIN_GRACE_MS));
    });
    child.once("close", (exitCode, signal) => {
      if (settle()) resolve({ exitCode, signal, stdout, stderr, outputTruncated, timedOut });
    });
  });
}
