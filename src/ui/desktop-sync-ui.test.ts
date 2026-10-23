import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { renderDashboardHtml } from "./ui.js";
import type { DesktopSyncReport } from "../config/desktop-sessions.js";

// Execute the emitted browser helper AND actual click handlers, rather than just matching their text.
function dashboardActions(initialReport: DesktopSyncReport | null) {
  const html = renderDashboardHtml();
  const script = html.match(/<script>([\s\S]*?)<\/script>/i)?.[1];
  assert.ok(script);
  function section(start: string, end: string): string {
    const from = script!.indexOf(start);
    const to = script!.indexOf(end, from);
    assert.ok(from >= 0 && to > from, `missing dashboard section: ${start}`);
    return script!.slice(from, to);
  }
  const helper = section("function showConfigurationResult(", "/* Tab Controller */");
  const apply = section('document.getElementById("btn-apply").addEventListener', 'document.getElementById("btn-save-tier-mapping").addEventListener');
  const reset = section("async function sendReset(", "let logsCache =");
  const listeners = new Map<string, () => Promise<void>>();
  const attributes = new Map<string, string>();
  const notice = {
    textContent: "", className: "", hidden: true,
    setAttribute: (key: string, value: string) => attributes.set(key, value),
    set innerHTML(_value: string) { assert.fail("sync messages must never be interpreted as HTML"); },
  };
  const toasts: Array<{ message: string; type: string }> = [];
  let report = initialReport;
  const calls: string[] = [];
  runInNewContext(helper + apply + reset, {
    document: { getElementById: (id: string) => id === "desktop-sync-report" ? notice : {
      value: id === "select-target" ? "desktop" : "http://127.0.0.1:3456",
      addEventListener: (_event: string, callback: () => Promise<void>) => listeners.set(id, callback),
    } },
    showToast: (message: string, type = "success") => toasts.push({ message, type }),
    fetchStatus: () => {},
    confirm: () => true,
    isProviderSwitching: false,
    isProviderConfigSaving: false,
    providerConfigDirty: false,
    hasUnsavedTierChanges: () => false,
    selectedProvider: "codex",
    currentActiveProvider: "codex",
    fetch: async (url: string) => {
      calls.push(url);
      return { json: async () => ({ ok: true, desktopSessionSync: report }) };
    },
  });
  return {
    notice, attributes, toasts, calls,
    setReport: (next: DesktopSyncReport | null) => { report = next; },
    click: async (id: string) => {
      const handler = listeners.get(id);
      assert.ok(handler, `missing click handler: ${id}`);
      await handler();
    },
  };
}

const reports: Array<{ report: DesktopSyncReport; summary: string }> = [
  { report: { status: "skipped", level: "warning", messages: ["Quit Claude Desktop.", "codex2cc --sync-desktop-sessions"] }, summary: "History sync skipped." },
  { report: { status: "failed", level: "error", messages: ["Access denied.", "Changes before failure are in backup.json."] }, summary: "History sync failed." },
  { report: { status: "applied", level: "warning", messages: ["No destination scope; open Desktop once, then quit and rerun."] }, summary: "History sync needs attention." },
  { report: { status: "applied", level: "success", messages: ["Copied 2 sessions."] }, summary: "History sync completed." },
];

for (const action of ["btn-apply", "btn-reset-desktop", "btn-reset-all"]) {
  for (const { report, summary } of reports) {
    test(`${action} shows ${report.status}/${report.level} separately from configuration success`, async () => {
      const ui = dashboardActions(report);
      await ui.click(action);
      assert.deepEqual(ui.calls, [action === "btn-apply" ? "/api/ui/setup" : "/api/ui/reset"]);
      assert.equal(ui.notice.hidden, false);
      assert.equal(ui.notice.className, "desktop-sync-report " + report.level);
      assert.ok(ui.notice.textContent.includes(summary));
      for (const message of report.messages) assert.ok(ui.notice.textContent.includes(message));
      assert.ok(ui.notice.textContent.includes("\n"), "report details must be readable on separate lines");
      assert.equal(ui.attributes.get("role"), report.level === "success" ? "status" : "alert");
      assert.equal(ui.toasts.at(-1)?.type, report.level);
      assert.ok(ui.toasts.at(-1)?.message.includes(summary));
    });
  }
}

test("CLI-only results do not erase a Desktop warning; a successful Desktop retry replaces it", async () => {
  const ui = dashboardActions(reports[0]!.report);
  await ui.click("btn-apply");
  const warning = ui.notice.textContent;
  ui.setReport(null);
  await ui.click("btn-reset-cli");
  assert.equal(ui.notice.textContent, warning);
  assert.equal(ui.notice.className, "desktop-sync-report warning");
  assert.equal(ui.toasts.at(-1)?.type, "success");
  ui.setReport(reports[3]!.report);
  await ui.click("btn-apply");
  assert.equal(ui.notice.className, "desktop-sync-report success");
  assert.ok(!ui.notice.textContent.includes("Quit Claude Desktop"));
});

test("sync error messages render as text rather than HTML", async () => {
  const message = '<img src=x onerror="alert(1)">';
  const ui = dashboardActions({ status: "failed", level: "error", messages: [message] });
  await ui.click("btn-apply");
  assert.ok(ui.notice.textContent.includes(message));
});

test("CLI-only setup with no sync report retains the existing success notification", async () => {
  const ui = dashboardActions(null);
  await ui.click("btn-apply");
  assert.equal(ui.notice.hidden, true);
  assert.deepEqual(ui.toasts, [{ message: "Configuration applied successfully!", type: "success" }]);
});

test("persistent sync feedback is outside tab panels so reset warnings remain visible in Advanced", () => {
  const html = renderDashboardHtml();
  const report = html.indexOf('id="desktop-sync-report"');
  const firstPanel = html.indexOf('class="tab-pane active"');
  assert.ok(report > html.indexOf('<div class="container">'));
  assert.ok(report < firstPanel);
  assert.equal(html.match(/id="desktop-sync-report"/g)?.length, 1);
});

// The Sync all sessions button previews first, asks before copying, and lets the server skip while Desktop is open.
function syncButton(preview: Record<string, unknown>, report: DesktopSyncReport, confirmed = true) {
  const script = renderDashboardHtml().match(/<script>([\s\S]*?)<\/script>/i)?.[1] ?? "";
  const cut = (start: string, end: string) => script.slice(script.indexOf(start), script.indexOf(end, script.indexOf(start)));
  const code = cut("function showConfigurationResult(", "/* Tab Controller */")
    + cut("/* Every Desktop account gets every session", 'document.getElementById("btn-apply").addEventListener');
  let click: (() => Promise<void>) | undefined;
  const notice = { textContent: "", className: "", hidden: true, setAttribute: () => {} };
  const calls: string[] = [];
  const prompts: string[] = [];
  const toasts: Array<{ message: string; type: string }> = [];
  runInNewContext(code, {
    document: { getElementById: (id: string) => id === "desktop-sync-report" ? notice : id === "btn-sync-sessions"
      ? { addEventListener: (_event: string, callback: () => Promise<void>) => { click = callback; } }
      : assert.fail(`unexpected element ${id}`) },
    showToast: (message: string, type = "success") => toasts.push({ message, type }),
    confirm: (message: string) => { prompts.push(message); return confirmed; },
    fetch: async (url: string, init?: { method?: string }) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      return { json: async () => url.endsWith("/plan") ? { ok: true, ...preview } : { ok: true, desktopSessionSync: report } };
    },
  });
  return { notice, calls, prompts, toasts, click: async () => { assert.ok(click, "missing Sync all sessions handler"); await click(); } };
}

const pendingPreview = { desktop: "not_running", changes: 2, level: "success", messages: ["All accounts -> Claude (claude.ai) [a/b]: would copy 2 session(s)"] };

test("Sync all sessions confirms the previewed changes before copying them", async () => {
  const ui = syncButton(pendingPreview, { status: "applied", level: "success", messages: ["copied 2 session(s)"] });
  await ui.click();
  assert.deepEqual(ui.calls, ["GET /api/ui/desktop-sessions/plan", "POST /api/ui/desktop-sessions/sync"]);
  assert.ok(ui.prompts[0]?.includes("would copy 2 session(s)"));
  assert.ok(ui.prompts[0]?.includes("\n"), "the confirmation lists one change per line");
  assert.ok(ui.notice.textContent.includes("copied 2 session(s)"));
  assert.equal(ui.notice.className, "desktop-sync-report success");
});

test("Sync all sessions copies nothing when the confirmation is declined", async () => {
  const ui = syncButton(pendingPreview, { status: "applied", level: "success", messages: [] }, false);
  await ui.click();
  assert.deepEqual(ui.calls, ["GET /api/ui/desktop-sessions/plan"]);
  assert.equal(ui.notice.hidden, true);
});

test("Sync all sessions skips the confirmation while Desktop is open and shows the server's skip report", async () => {
  const ui = syncButton({ ...pendingPreview, desktop: "running" }, { status: "skipped", level: "warning", messages: ["Quit Claude Desktop, then click Sync all sessions again."] });
  await ui.click();
  assert.deepEqual(ui.prompts, []);
  assert.deepEqual(ui.calls, ["GET /api/ui/desktop-sessions/plan", "POST /api/ui/desktop-sessions/sync"]);
  assert.equal(ui.notice.className, "desktop-sync-report warning");
  assert.ok(ui.notice.textContent.includes("History sync skipped."));
});

test("Sync all sessions reports an already complete sync without writing", async () => {
  const ui = syncButton({ ...pendingPreview, changes: 0, messages: ["nothing to copy"] }, { status: "applied", level: "success", messages: [] });
  await ui.click();
  assert.deepEqual(ui.calls, ["GET /api/ui/desktop-sessions/plan"]);
  assert.ok(ui.notice.textContent.includes("Every account already lists every session."));
});
