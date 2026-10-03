import assert from "node:assert/strict";
import test from "node:test";
import { killAllProcesses, runProcess, type RunOptions } from "./runner.js";

function nodeRun(script: string, overrides: Partial<RunOptions> = {}): Promise<Awaited<ReturnType<typeof runProcess>>> {
  return runProcess({
    command: process.execPath,
    args: ["-e", script],
    cwd: process.cwd(),
    env: process.env,
    timeoutMs: 10_000,
    maxOutputChars: 10_000,
    ...overrides,
  });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

test("runProcess captures output and the exit code", async () => {
  const result = await nodeRun('process.stdout.write("hello"); process.stderr.write("warn"); process.exit(3);');
  assert.equal(result.exitCode, 3);
  assert.equal(result.stdout, "hello");
  assert.equal(result.stderr, "warn");
  assert.equal(result.timedOut, false);
  assert.equal(result.outputTruncated, false);
});

test("runProcess keeps only the tail of oversized output", async () => {
  const result = await nodeRun('process.stdout.write("a".repeat(500) + "END");', { maxOutputChars: 50 });
  assert.equal(result.stdout.length, 50);
  assert.ok(result.stdout.endsWith("END"));
  assert.equal(result.outputTruncated, true);
});

test("runProcess terminates a child that exceeds the timeout", async () => {
  const result = await nodeRun("setInterval(() => {}, 1000);", { timeoutMs: 200 });
  assert.equal(result.timedOut, true);
  assert.equal(result.signal, "SIGTERM");
});

test("runProcess timeout also kills grandchildren in the process group", async () => {
  const script = [
    'const { spawn } = require("node:child_process");',
    'const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
    "process.stdout.write(String(grandchild.pid));",
    "setInterval(() => {}, 1000);",
  ].join("\n");
  const result = await nodeRun(script, { timeoutMs: 1_000 });
  const grandchildPid = Number(result.stdout);
  assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0);
  for (let attempt = 0; attempt < 50 && isAlive(grandchildPid); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(isAlive(grandchildPid), false);
});

test("runProcess settles after a timeout even when an escaped descendant keeps the pipes open", async () => {
  const script = [
    'const { spawn } = require("node:child_process");',
    'spawn(process.execPath, ["-e", "setTimeout(() => {}, 4000)"], { detached: true, stdio: ["ignore", "inherit", "inherit"] });',
    "setInterval(() => {}, 1000);",
  ].join("\n");
  const startedAt = Date.now();
  const result = await nodeRun(script, { timeoutMs: 200, killGraceMs: 100 });
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - startedAt < 3_500, "settled well before the escaped descendant exited");
});

test("runProcess reports success when the child exits 0 but a descendant keeps the pipes open", async () => {
  const script = [
    'const { spawn } = require("node:child_process");',
    'spawn(process.execPath, ["-e", "setTimeout(() => {}, 4000)"], { detached: true, stdio: ["ignore", "inherit", "inherit"] }).unref();',
    'process.stdout.write("done");',
  ].join("\n");
  const startedAt = Date.now();
  const result = await nodeRun(script, { timeoutMs: 2_000 });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "done");
  assert.equal(result.timedOut, false);
  assert.ok(Date.now() - startedAt < 3_500, "settled before the descendant released the pipes");
});

test("killAllProcesses force-kills running children", async () => {
  const pending = nodeRun("setInterval(() => {}, 1000);");
  await new Promise((resolve) => setTimeout(resolve, 200));
  killAllProcesses();
  const result = await pending;
  assert.equal(result.signal, "SIGKILL");
});

test("runProcess rejects when the command cannot be spawned", async () => {
  await assert.rejects(
    runProcess({ command: "/nonexistent/codex2cc-binary", args: [], cwd: process.cwd(), env: process.env, timeoutMs: 1_000, maxOutputChars: 100 }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT",
  );
});
