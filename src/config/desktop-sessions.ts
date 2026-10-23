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
/** "all": every account/org of both profiles, as pooled by the all-accounts sync. */
export type SyncSource = DesktopProfile | "all";

const PROFILES: readonly DesktopProfile[] = ["claude", "thirdParty"];

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
      // `-a`: BSD pgrep skips its own ancestors, and codex2cc often runs inside Desktop's Code tab.
      : probe("pgrep", ["-a", "-x", "Claude"], options);
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

type ScopeSession = { readonly file: string; readonly sessionId: string; readonly cliSessionId: string; readonly lastActivityAt: number };

type ScopeListing = {
  readonly id: string;
  readonly profileDir: string;
  readonly dir: string;
  readonly sessions: readonly ScopeSession[];
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
    const sessions: ScopeSession[] = [];
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
export type PlannedRemoval = { readonly sessionId: string; readonly destination: string };

export type DirectionPlan = {
  readonly from: SyncSource;
  readonly to: DesktopProfile;
  /** The `<account>/<org>` list a mirror sync copies; absent when sessions are pooled from every list. */
  readonly sourceScopeId?: string;
  /** Set when nothing can be copied in this direction. */
  readonly blocked?: "no_source_sessions" | "no_destination_scope";
  /** The destination `<account>/<org>` directory; each scope of the destination profile gets its own plan. */
  readonly destinationScope?: string;
  /** Its `<account>/<org>` id. */
  readonly destinationScopeId?: string;
  readonly copies: readonly PlannedCopy[];
  /** Entries already present whose newest version in a source has newer activity; they are replaced by it. */
  readonly refreshes: readonly PlannedCopy[];
  /** Entries a mirror sync removes because the newest list does not have them; each is backed up first. */
  readonly removals: readonly PlannedRemoval[];
  readonly skipped: {
    readonly alreadyPresent: number;
    readonly deletedInDestination: number;
    readonly missingTranscript: number;
    readonly invalid: number;
  };
};

export type SyncEntry =
  | {
    readonly action: "added" | "refreshed";
    readonly sessionId: string;
    readonly source: string;
    readonly destination: string;
    /** Pre-refresh contents; absent for added entries. */
    readonly backupPath?: string;
  }
  | { readonly action: "removed"; readonly sessionId: string; readonly destination: string; readonly backupPath: string };

const SCOPE_ENV: Readonly<Record<DesktopProfile, string>> = {
  claude: "CODEX2CC_CLAUDE_SESSION_SCOPE",
  thirdParty: "CODEX2CC_GATEWAY_SESSION_SCOPE",
};
const ScopeId = z.string().regex(/^[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/);

/**
 * The explicitly selected scope, or every scope: no file identifies the account Desktop will sign in
 * with next, so an unselected profile is synced as a whole rather than guessed.
 */
function selectScopes(scopes: readonly ScopeListing[], paths: DesktopSessionPaths, profile: DesktopProfile): readonly ScopeListing[] {
  const id = (scope: ScopeListing): string => scope.id;
  const selected = paths.selectedScopes?.[profile];
  if (selected === undefined) return scopes;
  if (!ScopeId.safeParse(selected).success) {
    throw new BridgeError(400, "invalid_desktop_scope", `${SCOPE_ENV[profile]} must be an existing <account>/<org> scope, without path traversal.`);
  }
  const target = scopes.find((scope) => id(scope) === selected);
  if (target === undefined) {
    throw new BridgeError(400, "invalid_desktop_scope", `${SCOPE_ENV[profile]} names an unknown scope. Available scopes: ${scopes.map(id).join(", ") || "none"}.`);
  }
  return [target];
}

/** One entry per session: the one with the latest activity, wherever it lives. */
function newestBySession(sessions: readonly ScopeSession[]): ScopeSession[] {
  const newest = new Map<string, ScopeSession>();
  for (const session of sessions) {
    const known = newest.get(session.sessionId);
    if (known === undefined || session.lastActivityAt > known.lastActivityAt) newest.set(session.sessionId, session);
  }
  return [...newest.values()];
}

/**
 * The entries of `target` that a source holds a newer version of, whichever profile last updated it.
 * Identical contents are skipped, so a file-time fallback cannot make two equal entries trade places.
 */
function planRefreshes(sources: readonly ScopeSession[], target: ScopeListing): PlannedCopy[] {
  const newest = new Map(sources.map((session) => [session.sessionId, session]));
  return target.sessions.flatMap((entry): PlannedCopy[] => {
    const source = newest.get(entry.sessionId);
    if (source === undefined || source.file === entry.file || source.lastActivityAt <= entry.lastActivityAt) return [];
    if (readFileSync(source.file).equals(readFileSync(entry.file))) return [];
    return [{ sessionId: entry.sessionId, source: source.file, destination: entry.file }];
  });
}

function planDirection(
  direction: SyncDirection,
  paths: DesktopSessionPaths,
  transcripts: ReadonlySet<string>,
): DirectionPlan[] {
  const allSourceScopes = listProfileScopes(paths, direction.from);
  // Validates the selection; filtering by id keeps the same scope's legacy profile location too.
  const selectedIds = new Set(selectScopes(allSourceScopes, paths, direction.from).map((scope) => scope.id));
  const sourceScopes = allSourceScopes.filter((scope) => selectedIds.has(scope.id));
  const allDestinationScopes = listProfileScopes(paths, direction.to);
  const primaryDestinationScopes = allDestinationScopes.filter((scope) => scope.profileDir === paths.profiles[direction.to]);
  const destinationScopes = primaryDestinationScopes.length > 0 ? primaryDestinationScopes : allDestinationScopes;
  const invalid = sourceScopes.reduce((sum, scope) => sum + scope.invalid, 0);
  const sources = newestBySession(sourceScopes.flatMap((scope) => scope.sessions));
  if (sources.length === 0) return [blockedPlan(direction, "no_source_sessions", invalid)];
  const targets = selectScopes(destinationScopes, paths, direction.to);
  if (targets.length === 0) return [blockedPlan(direction, "no_destination_scope", invalid)];
  // Unreadable source entries are counted on the first line only, so the lines add up to the total.
  return targets.map((target, index) => ({
    ...planIntoScope(target, sources, transcripts, index === 0 ? invalid : 0),
    ...direction,
    destinationScopeId: target.id,
    refreshes: planRefreshes(sources, target),
    removals: [],
  }));
}

function blockedPlan(route: { readonly from: SyncSource; readonly to: DesktopProfile }, blocked: NonNullable<DirectionPlan["blocked"]>, invalid: number): DirectionPlan {
  return { ...route, blocked, copies: [], refreshes: [], removals: [], skipped: { alreadyPresent: 0, deletedInDestination: 0, missingTranscript: 0, invalid } };
}

/** The sources missing from `target` that can be added: not deleted there and with a local transcript. */
function planIntoScope(
  target: ScopeListing,
  sources: readonly ScopeSession[],
  transcripts: ReadonlySet<string>,
  invalid: number,
): Pick<DirectionPlan, "destinationScope" | "copies" | "skipped"> {
  // A session in another account/org is not present in the selected destination.
  const presentSessions = new Set(target.sessions.map((session) => session.sessionId));
  const presentTranscripts = new Set(target.sessions.map((session) => session.cliSessionId));
  const deleted = target.tombstones;
  const skipped = { alreadyPresent: 0, deletedInDestination: 0, missingTranscript: 0, invalid };
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
  return { destinationScope: target.dir, copies, skipped };
}

/**
 * Read-only: which session entries each direction would add or refresh. A session present in both
 * profiles takes the version with the latest activity, so a two-way sync converges on the newest one.
 */
export function planDesktopSessionSync(directions: readonly SyncDirection[], paths: DesktopSessionPaths): DirectionPlan[] {
  const transcripts = transcriptIds(paths.projectsDir);
  return directions.flatMap((direction) => planDirection(direction, paths, transcripts));
}

/**
 * Read-only: one plan per account/org scope of both profiles, each receiving every session any other
 * scope has. The union of all session lists is the shared pool, so there is no separate store to keep
 * consistent; the newest entry of a session is its source. Scope selections (CODEX2CC_*_SESSION_SCOPE)
 * narrow only the profile-switch sync: this one is explicitly for every account.
 */
export function planAllAccountsSessionSync(paths: DesktopSessionPaths): DirectionPlan[] {
  const transcripts = transcriptIds(paths.projectsDir);
  const listings = PROFILES.map((profile) => ({ profile, scopes: listProfileScopes(paths, profile) }));
  const sources = newestBySession(listings.flatMap(({ scopes }) => scopes.flatMap((scope) => scope.sessions)));
  return listings.flatMap(({ profile, scopes }): DirectionPlan[] => {
    const route = { from: "all", to: profile } as const;
    // Each scope reports its own unreadable entries, so the lines add up to the total.
    const invalid = scopes.reduce((sum, scope) => sum + scope.invalid, 0);
    if (sources.length === 0) return [blockedPlan(route, "no_source_sessions", invalid)];
    // Previous locations stay sources; they receive copies only while the profile has nothing else.
    const primary = scopes.filter((scope) => scope.profileDir === paths.profiles[profile]);
    const targets = primary.length > 0 ? primary : scopes;
    if (targets.length === 0) return [blockedPlan(route, "no_destination_scope", invalid)];
    return targets.map((target) => ({
      ...route,
      ...planIntoScope(target, sources, transcripts, target.invalid),
      destinationScopeId: target.id,
      refreshes: planRefreshes(sources, target),
      removals: [],
    }));
  });
}

/** {@link planAllAccountsSessionSync} without refreshes: only sessions a list lacks are added, nothing is replaced. */
export function planAddMissingSessionSync(paths: DesktopSessionPaths): DirectionPlan[] {
  return planAllAccountsSessionSync(paths).map((plan) => ({ ...plan, refreshes: [] }));
}

/**
 * The list holding the most recent activity of any session. After a mirror every list shares that
 * activity, so a tie goes to the fuller list: one that could not take a tombstoned or transcript-less
 * session must never become the source and remove it everywhere else. Full ties keep the first listed.
 */
function newestScope(scopes: readonly ScopeListing[]): ScopeListing | undefined {
  let newest: { readonly scope: ScopeListing; readonly at: number } | undefined;
  for (const scope of scopes) {
    if (scope.sessions.length === 0) continue;
    const at = Math.max(...scope.sessions.map((session) => session.lastActivityAt));
    if (newest === undefined || at > newest.at || (at === newest.at && scope.sessions.length > newest.scope.sessions.length)) newest = { scope, at };
  }
  return newest?.scope;
}

/**
 * Read-only: every other account/org list becomes a copy of the most recently active one. Its entries are
 * added or overwrite theirs, even a newer version; entries it lacks are removed (sessions sharing a
 * transcript with one of its entries are kept). Tombstones still block re-adding a deleted session, and
 * transcripts in `~/.claude/projects` are never touched, so a removed entry only leaves Desktop's list.
 */
export function planMirrorNewestSessionSync(paths: DesktopSessionPaths): DirectionPlan[] {
  const transcripts = transcriptIds(paths.projectsDir);
  const listings = PROFILES.map((profile) => ({ profile, scopes: listProfileScopes(paths, profile) }));
  const source = newestScope(listings.flatMap(({ scopes }) => scopes));
  return listings.flatMap(({ profile, scopes }): DirectionPlan[] => {
    const invalid = scopes.reduce((sum, scope) => sum + scope.invalid, 0);
    if (source === undefined) return [blockedPlan({ from: "all", to: profile }, "no_source_sessions", invalid)];
    const from = listings.find((listing) => listing.scopes.includes(source))!.profile;
    const route = { from, to: profile, sourceScopeId: source.id } as const;
    const primary = scopes.filter((scope) => scope.profileDir === paths.profiles[profile]);
    const candidates = primary.length > 0 ? primary : scopes;
    if (candidates.length === 0) return [blockedPlan(route, "no_destination_scope", invalid)];
    const keptIds = new Set(source.sessions.map((session) => session.sessionId));
    const keptTranscripts = new Set(source.sessions.map((session) => session.cliSessionId));
    return candidates.filter((target) => target.dir !== source.dir).map((target) => ({
      ...route,
      ...planIntoScope(target, source.sessions, transcripts, target.invalid),
      destinationScopeId: target.id,
      refreshes: target.sessions.flatMap((entry): PlannedCopy[] => {
        const original = source.sessions.find((session) => session.sessionId === entry.sessionId);
        if (original === undefined || readFileSync(original.file).equals(readFileSync(entry.file))) return [];
        return [{ sessionId: entry.sessionId, source: original.file, destination: entry.file }];
      }),
      removals: target.sessions
        .filter((entry) => !keptIds.has(entry.sessionId) && !keptTranscripts.has(entry.cliSessionId))
        .map((entry) => ({ sessionId: entry.sessionId, destination: entry.file })),
    }));
  });
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

/** Saves the entry and a recovery receipt, then deletes it; a vanished entry fails loudly. */
function removeEntry(removal: PlannedRemoval, backupPath: string): void {
  mkdirSync(dirname(backupPath), { recursive: true, mode: 0o700 });
  copyFileSync(removal.destination, backupPath, constants.COPYFILE_EXCL);
  writeFileSync(`${backupPath}.json`, JSON.stringify({ ...removal, backupPath }, null, 2), { flag: "wx", mode: 0o600 });
  rmSync(removal.destination);
}

/**
 * Adds the planned entries without ever replacing a file (a destination that appeared since planning
 * fails the copy), then refreshes and removes the planned entries, backing each one up first. Every change
 * is recorded in a manifest, also when the run stops part-way; a failure to write the manifest never hides
 * the copy failure before it.
 */
export function applyDesktopSessionSync(plans: readonly DirectionPlan[], manifestDir: string, now: Date): AppliedSync {
  const runId = `${now.toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
  const manifestPath = join(manifestDir, `${runId}.json`);
  const planned = plans.flatMap((plan) => [
    ...plan.copies.map((copy) => ({ action: "added" as const, ...copy })),
    ...plan.refreshes.map((copy) => ({ action: "refreshed" as const, ...copy })),
    ...plan.removals.map((removal) => ({ action: "removed" as const, ...removal })),
  ]);
  const entries: SyncEntry[] = [];
  let copyFailure: unknown;
  for (const [index, entry] of planned.entries()) {
    const backupPath = join(manifestDir, "backups", runId, `${index}-${basename(entry.destination)}.bak`);
    const change: SyncEntry = entry.action === "added" ? entry : { ...entry, backupPath };
    try {
      if (entry.action === "added") copyFileSync(entry.source, entry.destination, constants.COPYFILE_EXCL);
      else if (entry.action === "refreshed") replaceCopy(entry, backupPath);
      else removeEntry(entry, backupPath);
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
  return runPlannedSync(() => planDesktopSessionSync(directions, paths), paths.manifestDir, now);
}

/** {@link runDesktopSessionSync} for {@link planAllAccountsSessionSync}. */
export function runAllAccountsSessionSync(paths: DesktopSessionPaths, now: Date): DesktopSyncOutcome {
  return runPlannedSync(() => planAllAccountsSessionSync(paths), paths.manifestDir, now);
}

function runPlannedSync(plan: () => readonly DirectionPlan[], manifestDir: string, now: Date): DesktopSyncOutcome {
  try {
    return { status: "applied", sync: applyDesktopSessionSync(plan(), manifestDir, now) };
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

/** {@link syncDesktopSessionsWhenClosed} for every account of both profiles. */
export function syncAllAccountsWhenClosed(paths: DesktopSessionPaths, desktop: DesktopProcessState, now: Date): DesktopSyncOutcome {
  if (desktop !== "not_running") return { status: "skipped", desktop };
  return runAllAccountsSessionSync(paths, now);
}

/** {@link syncDesktopSessionsWhenClosed} for any planner, such as the control panel's chosen sync mode. */
export function syncPlanWhenClosed(plan: () => readonly DirectionPlan[], manifestDir: string, desktop: DesktopProcessState, now: Date): DesktopSyncOutcome {
  if (desktop !== "not_running") return { status: "skipped", desktop };
  return runPlannedSync(plan, manifestDir, now);
}

const PROFILE_LABEL: Readonly<Record<SyncSource, string>> = { claude: "Claude (claude.ai)", thirdParty: "Claude-3p (gateway)", all: "All accounts" };

/** Account/org ids are UUID pairs; their first groups are enough to tell a person's scopes apart. */
function shortScopeId(id: string): string {
  return id.split("/").map((part) => part.split("-")[0]).join("/");
}

export type PlanTense = { readonly add: string; readonly refresh: string; readonly remove: string };
export const DRY_RUN_TENSE: PlanTense = { add: "would copy", refresh: "would refresh", remove: "would remove" };
export const APPLIED_TENSE: PlanTense = { add: "copied", refresh: "refreshed", remove: "removed" };

/** The list a mirror sync copies, e.g. `Claude-3p (gateway) [bddbea87/00000000]`; undefined for pooled plans. */
export function describeMirrorSource(plans: readonly DirectionPlan[]): string | undefined {
  const plan = plans.find((candidate) => candidate.sourceScopeId !== undefined);
  return plan === undefined ? undefined : `${PROFILE_LABEL[plan.from]} [${shortScopeId(plan.sourceScopeId!)}]`;
}

/** Human-readable lines for a plan, in the tense of a dry run or of an applied sync. */
export function describePlans(plans: readonly DirectionPlan[], tense: PlanTense): string[] {
  return plans.map((plan) => {
    const scope = plan.destinationScopeId === undefined ? "" : ` [${shortScopeId(plan.destinationScopeId)}]`;
    const source = plan.sourceScopeId === undefined ? "" : ` [${shortScopeId(plan.sourceScopeId)}]`;
    const route = `${PROFILE_LABEL[plan.from]}${source} -> ${PROFILE_LABEL[plan.to]}${scope}`;
    if (plan.blocked === "no_source_sessions") return `${route}: no sessions to copy.`;
    if (plan.blocked === "no_destination_scope") return `${route}: skipped, open Claude Desktop once in that mode so it creates its session list, then quit it and rerun: codex2cc --sync-desktop-sessions`;
    const { alreadyPresent, deletedInDestination, missingTranscript, invalid } = plan.skipped;
    const refreshed = plan.refreshes.length === 0 ? "" : `, ${tense.refresh} ${plan.refreshes.length} older session(s)`;
    const removed = plan.removals.length === 0 ? "" : `, ${tense.remove} ${plan.removals.length} session(s)`;
    const skipped = [
      [alreadyPresent, "already present"],
      [deletedInDestination, "deleted there"],
      [missingTranscript, "without transcript"],
      [invalid, "unreadable"],
    ] as const;
    const skippedParts = skipped.filter(([count]) => count > 0).map(([count, reason]) => `${count} ${reason}`);
    const skippedText = skippedParts.length === 0 ? "" : `; skipped ${skippedParts.join(", ")}`;
    return `${route}: ${tense.add} ${plan.copies.length} session(s)${refreshed}${removed}${skippedText}.`;
  });
}

/** One sentence for the whole plan set: how much moved, and what a person must still fix. */
export function summarizePlans(plans: readonly DirectionPlan[], tense: PlanTense): string {
  const copies = plans.reduce((sum, plan) => sum + plan.copies.length, 0);
  const refreshes = plans.reduce((sum, plan) => sum + plan.refreshes.length, 0);
  const removals = plans.reduce((sum, plan) => sum + plan.removals.length, 0);
  const accounts = plans.filter((plan) => plan.copies.length + plan.refreshes.length + plan.removals.length > 0).length;
  const verb = tense.add.charAt(0).toUpperCase() + tense.add.slice(1);
  const others = [
    ...(refreshes === 0 ? [] : [`${tense.refresh} ${refreshes}`]),
    ...(removals === 0 ? [] : [`${tense.remove} ${removals}`]),
  ];
  const tail = others.length === 0 ? "" : others.length === 1 ? ` and ${others[0]}` : `, ${others[0]} and ${others[1]}`;
  const moved = copies + refreshes + removals === 0
    ? "No sessions needed copying."
    : `${verb} ${copies} session(s)${tail} across ${accounts} account(s).`;
  const noScope = plans.filter((plan) => plan.blocked === "no_destination_scope").length;
  const unreadable = plans.reduce((sum, plan) => sum + plan.skipped.missingTranscript + plan.skipped.invalid, 0);
  const issues = [
    noScope === 0 ? "" : ` ${noScope} account(s) have no session list yet: open Claude Desktop once in that mode, quit it, and sync again.`,
    unreadable === 0 ? "" : ` ${unreadable} session(s) cannot be copied (missing or unreadable transcript).`,
  ];
  return moved + issues.join("");
}

/** How a person retries a skipped sync; the control panel's button supplies its own. */
export const CLI_RETRY_HINT = "run: codex2cc --sync-desktop-sessions";

export function describeOutcome(outcome: DesktopSyncOutcome, retryHint: string = CLI_RETRY_HINT): string[] {
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
  return [`Desktop session sync skipped: ${reason}. Quit Claude Desktop, then ${retryHint}`];
}

/** The main point of an outcome in one sentence; `describeOutcome` keeps the per-direction detail. */
export function summarizeOutcome(outcome: DesktopSyncOutcome, retryHint: string = CLI_RETRY_HINT): string {
  if (outcome.status === "applied") return summarizePlans(outcome.sync.plans, APPLIED_TENSE);
  if (outcome.status === "failed") {
    return outcome.entries.length === 0 ? outcome.error : `${outcome.error} Some sessions were already copied; see details.`;
  }
  const reason = outcome.desktop === "running" ? "Claude Desktop is running" : "Could not confirm that Claude Desktop is closed";
  return `${reason}. Quit it, then ${retryHint}`;
}

export type DesktopSyncReport = {
  readonly status: DesktopSyncOutcome["status"];
  /** How prominently a client should surface it: a skipped or failed sync leaves history hidden. */
  readonly level: "success" | "warning" | "error";
  /** What happened and what to do next, in one sentence. */
  readonly headline: string;
  /** Supporting lines a client may show on demand; they never repeat the headline. */
  readonly messages: readonly string[];
};

/** The outcome in the shape the control panel shows after a setup or reset. */
export function desktopSyncReport(outcome: DesktopSyncOutcome, retryHint?: string): DesktopSyncReport {
  const incomplete = outcome.status === "applied" && outcome.sync.plans.some((plan) =>
    plan.blocked === "no_destination_scope" || plan.skipped.missingTranscript > 0 || plan.skipped.invalid > 0);
  const level = outcome.status === "failed" ? "error" : outcome.status === "skipped" || incomplete ? "warning" : "success";
  // A failed or skipped outcome leads with the line the headline already carries.
  const lines = describeOutcome(outcome, retryHint);
  const messages = outcome.status === "applied" ? lines : lines.slice(1);
  return { status: outcome.status, level, headline: summarizeOutcome(outcome, retryHint), messages };
}

/** For the explicit command: refuses instead of skipping, since syncing was the whole request. */
export function requireDesktopClosed(desktop: DesktopProcessState): void {
  if (desktop === "running") throw new BridgeError(409, "desktop_running", "Quit Claude Desktop before syncing its session lists (preview with --dry-run).");
  if (desktop === "unknown") throw new BridgeError(409, "desktop_state_unknown", "Could not confirm that Claude Desktop is closed on this system, so its session lists were not changed (preview with --dry-run).");
}
