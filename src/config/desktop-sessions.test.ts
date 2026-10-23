import assert from "node:assert/strict";
import fs, { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import test, { type TestContext } from "node:test";
import { BridgeError } from "../bridge/bridge.js";
import {
  applyDesktopSessionSync,
  BOTH_PROFILES,
  describeOutcome,
  describePlans,
  DesktopSyncError,
  desktopProcessState,
  desktopSyncReport,
  DRY_RUN_TENSE,
  planAddMissingSessionSync,
  planAllAccountsSessionSync,
  planDesktopSessionSync,
  planMirrorNewestSessionSync,
  syncPlanWhenClosed,
  requireDesktopClosed,
  resolveDesktopSessionPaths,
  summarizePlans,
  runAllAccountsSessionSync,
  runDesktopSessionSync,
  syncAllAccountsWhenClosed,
  syncDesktopSessionsWhenClosed,
  TO_CLAUDE_PROFILE,
  TO_GATEWAY_PROFILE,
  type DesktopSessionPaths,
} from "./desktop-sessions.js";

const NOW = new Date("2026-10-23T10:00:00.000Z");

// chmod does not deny directory writes on Windows (or under root). Inject only manifest-write errors,
// preserving real copies, backups and receipts so recovery assertions still exercise the filesystem.
function failManifestWrites(t: TestContext, manifestDir: string): () => void {
  const write = fs.writeFileSync;
  const mocked = t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof fs.writeFileSync>) => {
    const file = args[0];
    if (typeof file === "string" && dirname(file) === manifestDir && file.endsWith(".json")) {
      throw Object.assign(new Error("EACCES: simulated manifest write failure"), { code: "EACCES", syscall: "open", path: file });
    }
    return write(...args);
  });
  syncBuiltinESMExports();
  const restore = () => { mocked.mock.restore(); syncBuiltinESMExports(); };
  t.after(restore);
  return restore;
}

test("Windows session sync uses the LocalAppData gateway profile and the Roaming Claude profile", () => {
  const paths = resolveDesktopSessionPaths({ APPDATA: "roaming", LOCALAPPDATA: "local" }, "win32");
  assert.deepEqual(paths.profiles, {
    claude: join("roaming", "Claude"),
    thirdParty: join("local", "Claude-3p"),
  });
});

test("macOS session sync reads both profiles from Application Support, with no previous gateway location", () => {
  const paths = resolveDesktopSessionPaths({ APPDATA: "ignored", LOCALAPPDATA: "ignored" }, "darwin");
  const support = join(homedir(), "Library", "Application Support");
  assert.deepEqual(paths.profiles, { claude: join(support, "Claude"), thirdParty: join(support, "Claude-3p") });
  assert.deepEqual(paths.legacyProfiles, { thirdParty: [] });
  assert.equal(paths.projectsDir, join(homedir(), ".claude", "projects"));
});

type Sandbox = { readonly paths: DesktopSessionPaths; readonly cleanup: () => void };

function createSandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "codex2cc-desktop-sessions-"));
  const paths: DesktopSessionPaths = {
    profiles: { claude: join(root, "Claude"), thirdParty: join(root, "Claude-3p") },
    projectsDir: join(root, ".claude", "projects"),
    manifestDir: join(root, "logs", "desktop-session-sync"),
  };
  return { paths, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function scopeDir(profileDir: string, account: string, org: string): string {
  const dir = join(profileDir, "claude-code-sessions", account, org);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeSession(dir: string, uuid: string, cliSessionId: string, lastActivityAt: number): string {
  const file = join(dir, `local_${uuid}.json`);
  writeFileSync(file, JSON.stringify({ sessionId: `local_${uuid}`, cliSessionId, cwd: "/work", title: `Session ${uuid}`, lastActivityAt }));
  return file;
}

function writeTranscript(paths: DesktopSessionPaths, cliSessionId: string): void {
  const project = join(paths.projectsDir, "-work");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, `${cliSessionId}.jsonl`), "{}\n");
}

function sessionFiles(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.startsWith("local_")).sort();
}

for (const localState of ["empty-directory", "empty-scope", "new-sessions"] as const) {
  test(`Windows migration includes legacy gateway history with ${localState} in LocalAppData`, () => {
    const { paths, cleanup } = createSandbox();
    const legacyDir = join(paths.profiles.thirdParty, "..", "Legacy-Claude-3p");
    const migratedPaths = { ...paths, legacyProfiles: { thirdParty: [legacyDir] } };
    try {
      const claude = scopeDir(paths.profiles.claude, "acct", "org");
      const legacy = scopeDir(legacyDir, "gw", "org");
      const original = writeSession(legacy, "old", "cli-old", 1_000);
      writeTranscript(paths, "cli-old");
      if (localState === "empty-directory") {
        mkdirSync(join(paths.profiles.thirdParty, "claude-code-sessions"), { recursive: true });
      } else {
        const local = scopeDir(paths.profiles.thirdParty, "gw", "org");
        if (localState === "new-sessions") {
          writeSession(local, "new", "cli-new", 2_000);
          writeTranscript(paths, "cli-new");
        }
      }
      const plans = planDesktopSessionSync(TO_CLAUDE_PROFILE, migratedPaths);
      const expected = localState === "new-sessions" ? ["local_new", "local_old"] : ["local_old"];
      assert.deepEqual(plans[0]!.copies.map((copy) => copy.sessionId).sort(), expected);
      applyDesktopSessionSync(plans, paths.manifestDir, NOW);
      assert.equal(readFileSync(join(claude, "local_old.json"), "utf8"), readFileSync(original, "utf8"));
    } finally {
      cleanup();
    }
  });
}

test("Windows session path discovery retains both stores even when the Local directory exists", () => {
  const root = mkdtempSync(join(tmpdir(), "codex2cc-session-paths-"));
  try {
    const local = join(root, "Local");
    const roaming = join(root, "Roaming");
    mkdirSync(join(local, "Claude-3p", "claude-code-sessions"), { recursive: true });
    mkdirSync(join(roaming, "Claude-3p", "claude-code-sessions"), { recursive: true });
    const paths = resolveDesktopSessionPaths({ APPDATA: roaming, LOCALAPPDATA: local }, "win32");
    assert.equal(paths.profiles.thirdParty, join(local, "Claude-3p"));
    assert.deepEqual(paths.legacyProfiles?.thirdParty, [join(roaming, "Claude-3p")]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a selected gateway source scope includes both stores without importing other accounts", () => {
  const { paths, cleanup } = createSandbox();
  const legacyDir = join(paths.profiles.thirdParty, "..", "Legacy-Claude-3p");
  try {
    scopeDir(paths.profiles.claude, "acct", "org");
    const local = scopeDir(paths.profiles.thirdParty, "gw", "org");
    const legacy = scopeDir(legacyDir, "gw", "org");
    const other = scopeDir(legacyDir, "other", "org");
    writeSession(local, "new", "cli-new", 2_000);
    writeSession(legacy, "old", "cli-old", 1_000);
    writeSession(other, "other", "cli-other", 3_000);
    for (const id of ["cli-new", "cli-old", "cli-other"]) writeTranscript(paths, id);
    const [plan] = planDesktopSessionSync(TO_CLAUDE_PROFILE, { ...paths, legacyProfiles: { thirdParty: [legacyDir] }, selectedScopes: { thirdParty: "gw/org" } });
    assert.deepEqual(plan!.copies.map((copy) => copy.sessionId).sort(), ["local_new", "local_old"]);
  } finally {
    cleanup();
  }
});

test("migration honors tombstones in either store and writes to the primary gateway scope", () => {
  const { paths, cleanup } = createSandbox();
  const legacyDir = join(paths.profiles.thirdParty, "..", "Legacy-Claude-3p");
  try {
    const claude = scopeDir(paths.profiles.claude, "acct", "org");
    const local = scopeDir(paths.profiles.thirdParty, "gw", "org");
    const legacy = scopeDir(legacyDir, "gw", "org");
    writeSession(claude, "deleted-in-legacy", "cli-deleted", 1_000);
    writeSession(claude, "keep", "cli-keep", 2_000);
    writeSession(legacy, "deleted-in-local", "cli-old", 1_000);
    writeFileSync(join(local, "deleted_deleted-in-local"), "3000");
    writeFileSync(join(legacy, "deleted_deleted-in-legacy"), "3000");
    for (const id of ["cli-deleted", "cli-keep", "cli-old"]) writeTranscript(paths, id);
    const plans = planDesktopSessionSync(BOTH_PROFILES, { ...paths, legacyProfiles: { thirdParty: [legacyDir] } });
    assert.equal(plans[0]!.destinationScope, local);
    assert.deepEqual(plans[0]!.copies.map((copy) => copy.sessionId), ["local_keep"]);
    assert.equal(plans[0]!.skipped.deletedInDestination, 1);
    assert.deepEqual(plans[1]!.copies, [], "a Local tombstone must suppress the old Roaming source");
    applyDesktopSessionSync(plans, paths.manifestDir, NOW);
    assert.equal(existsSync(join(local, "local_keep.json")), true);
    assert.equal(existsSync(join(legacy, "local_keep.json")), false);
  } finally {
    cleanup();
  }
});

test("session sync can still target a legacy-only gateway scope", () => {
  const { paths, cleanup } = createSandbox();
  const legacyDir = join(paths.profiles.thirdParty, "..", "Legacy-Claude-3p");
  try {
    const claude = scopeDir(paths.profiles.claude, "acct", "org");
    const legacy = scopeDir(legacyDir, "gw", "org");
    writeSession(claude, "keep", "cli-keep", 1_000);
    writeTranscript(paths, "cli-keep");
    mkdirSync(join(paths.profiles.thirdParty, "claude-code-sessions"), { recursive: true });
    const [plan] = planDesktopSessionSync(TO_GATEWAY_PROFILE, { ...paths, legacyProfiles: { thirdParty: [legacyDir] } });
    assert.equal(plan!.destinationScope, legacy);
  } finally {
    cleanup();
  }
});

test("plan copies only missing sessions with a transcript into every destination scope, or only the selected one", () => {
  const { paths, cleanup } = createSandbox();
  try {
    const claudeA = scopeDir(paths.profiles.claude, "acct-a", "org-1");
    const claudeB = scopeDir(paths.profiles.claude, "acct-b", "org-2");
    writeSession(claudeA, "aaaa-1", "cli-1", 1_000);
    writeSession(claudeA, "aaaa-2", "cli-2", 2_000);
    writeSession(claudeB, "bbbb-3", "cli-3", 3_000);
    writeSession(claudeB, "bbbb-4", "cli-4", 4_000);
    writeSession(claudeB, "bbbb-5", "cli-missing", 5_000);
    writeSession(claudeB, "bbbb-6", "cli-shared", 6_000);
    writeFileSync(join(claudeB, "local_broken.json"), "{not json");
    writeFileSync(join(claudeB, "scheduled-tasks.json"), "[]");

    const oldScope = scopeDir(paths.profiles.thirdParty, "gw", "org-old");
    const activeScope = scopeDir(paths.profiles.thirdParty, "gw", "org-new");
    writeSession(oldScope, "3333-1", "cli-old", 10);
    writeSession(activeScope, "aaaa-2", "cli-2", 50_000);
    writeSession(activeScope, "9999-9", "cli-shared", 40_000);
    writeFileSync(join(activeScope, "deleted_bbbb-3"), "1791955599380");
    for (const id of ["cli-1", "cli-2", "cli-3", "cli-4", "cli-shared"]) writeTranscript(paths, id);

    const unselected = planDesktopSessionSync(TO_GATEWAY_PROFILE, paths);
    assert.deepEqual(unselected.map((plan) => plan.destinationScopeId).sort(), ["gw/org-new", "gw/org-old"], "two destination scopes each get a plan, none is guessed");
    const intoOld = unselected.find((plan) => plan.destinationScopeId === "gw/org-old")!;
    const intoNew = unselected.find((plan) => plan.destinationScopeId === "gw/org-new")!;
    assert.deepEqual(intoOld.copies.map((copy) => copy.sessionId).sort(), ["local_aaaa-1", "local_aaaa-2", "local_bbbb-3", "local_bbbb-4", "local_bbbb-6"]);
    assert.ok(intoOld.copies.every((copy) => copy.destination.startsWith(oldScope)));
    assert.deepEqual(intoNew.copies.map((copy) => copy.sessionId).sort(), ["local_aaaa-1", "local_bbbb-4"]);
    assert.equal(unselected.reduce((sum, plan) => sum + plan.skipped.invalid, 0), 1, "an unreadable source entry is counted once");

    const [plan, ...others] = planDesktopSessionSync(TO_GATEWAY_PROFILE, { ...paths, selectedScopes: { thirdParty: "gw/org-new" } });
    assert.deepEqual(others, []);
    assert.ok(plan);
    assert.equal(plan.destinationScope, activeScope);
    assert.deepEqual(plan.copies.map((copy) => copy.sessionId).sort(), ["local_aaaa-1", "local_bbbb-4"]);
    assert.ok(plan.copies.every((copy) => copy.destination.startsWith(activeScope)));
    assert.deepEqual(plan.skipped, { alreadyPresent: 2, deletedInDestination: 1, missingTranscript: 1, invalid: 1 });
    assert.deepEqual(sessionFiles(activeScope), ["local_9999-9.json", "local_aaaa-2.json"], "planning writes nothing");
  } finally {
    cleanup();
  }
});

test("apply copies entries byte for byte, records a manifest, and a second two-way run adds nothing", () => {
  const { paths, cleanup } = createSandbox();
  try {
    const claude = scopeDir(paths.profiles.claude, "acct", "org");
    const gateway = scopeDir(paths.profiles.thirdParty, "gw", "org-gw");
    const original = writeSession(claude, "c1", "cli-c1", 1_000);
    writeSession(gateway, "g1", "cli-g1", 2_000);
    writeTranscript(paths, "cli-c1");
    writeTranscript(paths, "cli-g1");

    const applied = applyDesktopSessionSync(planDesktopSessionSync(BOTH_PROFILES, paths), paths.manifestDir, NOW);
    assert.deepEqual(applied.entries.map((entry) => entry.destination).sort(), [join(claude, "local_g1.json"), join(gateway, "local_c1.json")].sort());
    assert.ok(applied.entries.every((entry) => entry.action === "added"));
    assert.equal(readFileSync(join(gateway, "local_c1.json"), "utf8"), readFileSync(original, "utf8"));
    assert.ok(applied.manifestPath);
    const manifest = JSON.parse(readFileSync(applied.manifestPath, "utf8")) as { createdAt: string; entries: unknown[] };
    assert.equal(manifest.createdAt, NOW.toISOString());
    assert.deepEqual(manifest.entries, applied.entries);

    const again = applyDesktopSessionSync(planDesktopSessionSync(BOTH_PROFILES, paths), paths.manifestDir, new Date(NOW.getTime() + 1_000));
    assert.deepEqual(again.entries, []);
    assert.equal(again.manifestPath, undefined);
    assert.deepEqual(again.plans.map((plan) => plan.skipped.alreadyPresent), [2, 2]);
  } finally {
    cleanup();
  }
});

test("apply never replaces a destination that appeared after planning and still records what it added", () => {
  const { paths, cleanup } = createSandbox();
  try {
    const claude = scopeDir(paths.profiles.claude, "acct", "org");
    const gateway = scopeDir(paths.profiles.thirdParty, "gw", "org-gw");
    writeSession(claude, "c1", "cli-c1", 1_000);
    writeSession(claude, "c2", "cli-c2", 2_000);
    writeSession(gateway, "g1", "cli-g1", 3_000);
    for (const id of ["cli-c1", "cli-c2", "cli-g1"]) writeTranscript(paths, id);

    const plans = planDesktopSessionSync(TO_GATEWAY_PROFILE, paths);
    const [first, second] = plans[0]!.copies;
    assert.ok(first && second);
    writeFileSync(second.destination, "written by Desktop meanwhile");

    assert.throws(() => applyDesktopSessionSync(plans, paths.manifestDir, NOW), (error: unknown) =>
      error instanceof DesktopSyncError
      && /stopped after 1 of 2 change\(s\)/.test(error.message)
      && (error.cause as NodeJS.ErrnoException).code === "EEXIST"
      && error.entries.map((entry) => entry.destination).join() === first.destination
      && error.manifestPath !== undefined);
    assert.equal(readFileSync(second.destination, "utf8"), "written by Desktop meanwhile");
    const [manifestName] = readdirSync(paths.manifestDir);
    assert.ok(manifestName);
    assert.deepEqual((JSON.parse(readFileSync(join(paths.manifestDir, manifestName), "utf8")) as { entries: Array<{ destination: string }> }).entries.map((entry) => entry.destination), [first.destination]);
  } finally {
    cleanup();
  }
});

test("sync is skipped without touching files unless Desktop is known to be closed", () => {
  const { paths, cleanup } = createSandbox();
  try {
    const claude = scopeDir(paths.profiles.claude, "acct", "org");
    const gateway = scopeDir(paths.profiles.thirdParty, "gw", "org-gw");
    writeSession(claude, "c1", "cli-c1", 1_000);
    writeSession(gateway, "g1", "cli-g1", 2_000);
    writeTranscript(paths, "cli-c1");

    for (const desktop of ["running", "unknown"] as const) {
      const outcome = syncDesktopSessionsWhenClosed(TO_GATEWAY_PROFILE, paths, desktop, NOW);
      assert.deepEqual(outcome, { status: "skipped", desktop });
      assert.match(describeOutcome(outcome)[0] ?? "", /codex2cc --sync-desktop-sessions/);
      assert.deepEqual(sessionFiles(gateway), ["local_g1.json"]);
      assert.equal(existsSync(paths.manifestDir), false);
    }

    const applied = syncDesktopSessionsWhenClosed(TO_GATEWAY_PROFILE, paths, "not_running", NOW);
    assert.equal(applied.status, "applied");
    assert.deepEqual(sessionFiles(gateway), ["local_c1.json", "local_g1.json"]);
  } finally {
    cleanup();
  }
});

test("a direction without sessions or without a destination session list is reported, not guessed", () => {
  const { paths, cleanup } = createSandbox();
  try {
    writeSession(scopeDir(paths.profiles.claude, "acct", "org"), "c1", "cli-c1", 1_000);
    writeTranscript(paths, "cli-c1");
    const plans = planDesktopSessionSync(BOTH_PROFILES, paths);
    assert.deepEqual(plans.map((plan) => plan.blocked), ["no_destination_scope", "no_source_sessions"]);
    assert.deepEqual(plans.map((plan) => plan.copies.length), [0, 0]);
    const lines = describePlans(plans, DRY_RUN_TENSE);
    assert.match(lines[0] ?? "", /open Claude Desktop once in that mode/);
    assert.match(lines[1] ?? "", /no sessions to copy/);
  } finally {
    cleanup();
  }
});

test("the selected account/org wins over a more recently active one, and only its own sessions count as present", () => {
  const { paths, cleanup } = createSandbox();
  try {
    const claude = scopeDir(paths.profiles.claude, "acct", "org");
    writeSession(claude, "c1", "cli-c1", 1_000);
    writeSession(claude, "c2", "cli-c2", 1_000);
    for (const id of ["cli-c1", "cli-c2"]) writeTranscript(paths, id);
    // The older account holds recent activity and already lists c1; the signed-in account is new and empty.
    const previous = scopeDir(paths.profiles.thirdParty, "old-acct", "org");
    const signedIn = scopeDir(paths.profiles.thirdParty, "new-acct", "org");
    writeSession(previous, "c1", "cli-c1", 99_000);

    const [plan] = planDesktopSessionSync(TO_GATEWAY_PROFILE, { ...paths, selectedScopes: { thirdParty: "new-acct/org" } });
    assert.equal(plan?.destinationScope, signedIn);
    assert.deepEqual(plan?.copies.map((copy) => copy.sessionId).sort(), ["local_c1", "local_c2"]);
    assert.ok(plan?.copies.every((copy) => copy.destination.startsWith(signedIn)));
  } finally {
    cleanup();
  }
});

test("a scope selection must name an existing account/org and cannot escape the session directory", () => {
  const { paths, cleanup } = createSandbox();
  try {
    writeSession(scopeDir(paths.profiles.claude, "acct", "org"), "c1", "cli-c1", 1_000);
    writeTranscript(paths, "cli-c1");
    scopeDir(paths.profiles.thirdParty, "gw", "org");
    for (const selected of ["../../etc", "gw", "gw/org/extra", ""]) {
      assert.throws(
        () => planDesktopSessionSync(TO_GATEWAY_PROFILE, { ...paths, selectedScopes: { thirdParty: selected } }),
        (error: unknown) => error instanceof BridgeError && error.code === "invalid_desktop_scope",
        selected,
      );
    }
    assert.throws(
      () => planDesktopSessionSync(TO_GATEWAY_PROFILE, { ...paths, selectedScopes: { thirdParty: "gw/missing" } }),
      (error: unknown) => error instanceof BridgeError && error.code === "invalid_desktop_scope" && /Available scopes: gw\/org/.test(error.message),
    );
    assert.equal(planDesktopSessionSync(TO_GATEWAY_PROFILE, paths)[0]?.copies.length, 1, "a single scope needs no selection");
  } finally {
    cleanup();
  }
});

test("reset copies gateway sessions into every claude.ai account/org when no scope is selected", () => {
  const { paths, cleanup } = createSandbox();
  try {
    writeSession(scopeDir(paths.profiles.thirdParty, "gw", "org"), "g1", "cli-g1", 1_000);
    writeTranscript(paths, "cli-g1");
    const accountA = scopeDir(paths.profiles.claude, "acct-a", "org-1");
    const accountB = scopeDir(paths.profiles.claude, "acct-b", "org-1");
    const accountBOther = scopeDir(paths.profiles.claude, "acct-b", "org-2");
    writeSession(accountB, "g1", "cli-g1", 500);

    const outcome = syncDesktopSessionsWhenClosed(TO_CLAUDE_PROFILE, paths, "not_running", NOW);
    assert.equal(outcome.status, "applied");
    assert.deepEqual(sessionFiles(accountA), ["local_g1.json"]);
    assert.deepEqual(sessionFiles(accountBOther), ["local_g1.json"]);
    assert.deepEqual(sessionFiles(accountB), ["local_g1.json"], "an entry Desktop already has is left alone");
    assert.equal(desktopSyncReport(outcome).level, "success");
    const routes = describeOutcome(outcome).filter((line) => line.startsWith("Claude-3p (gateway) -> Claude (claude.ai) ["));
    assert.equal(routes.length, 3, "each account/org gets its own labelled line");
  } finally {
    cleanup();
  }
});

test("desktopSyncReport tells clients when history was left hidden", () => {
  assert.deepEqual(desktopSyncReport({ status: "skipped", desktop: "running" }).level, "warning");
  assert.deepEqual(desktopSyncReport({ status: "failed", error: "boom", entries: [], manifestPath: undefined }), { status: "failed", level: "error", headline: "boom", messages: [] });
  const applied = desktopSyncReport({ status: "applied", sync: { plans: [], entries: [], manifestPath: undefined } });
  assert.deepEqual(applied, { status: "applied", level: "success", headline: "No sessions needed copying.", messages: [] });
});

test("unsupported platforms stay unknown and the explicit command refuses unless Desktop is closed", () => {
  assert.equal(desktopProcessState("linux", () => { throw new Error("must not probe"); }), "unknown");
  assert.throws(() => requireDesktopClosed("running"), (error: unknown) => error instanceof BridgeError && error.code === "desktop_running");
  assert.throws(() => requireDesktopClosed("unknown"), (error: unknown) => error instanceof BridgeError && error.code === "desktop_state_unknown");
  assert.doesNotThrow(() => requireDesktopClosed("not_running"));
});

function setActivity(file: string, lastActivityAt: number, title: string): void {
  const data = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  writeFileSync(file, JSON.stringify({ ...data, lastActivityAt, title }));
}

test("a session present in both profiles takes the version from the profile that updated it last", () => {
  const { paths, cleanup } = createSandbox();
  try {
    const claude = scopeDir(paths.profiles.claude, "acct", "org");
    const gateway = scopeDir(paths.profiles.thirdParty, "gw", "org-gw");
    const continuedInClaude = writeSession(claude, "c1", "cli-c1", 1_000);
    const continuedInGateway = writeSession(claude, "c2", "cli-c2", 1_000);
    const deletedInGateway = writeSession(claude, "c3", "cli-c3", 1_000);
    writeSession(gateway, "g1", "cli-g1", 500);
    for (const id of ["cli-c1", "cli-c2", "cli-c3", "cli-g1"]) writeTranscript(paths, id);
    applyDesktopSessionSync(planDesktopSessionSync(TO_GATEWAY_PROFILE, paths), paths.manifestDir, NOW);

    // An entry Desktop created in both profiles is refreshed too: the newest version wins, not the oldest file.
    const newestClaudeEntry = writeSession(claude, "c4", "cli-c4", 9_000);
    writeTranscript(paths, "cli-c4");
    writeSession(gateway, "c4", "cli-c4", 100);
    // Equal contents never trade places, even when only file times tell them apart.
    for (const [dir, seconds] of [[claude, 1_000], [gateway, 2_000]] as const) {
      const file = join(dir, "local_c5.json");
      writeFileSync(file, JSON.stringify({ sessionId: "local_c5", cliSessionId: "cli-c5" }));
      utimesSync(file, seconds, seconds);
    }
    writeTranscript(paths, "cli-c5");

    setActivity(continuedInClaude, 5_000, "continued in claude.ai");
    setActivity(join(gateway, "local_c2.json"), 6_000, "continued through the gateway");
    setActivity(continuedInGateway, 4_000, "older claude.ai activity");
    rmSync(join(gateway, "local_c3.json"));
    writeFileSync(join(gateway, "deleted_c3"), "1");
    setActivity(deletedInGateway, 7_000, "newer but deleted in the gateway profile");

    const [toGateway, toClaude, ...others] = planDesktopSessionSync(BOTH_PROFILES, paths);
    assert.deepEqual(others, []);
    assert.deepEqual([...(toGateway?.refreshes ?? [])].sort((a, b) => a.sessionId.localeCompare(b.sessionId)), [
      { sessionId: "local_c1", source: continuedInClaude, destination: join(gateway, "local_c1.json") },
      { sessionId: "local_c4", source: newestClaudeEntry, destination: join(gateway, "local_c4.json") },
    ]);
    assert.deepEqual(toClaude?.refreshes, [{ sessionId: "local_c2", source: join(gateway, "local_c2.json"), destination: continuedInGateway }]);
    assert.deepEqual(toGateway?.copies, []);
    assert.deepEqual(toClaude?.copies.map((copy) => copy.sessionId), ["local_g1"]);
    assert.match(describePlans([toGateway!], DRY_RUN_TENSE)[0] ?? "", /would refresh 2 older session\(s\)/);

    const beforeRefresh = readFileSync(join(gateway, "local_c1.json"), "utf8");
    const olderC2 = readFileSync(continuedInGateway, "utf8");
    const applied = applyDesktopSessionSync([toGateway!, toClaude!], paths.manifestDir, new Date(NOW.getTime() + 1_000));
    assert.deepEqual(applied.entries.map((entry) => entry.action).sort(), ["added", "refreshed", "refreshed", "refreshed"]);
    const refreshed = applied.entries.find((entry) => entry.sessionId === "local_c1");
    const refreshedC2 = applied.entries.find((entry) => entry.sessionId === "local_c2");
    assert.ok(applied.entries.every((entry) => (entry.action === "refreshed") === (entry.backupPath !== undefined)), "every refresh records a backup of what it replaced");
    assert.equal(readFileSync(refreshed!.backupPath!, "utf8"), beforeRefresh);
    assert.equal(readFileSync(refreshedC2!.backupPath!, "utf8"), olderC2);
    assert.equal((JSON.parse(readFileSync(`${refreshed!.backupPath!}.json`, "utf8")) as { destination: string }).destination, join(gateway, "local_c1.json"));
    const manifest = JSON.parse(readFileSync(applied.manifestPath!, "utf8")) as { entries: Array<{ backupPath?: string }> };
    assert.deepEqual(manifest.entries.map((entry) => entry.backupPath), applied.entries.map((entry) => entry.backupPath));
    assert.equal(readFileSync(join(gateway, "local_c1.json"), "utf8"), readFileSync(continuedInClaude, "utf8"));
    assert.equal(readFileSync(continuedInGateway, "utf8"), readFileSync(join(gateway, "local_c2.json"), "utf8"));
    assert.match(readFileSync(continuedInGateway, "utf8"), /continued through the gateway/);
    assert.equal(readFileSync(join(gateway, "local_c4.json"), "utf8"), readFileSync(newestClaudeEntry, "utf8"));
    assert.equal(existsSync(join(gateway, "local_c3.json")), false);
    assert.ok([...readdirSync(gateway), ...readdirSync(claude)].every((name) => !name.endsWith(".tmp")), "no temporary file left behind");

    const again = planDesktopSessionSync(BOTH_PROFILES, paths);
    assert.deepEqual(again.flatMap((plan) => plan.refreshes), [], "both profiles hold the newest version until one changes again");
  } finally {
    cleanup();
  }
});

test("when several source accounts hold a session, the most recently active one is copied", () => {
  const { paths, cleanup } = createSandbox();
  try {
    const older = scopeDir(paths.profiles.claude, "acct-a", "org-1");
    const newer = scopeDir(paths.profiles.claude, "acct-b", "org-1");
    const gateway = scopeDir(paths.profiles.thirdParty, "gw", "org-gw");
    writeSession(older, "s1", "cli-s1", 1_000);
    const newest = writeSession(newer, "s1", "cli-s1", 2_000);
    writeTranscript(paths, "cli-s1");
    const [plan] = planDesktopSessionSync(TO_GATEWAY_PROFILE, paths);
    assert.deepEqual(plan?.copies, [{ sessionId: "local_s1", source: newest, destination: join(gateway, "local_s1.json") }]);
  } finally {
    cleanup();
  }
});

test("a manifest write failure is reported together with the copy failure it follows, never instead of it", (t) => {
  const { paths, cleanup } = createSandbox();
  try {
    const claude = scopeDir(paths.profiles.claude, "acct", "org");
    const gateway = scopeDir(paths.profiles.thirdParty, "gw", "org-gw");
    writeSession(claude, "c1", "cli-c1", 1_000);
    writeSession(claude, "c2", "cli-c2", 2_000);
    writeSession(gateway, "g1", "cli-g1", 3_000);
    for (const id of ["cli-c1", "cli-c2", "cli-g1"]) writeTranscript(paths, id);
    mkdirSync(paths.manifestDir, { recursive: true });
    failManifestWrites(t, paths.manifestDir);

    const plans = planDesktopSessionSync(TO_GATEWAY_PROFILE, paths);
    writeFileSync(plans[0]!.copies[1]!.destination, "written by Desktop meanwhile");
    assert.throws(() => applyDesktopSessionSync(plans, paths.manifestDir, NOW), (error: unknown) =>
      error instanceof DesktopSyncError
      && /stopped after 1 of 2 change\(s\): .*EEXIST/.test(error.message)
      && /could not record the changes/.test(error.message)
      && (error.cause as NodeJS.ErrnoException).code === "EEXIST"
      && error.entries.length === 1
      && error.manifestPath === undefined);
  } finally {
    cleanup();
  }
});

test("runDesktopSessionSync turns sync failures into an outcome that lists what already changed", (t) => {
  const { paths, cleanup } = createSandbox();
  try {
    const claude = scopeDir(paths.profiles.claude, "acct", "org");
    const gateway = scopeDir(paths.profiles.thirdParty, "gw", "org-gw");
    writeSession(claude, "c1", "cli-c1", 1_000);
    writeSession(gateway, "g1", "cli-g1", 3_000);
    writeTranscript(paths, "cli-c1");
    mkdirSync(paths.manifestDir, { recursive: true });
    const restoreWrites = failManifestWrites(t, paths.manifestDir);

    const outcome = syncDesktopSessionsWhenClosed(TO_GATEWAY_PROFILE, paths, "not_running", NOW);
    assert.equal(outcome.status, "failed");
    const lines = describeOutcome(outcome);
    assert.match(lines[0] ?? "", /could not record the changes/);
    assert.match(lines[1] ?? "", new RegExp(`added ${join(gateway, "local_c1.json").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));

    restoreWrites();
    const badScope = runDesktopSessionSync(TO_GATEWAY_PROFILE, { ...paths, selectedScopes: { thirdParty: "gw/missing" } }, NOW);
    assert.deepEqual(badScope.status, "failed");
    assert.match(describeOutcome(badScope)[0] ?? "", /CODEX2CC_GATEWAY_SESSION_SCOPE names an unknown scope/);
  } finally {
    cleanup();
  }
});

test("a refresh whose manifest cannot be written still leaves its backup and receipt behind", (t) => {
  const { paths, cleanup } = createSandbox();
  try {
    const claude = scopeDir(paths.profiles.claude, "acct", "org");
    const gateway = scopeDir(paths.profiles.thirdParty, "gw", "org-gw");
    const original = writeSession(claude, "c1", "cli-c1", 1_000);
    writeSession(gateway, "g1", "cli-g1", 500);
    for (const id of ["cli-c1", "cli-g1"]) writeTranscript(paths, id);
    applyDesktopSessionSync(planDesktopSessionSync(TO_GATEWAY_PROFILE, paths), paths.manifestDir, NOW);
    setActivity(join(gateway, "local_c1.json"), 2_000, "state only the copy has");
    setActivity(original, 3_000, "newer original");
    const plans = planDesktopSessionSync(TO_GATEWAY_PROFILE, paths);
    // Backups may still be created, but the run's manifest cannot be.
    mkdirSync(join(paths.manifestDir, "backups"), { recursive: true });
    const restoreWrites = failManifestWrites(t, paths.manifestDir);
    try {
      assert.throws(() => applyDesktopSessionSync(plans, paths.manifestDir, new Date(NOW.getTime() + 1_000)), (error: unknown) =>
        error instanceof DesktopSyncError && /could not record the changes/.test(error.message) && error.entries[0]?.backupPath !== undefined
        && readFileSync(error.entries[0].backupPath, "utf8").includes("state only the copy has")
        && existsSync(`${error.entries[0].backupPath}.json`));
    } finally {
      restoreWrites();
    }
  } finally {
    cleanup();
  }
});

test("Windows distinguishes Desktop from its native CLI using product metadata", () => {
  const scenarios = [
    { products: [], expected: "not_running" },
    { products: ["Claude Code"], expected: "not_running" },
    { products: ["Claude Code", "Claude Code"], expected: "not_running" },
    { products: ["Claude"], expected: "running" },
    { products: ["Claude Code", "Claude", "Claude"], expected: "running" },
    { products: [" claude "], expected: "running" },
    { products: [null, "Claude"], expected: "running" },
    { products: [null], expected: "unknown" },
    { products: ["", "Claude Code"], expected: "unknown" },
    { products: ["Unknown application"], expected: "unknown" },
  ];
  for (const { products, expected } of scenarios) {
    const state = desktopProcessState("win32", (command, args, options) => {
      assert.equal(command, "powershell.exe");
      assert.deepEqual(args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
      assert.match(args[3]!, /Get-Process -ErrorAction Stop/);
      assert.match(args[3]!, /FileVersionInfo.ProductName/);
      assert.equal(options.shell, false);
      assert.equal(options.windowsHide, true);
      assert.equal(options.timeout, 5_000);
      return { status: 0, stdout: JSON.stringify(products.map((productName) => ({ productName }))) };
    });
    assert.equal(state, expected, JSON.stringify(products));
  }
});

test("Windows process detection fails closed on errors, timeouts, or unexpected output", () => {
  for (const stdout of ["", "not json", "null", "{}", '[{}]', '[{"productName":123}]']) {
    assert.equal(desktopProcessState("win32", () => ({ status: 0, stdout })), "unknown", stdout);
  }
  for (const result of [
    { status: 1, stdout: "[]" },
    { status: null, stdout: "[]" },
    { status: 0, stdout: "[]", error: new Error("ENOENT") },
    { status: null, stdout: "[]", error: new Error("ETIMEDOUT") },
  ]) assert.equal(desktopProcessState("win32", () => result), "unknown");
  assert.equal(desktopProcessState("win32", () => { throw new Error("query failed"); }), "unknown");
});

test("macOS process detection matches Desktop even when it is an ancestor, and preserves pgrep exit semantics", () => {
  for (const [status, expected] of [[0, "running"], [1, "not_running"], [2, "unknown"], [null, "unknown"]] as const) {
    assert.equal(desktopProcessState("darwin", (command, args) => {
      assert.equal(command, "pgrep");
      // Without -a, BSD pgrep never reports Desktop to a codex2cc started from its Code tab.
      assert.deepEqual(args, ["-a", "-x", "Claude"]);
      return { status };
    }), expected);
  }
  assert.equal(desktopProcessState("darwin", () => ({ status: 1, error: new Error("spawn failed") })), "unknown");
});

test("Windows sync copies history with CLI only and refuses while Desktop is open", () => {
  const { paths, cleanup } = createSandbox();
  try {
    const claude = scopeDir(paths.profiles.claude, "acct", "org");
    const gateway = scopeDir(paths.profiles.thirdParty, "gw", "org");
    writeSession(claude, "c1", "cli-c1", 1_000);
    writeTranscript(paths, "cli-c1");
    const running = desktopProcessState("win32", () => ({ status: 0, stdout: '[{"productName":"Claude"}]' }));
    assert.equal(syncDesktopSessionsWhenClosed(TO_GATEWAY_PROFILE, paths, running, NOW).status, "skipped");
    assert.deepEqual(sessionFiles(gateway), []);
    const closed = desktopProcessState("win32", () => ({ status: 0, stdout: '[{"productName":"Claude Code"}]' }));
    requireDesktopClosed(closed);
    const result = syncDesktopSessionsWhenClosed(TO_GATEWAY_PROFILE, paths, closed, NOW);
    assert.equal(result.status, "applied");
    assert.deepEqual(sessionFiles(gateway), ["local_c1.json"]);
    assert.equal(desktopSyncReport(result).level, "success");
  } finally { cleanup(); }
});

test("sync reports warn when a destination scope or source transcripts are missing", () => {
  const { paths, cleanup } = createSandbox();
  try {
    writeSession(scopeDir(paths.profiles.claude, "acct", "org"), "c1", "cli-c1", 1_000);
    const noScope = desktopSyncReport(runDesktopSessionSync(TO_GATEWAY_PROFILE, paths, NOW));
    assert.equal(noScope.level, "warning");
    assert.match(noScope.messages.join(" "), /then quit it and rerun/);
    assert.match(noScope.headline, /^No sessions needed copying\. 1 account\(s\) have no session list yet/);
    scopeDir(paths.profiles.thirdParty, "gw", "org");
    const noTranscript = desktopSyncReport(runDesktopSessionSync(TO_GATEWAY_PROFILE, paths, NOW));
    assert.equal(noTranscript.level, "warning");
    assert.match(noTranscript.messages.join(" "), /1 without transcript/);
    assert.doesNotMatch(noTranscript.messages.join(" "), /0 unreadable|0 deleted there/, "zero counts are left out");
    assert.match(noTranscript.headline, /1 session\(s\) cannot be copied/);
  } finally { cleanup(); }
});

test("the all-accounts sync gives every scope of both profiles every session, ignoring scope selections", () => {
  const { paths, cleanup } = createSandbox();
  try {
    const personal = scopeDir(paths.profiles.claude, "acct-a", "org-1");
    const work = scopeDir(paths.profiles.claude, "acct-b", "org-2");
    const gateway = scopeDir(paths.profiles.thirdParty, "gw", "org-gw");
    writeSession(personal, "a1", "cli-a1", 1_000);
    writeSession(work, "b1", "cli-b1", 2_000);
    writeSession(work, "b2", "cli-missing", 3_000);
    writeSession(gateway, "g1", "cli-g1", 4_000);
    writeFileSync(join(personal, "deleted_g1"), "1");
    for (const id of ["cli-a1", "cli-b1", "cli-g1"]) writeTranscript(paths, id);
    const selected = { ...paths, selectedScopes: { claude: "acct-a/org-1", thirdParty: "gw/org-gw" } };

    const plans = planAllAccountsSessionSync(selected);
    assert.deepEqual(plans.map((plan) => [plan.from, plan.to, plan.destinationScopeId]), [
      ["all", "claude", "acct-a/org-1"], ["all", "claude", "acct-b/org-2"], ["all", "thirdParty", "gw/org-gw"],
    ]);
    assert.deepEqual(plans.map((plan) => plan.copies.map((copy) => copy.sessionId).sort()), [
      ["local_b1"], ["local_a1", "local_g1"], ["local_a1", "local_b1"],
    ]);
    assert.deepEqual(plans[0]!.skipped, { alreadyPresent: 1, deletedInDestination: 1, missingTranscript: 1, invalid: 0 });
    assert.match(describePlans(plans, DRY_RUN_TENSE)[1]!, /^All accounts -> Claude \(claude\.ai\) \[acct\/org\]: would copy 2 session/);

    const outcome = syncAllAccountsWhenClosed(selected, "not_running", NOW);
    assert.equal(outcome.status, "applied");
    assert.deepEqual(sessionFiles(personal), ["local_a1.json", "local_b1.json"]);
    assert.deepEqual(sessionFiles(work), ["local_a1.json", "local_b1.json", "local_b2.json", "local_g1.json"]);
    assert.deepEqual(sessionFiles(gateway), ["local_a1.json", "local_b1.json", "local_g1.json"]);
    const again = planAllAccountsSessionSync(selected);
    assert.equal(again.reduce((sum, plan) => sum + plan.copies.length + plan.refreshes.length, 0), 0);
  } finally {
    cleanup();
  }
});

test("the all-accounts sync refreshes older entries from the newest version and never touches files while Desktop is open", () => {
  const { paths, cleanup } = createSandbox();
  try {
    const personal = scopeDir(paths.profiles.claude, "acct-a", "org-1");
    const work = scopeDir(paths.profiles.claude, "acct-b", "org-2");
    const original = writeSession(personal, "a1", "cli-a1", 1_000);
    writeTranscript(paths, "cli-a1");
    for (const desktop of ["running", "unknown"] as const) {
      const report = desktopSyncReport(syncAllAccountsWhenClosed(paths, desktop, NOW), "click Sync all sessions again.");
      assert.equal(report.status, "skipped");
      assert.match(report.headline, /Quit it, then click Sync all sessions again\.$/);
    }
    assert.deepEqual(sessionFiles(work), []);
    assert.equal(runAllAccountsSessionSync(paths, NOW).status, "applied");
    setActivity(original, 5_000, "Continued");
    const [, workPlan] = planAllAccountsSessionSync(paths);
    assert.deepEqual(workPlan!.refreshes, [{ sessionId: "local_a1", source: original, destination: join(work, "local_a1.json") }]);
    runAllAccountsSessionSync(paths, new Date(NOW.getTime() + 1_000));
    assert.equal(readFileSync(join(work, "local_a1.json"), "utf8"), readFileSync(original, "utf8"));
  } finally {
    cleanup();
  }
});

test("the all-accounts sync reports a profile without a session list instead of guessing one", () => {
  const { paths, cleanup } = createSandbox();
  try {
    writeSession(scopeDir(paths.profiles.claude, "acct", "org"), "c1", "cli-c1", 1_000);
    writeTranscript(paths, "cli-c1");
    const plans = planAllAccountsSessionSync(paths);
    assert.deepEqual(plans.map((plan) => [plan.to, plan.blocked]), [["claude", undefined], ["thirdParty", "no_destination_scope"]]);
    assert.equal(desktopSyncReport(runAllAccountsSessionSync(paths, NOW)).level, "warning");
  } finally {
    cleanup();
  }
});

test("the add-only sync copies what a list lacks and never replaces an older entry", () => {
  const { paths, cleanup } = createSandbox();
  try {
    const claude = scopeDir(paths.profiles.claude, "acct", "org");
    const gateway = scopeDir(paths.profiles.thirdParty, "gw", "org-gw");
    writeSession(claude, "shared", "cli-shared", 5_000);
    const olderCopy = writeSession(gateway, "shared", "cli-shared", 1_000);
    writeSession(gateway, "g1", "cli-g1", 2_000);
    for (const id of ["cli-shared", "cli-g1"]) writeTranscript(paths, id);
    assert.equal(planAllAccountsSessionSync(paths).flatMap((plan) => plan.refreshes).length, 1, "the pooled sync would refresh it");

    const plans = planAddMissingSessionSync(paths);
    assert.deepEqual(plans.flatMap((plan) => plan.refreshes), []);
    assert.deepEqual(plans.flatMap((plan) => plan.copies.map((copy) => copy.sessionId)), ["local_g1"]);
    const outcome = syncPlanWhenClosed(() => planAddMissingSessionSync(paths), paths.manifestDir, "not_running", NOW);
    assert.equal(outcome.status, "applied");
    assert.deepEqual(sessionFiles(claude), ["local_g1.json", "local_shared.json"]);
    assert.match(readFileSync(olderCopy, "utf8"), /"lastActivityAt":1000/);
  } finally {
    cleanup();
  }
});

test("the mirror sync makes every list a copy of the most recently active one, backing up what it replaces or removes", () => {
  const { paths, cleanup } = createSandbox();
  try {
    const newest = scopeDir(paths.profiles.thirdParty, "gw", "org-gw");
    const claude = scopeDir(paths.profiles.claude, "acct-a", "org-1");
    const other = scopeDir(paths.profiles.claude, "acct-b", "org-2");
    const kept = writeSession(newest, "n1", "cli-n1", 9_000);
    writeSession(newest, "shared", "cli-shared", 1_000);
    writeSession(newest, "gone", "cli-gone", 1_000);
    const newerElsewhere = writeSession(claude, "shared", "cli-shared", 8_000);
    const onlyInClaude = writeSession(claude, "c1", "cli-c1", 7_000);
    writeSession(claude, "same-transcript", "cli-n1", 1_000);
    writeFileSync(join(other, "deleted_gone"), "1");
    for (const id of ["cli-n1", "cli-shared", "cli-gone", "cli-c1"]) writeTranscript(paths, id);

    const plans = planMirrorNewestSessionSync(paths);
    assert.deepEqual(plans.map((plan) => [plan.from, plan.sourceScopeId, plan.to, plan.destinationScopeId]), [
      ["thirdParty", "gw/org-gw", "claude", "acct-a/org-1"],
      ["thirdParty", "gw/org-gw", "claude", "acct-b/org-2"],
    ], "the newest list itself gets no plan");
    const [intoClaude, intoOther] = plans;
    assert.deepEqual(intoClaude!.copies.map((copy) => copy.sessionId), ["local_gone"]);
    assert.deepEqual(intoClaude!.refreshes, [{ sessionId: "local_shared", source: join(newest, "local_shared.json"), destination: newerElsewhere }], "the newest list wins even over a newer entry");
    assert.deepEqual(intoClaude!.removals, [{ sessionId: "local_c1", destination: onlyInClaude }], "an entry sharing a transcript with the newest list is kept");
    assert.deepEqual(intoOther!.copies.map((copy) => copy.sessionId).sort(), ["local_n1", "local_shared"]);
    assert.equal(intoOther!.skipped.deletedInDestination, 1, "a tombstone still blocks re-adding a deleted session");
    assert.match(describePlans(plans, DRY_RUN_TENSE)[0]!, /^Claude-3p \(gateway\) \[gw\/org\] -> Claude \(claude\.ai\) \[acct\/org\]: would copy 1 session\(s\), would refresh 1 older session\(s\), would remove 1 session\(s\)/);
    assert.equal(summarizePlans(plans, DRY_RUN_TENSE), "Would copy 3 session(s), would refresh 1 and would remove 1 across 2 account(s).");

    const removedBefore = readFileSync(onlyInClaude, "utf8");
    const outcome = syncPlanWhenClosed(() => planMirrorNewestSessionSync(paths), paths.manifestDir, "not_running", NOW);
    assert.equal(outcome.status, "applied");
    const removed = outcome.status === "applied" ? outcome.sync.entries.find((entry) => entry.action === "removed") : undefined;
    assert.ok(removed);
    assert.equal(existsSync(onlyInClaude), false);
    assert.equal(readFileSync(removed.backupPath, "utf8"), removedBefore);
    assert.equal((JSON.parse(readFileSync(`${removed.backupPath}.json`, "utf8")) as { destination: string }).destination, onlyInClaude);
    assert.ok(existsSync(join(paths.projectsDir, "-work", "cli-c1.jsonl")), "its transcript is untouched");
    assert.deepEqual(sessionFiles(claude), ["local_gone.json", "local_same-transcript.json", "local_shared.json"]);
    assert.equal(readFileSync(newerElsewhere, "utf8"), readFileSync(join(newest, "local_shared.json"), "utf8"));
    assert.equal(readFileSync(kept, "utf8").includes("9000"), true);
    assert.equal(planMirrorNewestSessionSync(paths).reduce((sum, plan) => sum + plan.copies.length + plan.refreshes.length + plan.removals.length, 0), 0, "a second mirror changes nothing");
  } finally {
    cleanup();
  }
});

test("the mirror sync reports when no list has a session", () => {
  const { paths, cleanup } = createSandbox();
  try {
    scopeDir(paths.profiles.claude, "acct", "org");
    assert.deepEqual(planMirrorNewestSessionSync(paths).map((plan) => [plan.to, plan.blocked]), [["claude", "no_source_sessions"], ["thirdParty", "no_source_sessions"]]);
  } finally {
    cleanup();
  }
});
