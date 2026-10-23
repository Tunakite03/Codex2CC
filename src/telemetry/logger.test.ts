import assert from "node:assert/strict";
import test from "node:test";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  clearLogs,
  getActiveLogFilePath,
  getLogs,
  getLogStats,
  onLog,
  onLogsCleared,
  recordLog,
  resolveLogFilePath,
  setLogFilePath,
} from "./logger.js";

test("logger records entries with monotonic ids and ISO timestamps", () => {
  clearLogs();
  const entry1 = recordLog({
    level: "info",
    operation: "test_op",
    message: "First entry",
    details: { key: "val1" },
  });
  const entry2 = recordLog({
    level: "warn",
    operation: "test_op_2",
    message: "Second entry",
  });

  assert.equal(entry1.level, "info");
  assert.equal(entry1.operation, "test_op");
  assert.equal(entry1.message, "First entry");
  assert.equal(entry1.details?.key, "val1");
  assert.ok(entry2.id > entry1.id);
  assert.ok(!Number.isNaN(Date.parse(entry1.timestamp)));

  const all = getLogs();
  assert.equal(all.length, 2);
  assert.equal(all[0]?.id, entry1.id);
  assert.equal(all[1]?.id, entry2.id);
});

test("logger filters by sinceId, level, search, and limit", () => {
  clearLogs();
  const e1 = recordLog({ level: "info", operation: "inference", message: "Inference started", details: { model: "gpt-6-sol" } });
  const e2 = recordLog({ level: "warn", operation: "model_fallback", message: "Fallback to sonnet", details: { requested: "claude-3-5" } });
  const e3 = recordLog({ level: "error", operation: "bridge_error", message: "Upstream 502 error", details: { status: 502 } });

  // Filter by level
  const warns = getLogs({ level: "warn" });
  assert.equal(warns.length, 1);
  assert.equal(warns[0]?.id, e2.id);

  // Filter by sinceId
  const sinceE1 = getLogs({ sinceId: e1.id });
  assert.equal(sinceE1.length, 2);
  assert.equal(sinceE1[0]?.id, e2.id);
  assert.equal(sinceE1[1]?.id, e3.id);

  // Filter by search in message
  const searchMsg = getLogs({ search: "502" });
  assert.equal(searchMsg.length, 1);
  assert.equal(searchMsg[0]?.id, e3.id);

  // Filter by search in details
  const searchDetail = getLogs({ search: "gpt-6-sol" });
  assert.equal(searchDetail.length, 1);
  assert.equal(searchDetail[0]?.id, e1.id);

  // Filter by limit
  const limited = getLogs({ limit: 2 });
  assert.equal(limited.length, 2);
  assert.equal(limited[0]?.id, e2.id);
  assert.equal(limited[1]?.id, e3.id);
});

test("logger aggregates statistics and handles clear", () => {
  clearLogs();
  recordLog({ level: "info", operation: "op1", message: "info 1" });
  recordLog({ level: "info", operation: "op2", message: "info 2" });
  recordLog({ level: "warn", operation: "op3", message: "warn 1" });
  recordLog({ level: "error", operation: "op4", message: "error 1" });

  const stats = getLogStats();
  assert.equal(stats.total, 4);
  assert.equal(stats.infoCount, 2);
  assert.equal(stats.warnCount, 1);
  assert.equal(stats.errorCount, 1);

  clearLogs();
  const clearedStats = getLogStats();
  assert.equal(clearedStats.total, 0);
  assert.equal(clearedStats.infoCount, 0);
  assert.equal(clearedStats.warnCount, 0);
  assert.equal(clearedStats.errorCount, 0);
  assert.equal(getLogs().length, 0);
});

test("logger bounds maximum entries to prevent memory leaks", () => {
  clearLogs();
  for (let i = 0; i < 550; i++) {
    recordLog({ level: "info", operation: "fill", message: `Log #${i}` });
  }

  const all = getLogs();
  assert.equal(all.length, 500);
  assert.equal(all[all.length - 1]?.message, "Log #549");
  assert.equal(all[0]?.message, "Log #50");
});

test("resolveLogFilePath determines project log path and respects environment override", () => {
  const defaultPath = resolveLogFilePath({});
  assert.ok(defaultPath.endsWith("/logs/codex2cc.log") || defaultPath.endsWith("\\logs\\codex2cc.log"));

  const absoluteOverride = join(tmpdir(), "codex2cc-logger-override", "gateway.log");
  assert.equal(resolveLogFilePath({ CODEX2CC_LOG_FILE: absoluteOverride }), absoluteOverride);
  assert.equal(resolveLogFilePath({ CODEX2CC_LOG_FILE: "/custom/path/gateway.log" }), resolve("/custom/path/gateway.log"));
  assert.equal(resolveLogFilePath({ CODEX2CC_LOG_FILE: "  logs/../custom/gateway.log  " }), resolve("custom", "gateway.log"));
});

test("recordLog writes formatted log lines to disk and clearLogs can truncate file", async () => {
  const { mkdtempSync, readFileSync, rmSync, existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const tempDir = mkdtempSync(join(tmpdir(), "codex2cc-logger-test-"));
  const tempLogFile = join(tempDir, "nested", "test.log");

  try {
    setLogFilePath(tempLogFile);
    clearLogs();

    assert.equal(getActiveLogFilePath(), tempLogFile);

    recordLog({
      level: "info",
      operation: "server_start",
      message: "Gateway started successfully",
      details: { port: 3456 },
    });

    recordLog({
      level: "error",
      operation: "auth_failed",
      message: "Missing token",
    });

    assert.equal(existsSync(tempLogFile), true);
    const content = readFileSync(tempLogFile, "utf8");
    assert.ok(content.includes("[INFO] [server_start] Gateway started successfully | {\"port\":3456}"));
    assert.ok(content.includes("[ERROR] [auth_failed] Missing token"));

    // Verify clearLogs({ clearFile: true }) empties the file
    clearLogs({ clearFile: true });
    assert.equal(getLogs().length, 0);
    assert.equal(readFileSync(tempLogFile, "utf8"), "");

    // Verify setLogFilePath(null) disables file output
    setLogFilePath(null);
    recordLog({
      level: "warn",
      operation: "memory_only",
      message: "This should not be written to disk",
    });
    assert.equal(readFileSync(tempLogFile, "utf8"), "");
    assert.equal(getLogs().length, 1);
  } finally {
    setLogFilePath(undefined); // Reset to default
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("onLog and onLogsCleared notify active subscribers and unsubscribe cleanly", () => {
  clearLogs();
  const capturedLogs: string[] = [];
  let clearedCount = 0;

  const unsubscribeLog = onLog((entry) => {
    capturedLogs.push(entry.message);
  });

  const unsubscribeClear = onLogsCleared(() => {
    clearedCount++;
  });

  recordLog({ level: "info", operation: "stream_test", message: "First message" });
  recordLog({ level: "warn", operation: "stream_test", message: "Second message" });

  assert.deepEqual(capturedLogs, ["First message", "Second message"]);

  clearLogs();
  assert.equal(clearedCount, 1);

  // Unsubscribe and verify no more events received
  unsubscribeLog();
  unsubscribeClear();

  recordLog({ level: "error", operation: "stream_test", message: "Third message" });
  clearLogs();

  assert.deepEqual(capturedLogs, ["First message", "Second message"]);
  assert.equal(clearedCount, 1);
});

