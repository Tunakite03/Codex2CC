import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import { z } from "zod";
import { BridgeError } from "../bridge/bridge.js";
import { resolveDataDir } from "../telemetry/logger.js";

/**
 * Claude Desktop keeps one Code-tab session list per profile: `Claude` while signed in with claude.ai,
 * `Claude-3p` while a third-party gateway is configured. Both point at the same transcripts in
 * `~/.claude/projects`, so copying the list entries makes each profile show every session. The layout
 * is Desktop's undocumented `claude-code-sessions/<account>/<org>/local_<uuid>.json`, with a
 * `deleted_<uuid>` tombstone left when a session is deleted.
 */

export type DesktopProfile = "claude" | "thirdParty";
export type SyncDirection = { readonly from: DesktopProfile; readonly to: DesktopProfile };

export const TO_GATEWAY_PROFILE: readonly SyncDirection[] = [{ from: "claude", to: "thirdParty" }];
export const TO_CLAUDE_PROFILE: readonly SyncDirection[] = [{ from: "thirdParty", to: "claude" }];
export const BOTH_PROFILES: readonly SyncDirection[] = [...TO_GATEWAY_PROFILE, ...TO_CLAUDE_PROFILE];

export type DesktopSessionPaths = {
  readonly profiles: Readonly<Record<DesktopProfile, string>>;
  /** Previous profile locations remain sources until their history has been migrated. */
  readonly legacyProfiles?: Readonly<Partial<Record<DesktopProfile, readonly string[]>>>;
  /** Claude Code transcripts, `<projects>/<project>/<cliSessionId>.jsonl`. */
  readonly projectsDir: string;
  /** Where each applied sync records changes and stores pre-refresh backups. */
  readonly manifestDir: string;
  /** Explicit <account>/<org> selections; multiple destination scopes must never be guessed. */
  readonly selectedScopes?: Readonly<Partial<Record<DesktopProfile, string>>>;
};

export function resolveDesktopSessionPaths(env: NodeJS.ProcessEnv = process.env, platformName: string = platform()): DesktopSessionPaths {
  const home = homedir();
  const appData = platformName === "darwin"
    ? join(home, "Library", "Application Support")
    : platformName === "win32"
      ? env.APPDATA || join(home, "AppData", "Roaming")
      : env.XDG_CONFIG_HOME || join(home, ".config");
  const gatewayData = platformName === "win32"
    ? env.LOCALAPPDATA || join(home, "AppData", "Local")
    : appData;
  const claudeConfigDir = env.CLAUDE_CONFIG_DIR?.trim() || join(home, ".claude");
  const thirdPartyDir = join(gatewayData, "Claude-3p");
  const legacyDir = join(appData, "Claude-3p");
  return {
    profiles: { claude: join(appData, "Claude"), thirdParty: thirdPartyDir },
    legacyProfiles: { thirdParty: platformName === "win32" && legacyDir.toLowerCase() !== thirdPartyDir.toLowerCase() ? [legacyDir] : [] },
    projectsDir: join(claudeConfigDir, "projects"),
    manifestDir: join(resolveDataDir(env), "logs", "desktop-session-sync"),
    selectedScopes: {
      ...(env.CODEX2CC_CLAUDE_SESSION_SCOPE === undefined ? {} : { claude: env.CODEX2CC_CLAUDE_SESSION_SCOPE }),
      ...(env.CODEX2CC_GATEWAY_SESSION_SCOPE === undefined ? {} : { thirdParty: env.CODEX2CC_GATEWAY_SESSION_SCOPE }),
    },
  };
}

export type DesktopProcessState = "running" | "not_running" | "unknown";

type ProcessProbe = (
  command: string,
  args: readonly string[],
  options: SpawnSyncOptionsWithStringEncoding,
) => { readonly status: number | null; readonly stdout?: string; readonly error?: Error };

// Desktop and the native CLI are both claude.exe. Only a positively identified CLI may be ignored.
const WINDOWS_PROCESS_QUERY = [
  "$ErrorActionPreference = 'Stop'",
  "$processes = @(Get-Process -ErrorAction Stop | Where-Object { $_.ProcessName -ieq 'claude' })",
  "$products = @($processes | ForEach-Object { $product = $null; try { $product = $_.MainModule.FileVersionInfo.ProductName } catch {}; [PSCustomObject]@{ productName = $product } })",
  "ConvertTo-Json -InputObject $products -Compress",
].join("; ");
const WindowsProcesses = z.array(z.object({ productName: z.string().nullable() }));

/** Checks Desktop without confusing the Windows CLI with the Electron app. Probe failures fail closed. */
export function desktopProcessState(platformName: string = platform(), probe: ProcessProbe = spawnSync): DesktopProcessState {
  if (platformName !== "darwin" && platformName !== "win32") return "unknown";
  const options: SpawnSyncOptionsWithStringEncoding = {
    encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], shell: false, windowsHide: true, timeout: 5_000,
  };
  try {
    const result = platformName === "win32"
      ? probe("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_PROCESS_QUERY], options)
      : probe("pgrep", ["-x", "Claude"], options);
    if (result.error) return "unknown";
    if (platformName === "darwin") {
      return result.status === 0 ? "running" : result.status === 1 ? "not_running" : "unknown";
    }
    if (result.status !== 0) return "unknown";
    const parsed = WindowsProcesses.safeParse(JSON.parse(result.stdout ?? ""));
    if (!parsed.success) return "unknown";
    const products = parsed.data.map(({ productName }) => productName?.trim().toLowerCase());
    if (products.includes("claude")) return "running";
    return products.every((name) => name === "claude code") ? "not_running" : "unknown";
  } catch {
    return "unknown";
  }
}

const SessionEntry = z.object({ sessionId: z.string().regex(/^local_[A-Za-z0-9-]+$/), cliSessionId: z.string().min(1) }).loose();

type ScopeListing = {
  readonly id: string;
  readonly profileDir: string;
  readonly dir: string;
  readonly sessions: ReadonlyArray<{ readonly file: string; readonly sessionId: string; readonly cliSessionId: string; readonly lastActivityAt: number }>;
  readonly tombstones: ReadonlySet<string>;
  readonly invalid: number;
};

function directories(path: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => join(path, entry.name));
}

/** Every `<account>/<org>` directory of a profile with its session entries and tombstones. */
function listScopes(profileDir: string): ScopeListing[] {
  const root = join(profileDir, "claude-code-sessions");
  return directories(root).flatMap(directories).map((dir): ScopeListing => {
    const sessions: Array<ScopeListing["sessions"][number]> = [];
    const tombstones = new Set<string>();
    let invalid = 0;
    for (const name of readdirSync(dir)) {
      if (name.startsWith("deleted_")) {
        tombstones.add(name.slice("deleted_".length));
        continue;
      }
      if (!/^local_.+\.json$/.test(name)) continue;
      const file = join(dir, name);
      let parsed: z.ZodSafeParseResult<z.infer<typeof SessionEntry>>;
      try {
        parsed = SessionEntry.safeParse(JSON.parse(readFileSync(file, "utf8")));
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        invalid++;
        continue;
      }
      if (!parsed.success || `${parsed.data.sessionId}.json` !== name) {
        invalid++;
        continue;
      }
      const activity = parsed.data.lastActivityAt;
      sessions.push({
        file,
        sessionId: parsed.data.sessionId,
        cliSessionId: parsed.data.cliSessionId,
        lastActivityAt: typeof activity === "number" ? activity : statSync(file).mtimeMs,
      });
    }
    return { id: relative(root, dir).split(sep).join("/"), profileDir, dir, sessions, tombstones, invalid };
  });
}

function listProfileScopes(paths: DesktopSessionPaths, profile: DesktopProfile): ScopeListing[] {
  const roots = [...new Set([paths.profiles[profile], ...(paths.legacyProfiles?.[profile] ?? [])])];
  const scopes = roots.flatMap(listScopes);
  const deletedByScope = new Map<string, Set<string>>();
  for (const scope of scopes) {
    const deleted = deletedByScope.get(scope.id) ?? new Set<string>();
    for (const sessionId of scope.tombstones) deleted.add(sessionId);
    deletedByScope.set(scope.id, deleted);
  }
  // A deletion in either location wins over an older entry in the other location.
  return scopes.map((scope) => {
    const tombstones = deletedByScope.get(scope.id)!;
    return { ...scope, tombstones, sessions: scope.sessions.filter((session) => !tombstones.has(session.sessionId.slice("local_".length))) };
  });
}

function transcriptIds(projectsDir: string): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const project of directories(projectsDir)) {
    for (const name of readdirSync(project)) {
      if (name.endsWith(".jsonl")) ids.add(name.slice(0, -".jsonl".length));
    }
  }
  return ids;
}

export type PlannedCopy = { readonly sessionId: string; readonly source: string; readonly destination: string };

export type DirectionPlan = {
  readonly from: DesktopProfile;
  readonly to: DesktopProfile;
  /** Set when nothing can be copied in this direction. */
  readonly blocked?: "no_source_sessions" | "no_destination_scope";
  /** The explicitly selected destination scope, or its sole existing scope. */
  readonly destinationScope?: string;
  readonly copies: readonly PlannedCopy[];
  /** Copies codex2cc made earlier whose original has newer activity; they are replaced by the original. */
  readonly refreshes: readonly PlannedCopy[];
  readonly skipped: {
    readonly alreadyPresent: number;
    readonly deletedInDestination: number;
    readonly missingTranscript: number;
    readonly invalid: number;
  };
};

export type SyncEntry = {
  readonly action: "added" | "refreshed";
  readonly sessionId: string;
  readonly source: string;
  readonly destination: string;
  /** Pre-refresh contents; absent for added entries and manifests written before backups existed. */
  readonly backupPath?: string;
};

const SyncManifest = z.object({
  createdAt: z.string(),
  entries: z.array(z.object({
    action: z.enum(["added", "refreshed"]),
    sessionId: z.string().min(1),
    source: z.string().min(1),
    destination: z.string().min(1),
    backupPath: z.string().min(1).optional(),
  })),
});

/**
 * Copies codex2cc made, keyed by destination path, read from every manifest it wrote. Only these may ever
 * be replaced: an entry Desktop created itself is never written to.
 */
function ownedCopies(manifestDir: string): ReadonlyMap<string, string> {
  const owned = new Map<string, string>();
  if (!existsSync(manifestDir)) return owned;
  for (const name of readdirSync(manifestDir).filter((file) => file.endsWith(".json")).sort()) {
    const file = join(manifestDir, name);
    let parsed: z.ZodSafeParseResult<z.infer<typeof SyncManifest>>;
    try {
      parsed = SyncManifest.safeParse(JSON.parse(readFileSync(file, "utf8")));
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw new BridgeError(500, "invalid_sync_manifest", `Desktop session sync manifest ${file} is not valid JSON; fix or remove it.`);
    }
    if (!parsed.success) {
      throw new BridgeError(500, "invalid_sync_manifest", `Desktop session sync manifest ${file} does not match the expected format; fix or remove it.`);
    }
    for (const entry of parsed.data.entries) owned.set(entry.destination, entry.source);
  }
  return owned;
}

const SCOPE_ENV: Readonly<Record<DesktopProfile, string>> = {
  claude: "CODEX2CC_CLAUDE_SESSION_SCOPE",
  thirdParty: "CODEX2CC_GATEWAY_SESSION_SCOPE",
};
const ScopeId = z.string().regex(/^[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/);

/** No timestamp can identify the signed-in account; require a selection when more than one exists. */
function selectScope(scopes: readonly ScopeListing[], paths: DesktopSessionPaths, profile: DesktopProfile): ScopeListing | undefined {
  const id = (scope: ScopeListing): string => scope.id;
  const selected = paths.selectedScopes?.[profile];
  if (selected !== undefined) {
    if (!ScopeId.safeParse(selected).success) {
      throw new BridgeError(400, "invalid_desktop_scope", `${SCOPE_ENV[profile]} must be an existing <account>/<org> scope, without path traversal.`);
    }
    const target = scopes.find((scope) => id(scope) === selected);
    if (target === undefined) {
      throw new BridgeError(400, "invalid_desktop_scope", `${SCOPE_ENV[profile]} names an unknown scope. Available scopes: ${scopes.map(id).join(", ") || "none"}.`);
    }
    return target;
  }
  if (scopes.length > 1) {
    throw new BridgeError(409, "ambiguous_desktop_scope", `Desktop session sync requires an explicit account/org. Set ${SCOPE_ENV[profile]} to one of: ${scopes.map(id).join(", ")}. Then rerun codex2cc --sync-desktop-sessions --dry-run.`);
  }
  return scopes[0];
}

function planRefreshes(
  sourceScopes: readonly ScopeListing[],
  destinationScopes: readonly ScopeListing[],
  owned: ReadonlyMap<string, string>,
): PlannedCopy[] {
  const sources = new Map(sourceScopes.flatMap((scope) => scope.sessions).map((session) => [session.file, session]));
  return destinationScopes.flatMap((scope) => scope.sessions).flatMap((copy): PlannedCopy[] => {
    const original = sources.get(owned.get(copy.file) ?? "");
    if (original === undefined || original.sessionId !== copy.sessionId || original.lastActivityAt <= copy.lastActivityAt) return [];
    return [{ sessionId: copy.sessionId, source: original.file, destination: copy.file }];
  });
}

function planDirection(
  direction: SyncDirection,
  paths: DesktopSessionPaths,
  transcripts: ReadonlySet<string>,
  owned: ReadonlyMap<string, string>,
): DirectionPlan {
  const allSourceScopes = listProfileScopes(paths, direction.from);
  const selected = paths.selectedScopes?.[direction.from];
  if (selected !== undefined) selectScope(allSourceScopes, paths, direction.from);
  const sourceScopes = selected === undefined ? allSourceScopes : allSourceScopes.filter((scope) => scope.id === selected);
  const allDestinationScopes = listProfileScopes(paths, direction.to);
  const primaryDestinationScopes = allDestinationScopes.filter((scope) => scope.profileDir === paths.profiles[direction.to]);
  const destinationScopes = primaryDestinationScopes.length > 0 ? primaryDestinationScopes : allDestinationScopes;
  const invalid = sourceScopes.reduce((sum, scope) => sum + scope.invalid, 0);
  const sources = sourceScopes.flatMap((scope) => scope.sessions);
  const empty = { alreadyPresent: 0, deletedInDestination: 0, missingTranscript: 0, invalid };
  if (sources.length === 0) return { ...direction, blocked: "no_source_sessions", copies: [], refreshes: [], skipped: empty };
  const target = selectScope(destinationScopes, paths, direction.to);
  if (target === undefined) return { ...direction, blocked: "no_destination_scope", copies: [], refreshes: [], skipped: empty };

  // A session in another account/org is not present in the selected destination.
  const presentSessions = new Set(target.sessions.map((session) => session.sessionId));
  const presentTranscripts = new Set(target.sessions.map((session) => session.cliSessionId));
  const deleted = target.tombstones;
  const skipped = { ...empty };
  const copies: PlannedCopy[] = [];
  for (const session of sources) {
    if (presentSessions.has(session.sessionId) || presentTranscripts.has(session.cliSessionId)) {
      skipped.alreadyPresent++;
    } else if (deleted.has(session.sessionId.slice("local_".length))) {
      skipped.deletedInDestination++;
    } else if (!transcripts.has(session.cliSessionId)) {
      skipped.missingTranscript++;
    } else {
      presentSessions.add(session.sessionId);
      presentTranscripts.add(session.cliSessionId);
      copies.push({ sessionId: session.sessionId, source: session.file, destination: join(target.dir, basename(session.file)) });
    }
  }
  return { ...direction, destinationScope: target.dir, copies, refreshes: planRefreshes(sourceScopes, [target], owned), skipped };
}

/** Read-only: which session entries each direction would add or refresh. */
export function planDesktopSessionSync(directions: readonly SyncDirection[], paths: DesktopSessionPaths): DirectionPlan[] {
  const transcripts = transcriptIds(paths.projectsDir);
  const owned = ownedCopies(paths.manifestDir);
  return directions.map((direction) => planDirection(direction, paths, transcripts, owned));
}

export type AppliedSync = { readonly plans: readonly DirectionPlan[]; readonly entries: readonly SyncEntry[]; readonly manifestPath: string | undefined };

/** A sync that stopped part-way; `entries` are the changes that did land. */
export class DesktopSyncError extends Error {
  constructor(message: string, readonly entries: readonly SyncEntry[], readonly manifestPath: string | undefined, options?: ErrorOptions) {
    super(message, options);
    this.name = "DesktopSyncError";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Saves a preimage and recovery receipt before replacing any metadata. */
function replaceCopy(copy: PlannedCopy, backupPath: string): void {
  mkdirSync(dirname(backupPath), { recursive: true, mode: 0o700 });
  copyFileSync(copy.destination, backupPath, constants.COPYFILE_EXCL);
  // Independent of the end-of-run manifest: a later manifest failure must not orphan the backup.
  writeFileSync(`${backupPath}.json`, JSON.stringify({ ...copy, backupPath }, null, 2), { flag: "wx", mode: 0o600 });
  const temporary = `${copy.destination}.codex2cc-${randomUUID()}.tmp`;
  copyFileSync(copy.source, temporary, constants.COPYFILE_EXCL);
  try {
    renameSync(temporary, copy.destination);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/**
 * Adds the planned entries without ever replacing a file (a destination that appeared since planning
 * fails the copy) and refreshes the planned codex2cc copies. Every change is recorded in a manifest, also
 * when the run stops part-way; a failure to write the manifest never hides the copy failure before it.
 */
export function applyDesktopSessionSync(plans: readonly DirectionPlan[], manifestDir: string, now: Date): AppliedSync {
  const runId = `${now.toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
  const manifestPath = join(manifestDir, `${runId}.json`);
  const planned = plans.flatMap((plan) => [
    ...plan.copies.map((copy) => ({ action: "added" as const, ...copy })),
    ...plan.refreshes.map((copy) => ({ action: "refreshed" as const, ...copy })),
  ]);
  const entries: SyncEntry[] = [];
  let copyFailure: unknown;
  for (const [index, entry] of planned.entries()) {
    const change: SyncEntry = entry.action === "refreshed"
      ? { ...entry, backupPath: join(manifestDir, "backups", runId, `${index}-${basename(entry.destination)}.bak`) }
      : entry;
    try {
      if (change.action === "added") copyFileSync(change.source, change.destination, constants.COPYFILE_EXCL);
      else replaceCopy(change, change.backupPath!);
    } catch (error) {
      copyFailure = error;
      break;
    }
    entries.push(change);
  }
  let manifestFailure: unknown;
  if (entries.length > 0) {
    try {
      mkdirSync(manifestDir, { recursive: true });
      writeFileSync(manifestPath, JSON.stringify({ createdAt: now.toISOString(), entries }, null, 2), { flag: "wx", mode: 0o600 });
    } catch (error) {
      manifestFailure = error;
    }
  }
  if (copyFailure === undefined && manifestFailure === undefined) {
    return { plans, entries, manifestPath: entries.length > 0 ? manifestPath : undefined };
  }
  const problems = [
    ...(copyFailure === undefined ? [] : [`stopped after ${entries.length} of ${planned.length} change(s): ${errorMessage(copyFailure)}`]),
    ...(manifestFailure === undefined ? [] : [`could not record the changes in ${manifestPath}: ${errorMessage(manifestFailure)}`]),
  ];
  throw new DesktopSyncError(
    `Desktop session sync ${problems.join("; ")}`,
    entries,
    manifestFailure === undefined && entries.length > 0 ? manifestPath : undefined,
    { cause: copyFailure ?? manifestFailure },
  );
}

export type DesktopSyncOutcome =
  | { readonly status: "applied"; readonly sync: AppliedSync }
  | { readonly status: "failed"; readonly error: string; readonly entries: readonly SyncEntry[]; readonly manifestPath: string | undefined }
  | { readonly status: "skipped"; readonly desktop: Exclude<DesktopProcessState, "not_running"> };

function isFileSystemError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && typeof error.code === "string" && "syscall" in error;
}

/**
 * Plans and applies a sync, reporting a failure as an outcome so that the setup or reset it follows still
 * counts as done. Only sync failures are converted (partial copies, file-system errors, a bad manifest);
 * anything else is a defect and propagates.
 */
export function runDesktopSessionSync(directions: readonly SyncDirection[], paths: DesktopSessionPaths, now: Date): DesktopSyncOutcome {
  try {
    return { status: "applied", sync: applyDesktopSessionSync(planDesktopSessionSync(directions, paths), paths.manifestDir, now) };
  } catch (error) {
    if (error instanceof DesktopSyncError) return { status: "failed", error: error.message, entries: error.entries, manifestPath: error.manifestPath };
    if (error instanceof BridgeError || isFileSystemError(error)) return { status: "failed", error: error.message, entries: [], manifestPath: undefined };
    throw error;
  }
}

/** Syncs only when Desktop is known to be closed: an open Desktop may rewrite its session list. */
export function syncDesktopSessionsWhenClosed(
  directions: readonly SyncDirection[],
  paths: DesktopSessionPaths,
  desktop: DesktopProcessState,
  now: Date,
): DesktopSyncOutcome {
  if (desktop !== "not_running") return { status: "skipped", desktop };
  return runDesktopSessionSync(directions, paths, now);
}

const PROFILE_LABEL: Readonly<Record<DesktopProfile, string>> = { claude: "Claude (claude.ai)", thirdParty: "Claude-3p (gateway)" };

export type PlanTense = { readonly add: string; readonly refresh: string };
export const DRY_RUN_TENSE: PlanTense = { add: "would copy", refresh: "would refresh" };
export const APPLIED_TENSE: PlanTense = { add: "copied", refresh: "refreshed" };

/** Human-readable lines for a plan, in the tense of a dry run or of an applied sync. */
export function describePlans(plans: readonly DirectionPlan[], tense: PlanTense): string[] {
  return plans.map((plan) => {
    const route = `${PROFILE_LABEL[plan.from]} -> ${PROFILE_LABEL[plan.to]}`;
    if (plan.blocked === "no_source_sessions") return `${route}: no sessions to copy.`;
    if (plan.blocked === "no_destination_scope") return `${route}: skipped, open Claude Desktop once in that mode so it creates its session list, then quit it and rerun: codex2cc --sync-desktop-sessions`;
    const { alreadyPresent, deletedInDestination, missingTranscript, invalid } = plan.skipped;
    return `${route}: ${tense.add} ${plan.copies.length} session(s), ${tense.refresh} ${plan.refreshes.length} earlier cop(ies); skipped ${alreadyPresent} already present, ${deletedInDestination} deleted there, ${missingTranscript} without transcript, ${invalid} unreadable.`;
  });
}

export function describeOutcome(outcome: DesktopSyncOutcome): string[] {
  if (outcome.status === "applied") {
    const lines = describePlans(outcome.sync.plans, APPLIED_TENSE);
    return outcome.sync.manifestPath === undefined ? lines : [...lines, `Changes are listed in ${outcome.sync.manifestPath}.`];
  }
  if (outcome.status === "failed") {
    const landed = outcome.entries.length === 0
      ? []
      : outcome.manifestPath !== undefined
        ? [`Changes made before the failure are listed in ${outcome.manifestPath}.`]
        : [`Changes made before the failure: ${outcome.entries.map((entry) => `${entry.action} ${entry.destination}${entry.backupPath === undefined ? "" : ` (backup: ${entry.backupPath})`}`).join(", ")}.`];
    return [outcome.error, ...landed];
  }
  const reason = outcome.desktop === "running" ? "Claude Desktop is running" : "could not confirm that Claude Desktop is closed";
  return [`Desktop session sync skipped: ${reason}. Quit Claude Desktop, then run: codex2cc --sync-desktop-sessions`];
}

export type DesktopSyncReport = {
  readonly status: DesktopSyncOutcome["status"];
  /** How prominently a client should surface it: a skipped or failed sync leaves history hidden. */
  readonly level: "success" | "warning" | "error";
  readonly messages: readonly string[];
};

/** The outcome in the shape the control panel shows after a setup or reset. */
export function desktopSyncReport(outcome: DesktopSyncOutcome): DesktopSyncReport {
  const incomplete = outcome.status === "applied" && outcome.sync.plans.some((plan) =>
    plan.blocked === "no_destination_scope" || plan.skipped.missingTranscript > 0 || plan.skipped.invalid > 0);
  const level = outcome.status === "failed" ? "error" : outcome.status === "skipped" || incomplete ? "warning" : "success";
  return { status: outcome.status, level, messages: describeOutcome(outcome) };
}

/** For the explicit command: refuses instead of skipping, since syncing was the whole request. */
export function requireDesktopClosed(desktop: DesktopProcessState): void {
  if (desktop === "running") throw new BridgeError(409, "desktop_running", "Quit Claude Desktop before syncing its session lists (preview with --dry-run).");
  if (desktop === "unknown") throw new BridgeError(409, "desktop_state_unknown", "Could not confirm that Claude Desktop is closed on this system, so its session lists were not changed (preview with --dry-run).");
}
