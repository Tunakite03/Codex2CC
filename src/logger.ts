import { appendFileSync, existsSync, mkdirSync, readFileSync, truncateSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type LogLevel = "info" | "warn" | "error";

export type LogDetails = Readonly<Record<string, string | number | boolean | null>>;

export type LogEntry = {
  readonly id: number;
  readonly timestamp: string;
  readonly level: LogLevel;
  readonly operation: string;
  readonly message: string;
  readonly details?: LogDetails | undefined;
};

export type LogFilter = {
  readonly level?: LogLevel | undefined;
  readonly sinceId?: number | undefined;
  readonly limit?: number | undefined;
  readonly search?: string | undefined;
};

export type LogStats = {
  readonly total: number;
  readonly infoCount: number;
  readonly warnCount: number;
  readonly errorCount: number;
};

const MAX_LOG_ENTRIES = 500;
let nextLogId = 1;
const logStore: LogEntry[] = [];

/**
 * Resolves the root directory of the Codex2CC project workspace.
 */
export function resolveProjectRoot(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  return resolve(currentDir, "..");
}

/**
 * Determines the target log file path in the project (or from CODEX2CC_LOG_FILE env).
 */
export function resolveLogFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const custom = env.CODEX2CC_LOG_FILE?.trim();
  if (custom && custom.length > 0) {
    return resolve(custom);
  }
  return join(resolveProjectRoot(), "logs", "codex2cc.log");
}

let customLogFilePath: string | null | undefined = undefined;

/**
 * Overrides or disables the physical log file path.
 * - string: Explicit file path to write logs to.
 * - null: Disable file writing (useful for testing).
 * - undefined: Revert to default auto-resolved path (`resolveLogFilePath()`).
 */
export function setLogFilePath(path?: string | null): void {
  customLogFilePath = path;
}

/**
 * Returns the currently active log file path, or null if file logging is disabled.
 */
export function getActiveLogFilePath(): string | null {
  if (customLogFilePath === null) return null;
  return customLogFilePath ?? resolveLogFilePath();
}

/**
 * Formats a log entry into a human-readable and grep-friendly log line.
 */
export function formatLogLine(entry: LogEntry): string {
  const detailsStr = entry.details !== undefined ? ` | ${JSON.stringify(entry.details)}` : "";
  return `[${entry.timestamp}] [${entry.level.toUpperCase()}] [${entry.operation}] ${entry.message}${detailsStr}\n`;
}

function appendLogToFile(entry: LogEntry): void {
  const targetPath = getActiveLogFilePath();
  if (!targetPath) return;

  try {
    const dir = dirname(targetPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    appendFileSync(targetPath, formatLogLine(entry), "utf8");
  } catch (err) {
    process.stderr.write(`Failed to append log to ${targetPath}: ${(err as Error).message}\n`);
  }
}

/**
 * Records a new structured log entry into the circular buffer and appends to the project log file.
 */
export function recordLog(entry: {
  readonly level: LogLevel;
  readonly operation: string;
  readonly message: string;
  readonly details?: LogDetails;
}): LogEntry {
  const item: LogEntry = {
    id: nextLogId++,
    timestamp: new Date().toISOString(),
    level: entry.level,
    operation: entry.operation,
    message: entry.message,
    ...(entry.details !== undefined ? { details: entry.details } : {}),
  };

  logStore.push(item);
  if (logStore.length > MAX_LOG_ENTRIES) {
    logStore.shift();
  }

  appendLogToFile(item);

  return item;
}

/**
 * Retrieves log entries according to the provided filter options.
 */
export function getLogs(filter?: LogFilter): readonly LogEntry[] {
  let result = logStore;

  if (filter?.sinceId !== undefined) {
    const minId = filter.sinceId;
    result = result.filter((entry) => entry.id > minId);
  }

  if (filter?.level !== undefined) {
    const targetLevel = filter.level;
    result = result.filter((entry) => entry.level === targetLevel);
  }

  if (filter?.search !== undefined && filter.search.trim().length > 0) {
    const query = filter.search.trim().toLowerCase();
    result = result.filter((entry) => {
      if (entry.message.toLowerCase().includes(query)) return true;
      if (entry.operation.toLowerCase().includes(query)) return true;
      if (entry.details !== undefined) {
        for (const [k, v] of Object.entries(entry.details)) {
          if (k.toLowerCase().includes(query)) return true;
          if (v !== null && String(v).toLowerCase().includes(query)) return true;
        }
      }
      return false;
    });
  }

  if (filter?.limit !== undefined && filter.limit > 0 && result.length > filter.limit) {
    result = result.slice(result.length - filter.limit);
  }

  return [...result];
}

/**
 * Aggregates summary statistics for current stored logs.
 */
export function getLogStats(): LogStats {
  let infoCount = 0;
  let warnCount = 0;
  let errorCount = 0;

  for (const entry of logStore) {
    if (entry.level === "info") infoCount++;
    else if (entry.level === "warn") warnCount++;
    else if (entry.level === "error") errorCount++;
  }

  return {
    total: logStore.length,
    infoCount,
    warnCount,
    errorCount,
  };
}

/**
 * Clears all captured log entries from the buffer and optionally truncates the log file.
 */
export function clearLogs(options?: { readonly clearFile?: boolean }): void {
  logStore.length = 0;
  if (options?.clearFile) {
    const targetPath = getActiveLogFilePath();
    if (targetPath && existsSync(targetPath)) {
      try {
        truncateSync(targetPath, 0);
      } catch {
        // Non-fatal if truncate fails
      }
    }
  }
}

/**
 * Reads contents of the active log file.
 */
export function readLogFile(): string {
  const targetPath = getActiveLogFilePath();
  if (!targetPath || !existsSync(targetPath)) return "";
  try {
    return readFileSync(targetPath, "utf8");
  } catch {
    return "";
  }
}
