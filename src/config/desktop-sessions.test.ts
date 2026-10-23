import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
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
  runDesktopSessionSync,
  syncDesktopSessionsWhenClosed,
  TO_GATEWAY_PROFILE,
  type DesktopSessionPaths,
} from "./desktop-sessions.js";

const NOW = new Date("2026-10-23T10:00:00.000Z");

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

test("desktopSyncReport tells clients when history was left hidden", () => {
  assert.deepEqual(desktopSyncReport({ status: "skipped", desktop: "running" }).level, "warning");
  assert.deepEqual(desktopSyncReport({ status: "failed", error: "boom", entries: [], manifestPath: undefined }), { status: "failed", level: "error", messages: ["boom"] });
  const applied = desktopSyncReport({ status: "applied", sync: { plans: [], entries: [], manifestPath: undefined } });
  assert.deepEqual(applied, { status: "applied", level: "success", messages: [] });
});

test("Desktop state is unknown off macOS and the explicit command refuses unless Desktop is closed", () => {
  assert.equal(desktopProcessState("linux"), "unknown");
  assert.equal(desktopProcessState("win32"), "unknown");
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

test("a manifest write failure is reported together with the copy failure it follows, never instead of it", () => {
  const { paths, cleanup } = createSandbox();
  try {
    const claude = scopeDir(paths.profiles.claude, "acct", "org");
    const gateway = scopeDir(paths.profiles.thirdParty, "gw", "org-gw");
    writeSession(claude, "c1", "cli-c1", 1_000);
    writeSession(claude, "c2", "cli-c2", 2_000);
    writeSession(gateway, "g1", "cli-g1", 3_000);
    for (const id of ["cli-c1", "cli-c2", "cli-g1"]) writeTranscript(paths, id);
    mkdirSync(paths.manifestDir, { recursive: true });
    chmodSync(paths.manifestDir, 0o500);

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
    chmodSync(paths.manifestDir, 0o700);
    cleanup();
  }
});

test("runDesktopSessionSync turns sync failures into an outcome that lists what already changed", () => {
  const { paths, cleanup } = createSandbox();
  try {
    const claude = scopeDir(paths.profiles.claude, "acct", "org");
    const gateway = scopeDir(paths.profiles.thirdParty, "gw", "org-gw");
    writeSession(claude, "c1", "cli-c1", 1_000);
    writeSession(gateway, "g1", "cli-g1", 3_000);
    writeTranscript(paths, "cli-c1");
    mkdirSync(paths.manifestDir, { recursive: true });
    chmodSync(paths.manifestDir, 0o500);

    const outcome = syncDesktopSessionsWhenClosed(TO_GATEWAY_PROFILE, paths, "not_running", NOW);
    assert.equal(outcome.status, "failed");
    const lines = describeOutcome(outcome);
    assert.match(lines[0] ?? "", /could not record the changes/);
    assert.match(lines[1] ?? "", new RegExp(`added ${join(gateway, "local_c1.json").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));

    chmodSync(paths.manifestDir, 0o700);
    writeFileSync(join(paths.manifestDir, "broken.json"), "{");
    const badManifest = runDesktopSessionSync(TO_GATEWAY_PROFILE, paths, NOW);
    assert.deepEqual(badManifest.status, "failed");
    assert.match(describeOutcome(badManifest)[0] ?? "", /broken\.json is not valid JSON/);
  } finally {
    cleanup();
  }
});

test("a refresh whose manifest cannot be written still leaves its backup and receipt behind", () => {
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
    chmodSync(paths.manifestDir, 0o500);
    try {
      assert.throws(() => applyDesktopSessionSync(plans, paths.manifestDir, new Date(NOW.getTime() + 1_000)), (error: unknown) =>
        error instanceof DesktopSyncError && /could not record the changes/.test(error.message) && error.entries[0]?.backupPath !== undefined
        && readFileSync(error.entries[0].backupPath, "utf8").includes("state only the copy has")
        && existsSync(`${error.entries[0].backupPath}.json`));
    } finally {
      chmodSync(paths.manifestDir, 0o700);
    }
  } finally {
    cleanup();
  }
});
