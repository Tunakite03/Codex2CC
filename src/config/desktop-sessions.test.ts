import assert from "node:assert/strict";
import fs, { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
  planDesktopSessionSync,
  requireDesktopClosed,
  resolveDesktopSessionPaths,
  runDesktopSessionSync,
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

test("plan copies only missing sessions with a transcript into the explicitly selected destination scope", () => {
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

    assert.throws(
      () => planDesktopSessionSync(TO_GATEWAY_PROFILE, paths),
      (error: unknown) => error instanceof BridgeError && error.code === "ambiguous_desktop_scope"
        && /CODEX2CC_GATEWAY_SESSION_SCOPE/.test(error.message) && /gw\/org-new/.test(error.message) && /gw\/org-old/.test(error.message),
      "two destination scopes are never resolved by guessing",
    );
    const [plan] = planDesktopSessionSync(TO_GATEWAY_PROFILE, { ...paths, selectedScopes: { thirdParty: "gw/org-new" } });
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

test("an ambiguous scope reaches setup/reset callers as a failed sync, not a crash", () => {
  const { paths, cleanup } = createSandbox();
  try {
    writeSession(scopeDir(paths.profiles.claude, "acct", "org"), "c1", "cli-c1", 1_000);
    writeTranscript(paths, "cli-c1");
    scopeDir(paths.profiles.thirdParty, "a", "org");
    scopeDir(paths.profiles.thirdParty, "b", "org");
    const report = desktopSyncReport(syncDesktopSessionsWhenClosed(TO_GATEWAY_PROFILE, paths, "not_running", NOW));
    assert.equal(report.status, "failed");
    assert.equal(report.level, "error");
    assert.match(report.messages[0] ?? "", /CODEX2CC_GATEWAY_SESSION_SCOPE/);
    assert.equal(existsSync(paths.manifestDir), false, "nothing was written");
  } finally {
    cleanup();
  }
});

test("an ambiguous scope error lists each scope's session count and last activity", () => {
  const { paths, cleanup } = createSandbox();
  try {
    writeSession(scopeDir(paths.profiles.claude, "acct", "org"), "c1", "cli-c1", 1_000);
    writeTranscript(paths, "cli-c1");
    const active = scopeDir(paths.profiles.thirdParty, "a", "org");
    writeSession(active, "a1", "cli-a1", Date.parse("2026-10-05T12:11:00.000Z"));
    writeSession(active, "a2", "cli-a2", Date.parse("2026-10-23T17:59:42.000Z"));
    scopeDir(paths.profiles.thirdParty, "b", "org");
    assert.throws(
      () => planDesktopSessionSync(TO_GATEWAY_PROFILE, paths),
      (error: unknown) => error instanceof BridgeError && error.code === "ambiguous_desktop_scope"
        && error.message.includes("a/org (2 session(s), last active 2026-10-23 17:59 UTC)")
        && error.message.includes("b/org (no sessions)"),
    );
  } finally {
    cleanup();
  }
});

test("desktopSyncReport tells clients when history was left hidden", () => {
  assert.deepEqual(desktopSyncReport({ status: "skipped", desktop: "running" }).level, "warning");
  assert.deepEqual(desktopSyncReport({ status: "failed", error: "boom", entries: [], manifestPath: undefined }), { status: "failed", level: "error", messages: ["boom"] });
  const applied = desktopSyncReport({ status: "applied", sync: { plans: [], entries: [], manifestPath: undefined } });
  assert.deepEqual(applied, { status: "applied", level: "success", messages: [] });
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

test("a copy codex2cc made is refreshed when its original has newer activity, and only then", () => {
  const { paths, cleanup } = createSandbox();
  try {
    const claude = scopeDir(paths.profiles.claude, "acct", "org");
    const gateway = scopeDir(paths.profiles.thirdParty, "gw", "org-gw");
    const newerOriginal = writeSession(claude, "c1", "cli-c1", 1_000);
    const continuedInCopy = writeSession(claude, "c2", "cli-c2", 1_000);
    const deletedCopy = writeSession(claude, "c3", "cli-c3", 1_000);
    writeSession(gateway, "g1", "cli-g1", 500);
    for (const id of ["cli-c1", "cli-c2", "cli-c3", "cli-g1"]) writeTranscript(paths, id);
    applyDesktopSessionSync(planDesktopSessionSync(TO_GATEWAY_PROFILE, paths), paths.manifestDir, NOW);

    // Desktop's own entry with the same id as a newer original must never be replaced.
    const desktopsOwn = writeSession(claude, "c4", "cli-c4", 9_000);
    writeTranscript(paths, "cli-c4");
    writeSession(gateway, "c4", "cli-c4", 100);

    setActivity(newerOriginal, 5_000, "continued in claude.ai");
    setActivity(join(gateway, "local_c2.json"), 6_000, "continued through the gateway");
    setActivity(continuedInCopy, 4_000, "older claude.ai activity");
    rmSync(join(gateway, "local_c3.json"));
    writeFileSync(join(gateway, "deleted_c3"), "1");
    setActivity(deletedCopy, 7_000, "newer but deleted in the gateway profile");

    const [plan] = planDesktopSessionSync(TO_GATEWAY_PROFILE, paths);
    assert.deepEqual(plan?.refreshes, [{ sessionId: "local_c1", source: newerOriginal, destination: join(gateway, "local_c1.json") }]);
    assert.deepEqual(plan?.copies, []);
    assert.match(describePlans([plan!], DRY_RUN_TENSE)[0] ?? "", /would refresh 1 earlier cop\(ies\)/);

    const beforeRefresh = readFileSync(join(gateway, "local_c1.json"), "utf8");
    const applied = applyDesktopSessionSync([plan!], paths.manifestDir, new Date(NOW.getTime() + 1_000));
    assert.deepEqual(applied.entries.map((entry) => entry.action), ["refreshed"]);
    const [refreshed] = applied.entries;
    assert.ok(refreshed?.backupPath, "every refresh records a backup of what it replaced");
    assert.equal(readFileSync(refreshed.backupPath, "utf8"), beforeRefresh);
    assert.equal((JSON.parse(readFileSync(`${refreshed.backupPath}.json`, "utf8")) as { destination: string }).destination, join(gateway, "local_c1.json"));
    const manifest = JSON.parse(readFileSync(applied.manifestPath!, "utf8")) as { entries: Array<{ backupPath?: string }> };
    assert.equal(manifest.entries[0]?.backupPath, refreshed.backupPath);
    assert.equal(readFileSync(join(gateway, "local_c1.json"), "utf8"), readFileSync(newerOriginal, "utf8"));
    assert.match(readFileSync(join(gateway, "local_c2.json"), "utf8"), /continued through the gateway/);
    assert.match(readFileSync(join(gateway, "local_c4.json"), "utf8"), /"lastActivityAt":100/);
    assert.equal(existsSync(join(gateway, "local_c3.json")), false);
    assert.ok(readdirSync(gateway).every((name) => !name.endsWith(".tmp")), "no temporary file left behind");
    assert.equal(readFileSync(desktopsOwn, "utf8").includes("9000"), true);

    assert.deepEqual(planDesktopSessionSync(TO_GATEWAY_PROFILE, paths)[0]?.refreshes, [], "a refreshed copy is current until the original changes again");
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
    writeFileSync(join(paths.manifestDir, "broken.json"), "{");
    const badManifest = runDesktopSessionSync(TO_GATEWAY_PROFILE, paths, NOW);
    assert.deepEqual(badManifest.status, "failed");
    assert.match(describeOutcome(badManifest)[0] ?? "", /broken\.json is not valid JSON/);
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

test("macOS process detection preserves pgrep exit semantics", () => {
  for (const [status, expected] of [[0, "running"], [1, "not_running"], [2, "unknown"], [null, "unknown"]] as const) {
    assert.equal(desktopProcessState("darwin", (command, args) => {
      assert.equal(command, "pgrep");
      assert.deepEqual(args, ["-x", "Claude"]);
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
    scopeDir(paths.profiles.thirdParty, "gw", "org");
    const noTranscript = desktopSyncReport(runDesktopSessionSync(TO_GATEWAY_PROFILE, paths, NOW));
    assert.equal(noTranscript.level, "warning");
    assert.match(noTranscript.messages.join(" "), /1 without transcript/);
  } finally { cleanup(); }
});
