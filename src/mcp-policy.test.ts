import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadMcpPolicy, permissionArgs, PolicyError, pruneTasks, resolveProjectDir } from "./mcp-policy.js";

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "codex2cc-policy-")));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function rejectsWithCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => error instanceof PolicyError && error.code === code);
}

test("loadMcpPolicy defaults to the working directory as the only root", () => {
  const policy = loadMcpPolicy({}, "/work/project");
  assert.deepEqual(policy.allowedRoots, ["/work/project"]);
  assert.equal(policy.allowBypass, false);
  assert.equal(policy.maxConcurrent, 3);
  assert.equal(policy.claudeBinary, "claude");
});

test("loadMcpPolicy allows no root when launched from the filesystem root", () => {
  assert.deepEqual(loadMcpPolicy({}, "/").allowedRoots, []);
});

test("loadMcpPolicy reads roots and limits from the environment", () => {
  const policy = loadMcpPolicy(
    { CODEX2CC_ALLOWED_ROOTS: "/a:/b", CODEX2CC_ALLOW_BYPASS: "1", CODEX2CC_MAX_CONCURRENT: "1", CODEX2CC_CLAUDE_BIN: "/bin/fake" },
    "/",
  );
  assert.deepEqual(policy.allowedRoots, ["/a", "/b"]);
  assert.equal(policy.allowBypass, true);
  assert.equal(policy.maxConcurrent, 1);
  assert.equal(policy.claudeBinary, "/bin/fake");
});

test("loadMcpPolicy rejects relative roots and invalid numbers", () => {
  assert.throws(() => loadMcpPolicy({ CODEX2CC_ALLOWED_ROOTS: "relative/path" }, "/x"), PolicyError);
  assert.throws(() => loadMcpPolicy({ CODEX2CC_TASK_TIMEOUT_MS: "-5" }, "/x"), PolicyError);
  assert.throws(() => loadMcpPolicy({ CODEX2CC_MAX_CONCURRENT: "abc" }, "/x"), PolicyError);
  assert.throws(() => loadMcpPolicy({ CODEX2CC_TASK_TIMEOUT_MS: "2147483648" }, "/x"), PolicyError);
  assert.equal(loadMcpPolicy({ CODEX2CC_TASK_TIMEOUT_MS: "2147483647" }, "/x").taskTimeoutMs, 2_147_483_647);
});

test("resolveProjectDir accepts the root and nested directories, defaulting to the first root", async () => {
  await withTempDir(async (root) => {
    const nested = join(root, "app", "src");
    await mkdir(nested, { recursive: true });
    const policy = loadMcpPolicy({ CODEX2CC_ALLOWED_ROOTS: root }, "/");
    assert.equal(await resolveProjectDir(undefined, policy), root);
    assert.equal(await resolveProjectDir(root, policy), root);
    assert.equal(await resolveProjectDir(nested, policy), nested);
  });
});

test("resolveProjectDir refuses outside paths, siblings with a shared prefix, and symlink escapes", async () => {
  await withTempDir(async (base) => {
    const root = join(base, "allowed");
    const sibling = join(base, "allowed-evil");
    const outside = join(base, "outside");
    await Promise.all([root, sibling, outside].map((dir) => mkdir(dir, { recursive: true })));
    await symlink(outside, join(root, "link"));
    const policy = loadMcpPolicy({ CODEX2CC_ALLOWED_ROOTS: root }, "/");
    await rejectsWithCode(resolveProjectDir(outside, policy), "project_dir_not_allowed");
    await rejectsWithCode(resolveProjectDir(sibling, policy), "project_dir_not_allowed");
    await rejectsWithCode(resolveProjectDir(join(root, "link"), policy), "project_dir_not_allowed");
    await rejectsWithCode(resolveProjectDir(join(root, "..", "outside"), policy), "project_dir_not_allowed");
  });
});

test("resolveProjectDir rejects relative, missing and non-directory paths and an empty root list", async () => {
  await withTempDir(async (root) => {
    const file = join(root, "file.txt");
    await writeFile(file, "x");
    const policy = loadMcpPolicy({ CODEX2CC_ALLOWED_ROOTS: root }, "/");
    await rejectsWithCode(resolveProjectDir("relative", policy), "invalid_project_dir");
    await rejectsWithCode(resolveProjectDir(join(root, "missing"), policy), "invalid_project_dir");
    await rejectsWithCode(resolveProjectDir(file, policy), "invalid_project_dir");
    await rejectsWithCode(resolveProjectDir(root, loadMcpPolicy({}, "/")), "no_allowed_roots");
  });
});

test("permissionArgs gates bypass behind the operator opt-in", () => {
  const closed = loadMcpPolicy({}, "/x");
  const open = loadMcpPolicy({ CODEX2CC_ALLOW_BYPASS: "1" }, "/x");
  assert.deepEqual(permissionArgs("acceptEdits", closed), ["--permission-mode", "acceptEdits"]);
  assert.deepEqual(permissionArgs("plan", closed), ["--permission-mode", "plan"]);
  assert.throws(() => permissionArgs("bypassPermissions", closed), (error: unknown) => error instanceof PolicyError && error.code === "bypass_not_allowed");
  assert.deepEqual(permissionArgs("bypassPermissions", open), ["--dangerously-skip-permissions"]);
});

test("pruneTasks drops expired finished tasks, then the oldest finished beyond the cap, never running ones", () => {
  const tasks = new Map<string, { completedAt?: number | undefined }>([
    ["expired", { completedAt: 100 }],
    ["running", {}],
    ["old", { completedAt: 9_000 }],
    ["new", { completedAt: 9_500 }],
  ]);
  pruneTasks(tasks, 10_000, 5_000, 2);
  assert.deepEqual([...tasks.keys()], ["running", "new"]);
});
