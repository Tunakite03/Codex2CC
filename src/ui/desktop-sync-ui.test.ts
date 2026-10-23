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
