import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { renderDashboardHtml } from "./ui.js";
import type { DesktopSyncReport } from "../config/desktop-sessions.js";

// The sync notice and its parts; its text reads the parts the way a person sees them.
function syncNotice() {
  const attributes = new Map<string, string>();
  const textPart = () => ({
    textContent: "",
    set innerHTML(_value: string) { assert.fail("sync messages must never be interpreted as HTML"); },
  });
  const title = textPart();
  const headline = textPart();
  const lines = textPart();
  const details = { hidden: false, open: true };
  const notice = {
    className: "", hidden: true,
    setAttribute: (key: string, value: string) => attributes.set(key, value),
    get textContent() { return [title.textContent, headline.textContent, lines.textContent].join("\n"); },
    set innerHTML(_value: string) { assert.fail("sync messages must never be interpreted as HTML"); },
  };
  const parts: Record<string, unknown> = {
    "desktop-sync-report": notice,
    "desktop-sync-title": title,
    "desktop-sync-headline": headline,
    "desktop-sync-lines": lines,
    "desktop-sync-details": details,
  };
  return { notice, attributes, title, headline, lines, details, part: (id: string) => parts[id] };
}

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
  const sync = syncNotice();
  const toasts: Array<{ message: string; type: string }> = [];
  let report = initialReport;
  const calls: string[] = [];
  runInNewContext(helper + apply + reset, {
    document: { getElementById: (id: string) => sync.part(id) ?? {
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
    ...sync, toasts, calls,
    setReport: (next: DesktopSyncReport | null) => { report = next; },
    click: async (id: string) => {
      const handler = listeners.get(id);
      assert.ok(handler, `missing click handler: ${id}`);
      await handler();
    },
  };
}

const reports: Array<{ report: DesktopSyncReport; summary: string }> = [
  { report: { status: "skipped", level: "warning", headline: "Claude Desktop is running. Quit it, then run: codex2cc --sync-desktop-sessions", messages: [] }, summary: "Session sync skipped." },
  { report: { status: "failed", level: "error", headline: "Access denied.", messages: ["Changes before failure are in backup.json."] }, summary: "Session sync failed." },
  { report: { status: "applied", level: "warning", headline: "No sessions needed copying. 1 account(s) have no session list yet.", messages: ["No destination scope; open Desktop once, then quit and rerun."] }, summary: "Session sync needs attention." },
  { report: { status: "applied", level: "success", headline: "Copied 2 session(s) across 1 account(s).", messages: ["A -> B: copied 2 session(s).", "Changes are listed in m.json."] }, summary: "Session sync completed." },
];

for (const action of ["btn-apply", "btn-reset-desktop", "btn-reset-all"]) {
  for (const { report, summary } of reports) {
    test(`${action} shows ${report.status}/${report.level} separately from configuration success`, async () => {
      const ui = dashboardActions(report);
      await ui.click(action);
      assert.deepEqual(ui.calls, [action === "btn-apply" ? "/api/ui/setup" : "/api/ui/reset"]);
      assert.equal(ui.notice.hidden, false);
      assert.equal(ui.notice.className, "desktop-sync-report " + report.level);
      assert.equal(ui.title.textContent, summary);
      assert.equal(ui.headline.textContent, report.headline);
      assert.equal(ui.lines.textContent, report.messages.join("\n"), "details stay one line per message");
      assert.equal(ui.details.hidden, report.messages.length === 0);
      assert.equal(ui.details.open, false, "details start collapsed so the headline is the main point");
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
  assert.ok(!ui.notice.textContent.includes("Quit it"));
});

test("sync error messages render as text rather than HTML", async () => {
  const message = '<img src=x onerror="alert(1)">';
  const ui = dashboardActions({ status: "failed", level: "error", headline: message, messages: [message] });
  await ui.click("btn-apply");
  assert.ok(ui.notice.textContent.includes(message));
});

test("CLI-only setup with no sync report retains the existing success notification", async () => {
  const ui = dashboardActions(null);
  await ui.click("btn-apply");
  assert.equal(ui.notice.hidden, true);
  assert.deepEqual(ui.toasts, [{ message: "Configuration applied successfully!", type: "success" }]);
});

test("persistent sync feedback sits after every tab panel so reset warnings remain visible in Advanced", () => {
  const html = renderDashboardHtml();
  const report = html.indexOf('id="desktop-sync-report"');
  const lastPanel = html.indexOf('id="tab-advanced"');
  assert.ok(lastPanel > 0);
  assert.ok(report > html.indexOf("</details>", lastPanel));
  assert.ok(report < html.indexOf("</main>"));
  assert.equal(html.match(/id="desktop-sync-report"/g)?.length, 1);
});

// The Sync all sessions button previews both modes in a dialog, sends the chosen one, and lets the server skip while Desktop is open.
function syncButton(preview: Record<string, unknown>, report: DesktopSyncReport) {
  const script = renderDashboardHtml().match(/<script>([\s\S]*?)<\/script>/i)?.[1] ?? "";
  const cut = (start: string, end: string) => script.slice(script.indexOf(start), script.indexOf(end, script.indexOf(start)));
  const code = cut("function showConfigurationResult(", "/* Tab Controller */")
    + cut("/* Every Desktop account gets every session", 'document.getElementById("btn-apply").addEventListener');
  const listeners = new Map<string, (event?: { preventDefault: () => void }) => unknown>();
  const element = (id: string, fields: Record<string, unknown> = {}) => ({
    ...fields,
    addEventListener: (event: string, callback: () => unknown) => listeners.set(`${id}:${event}`, callback),
  });
  const dialog = {
    ...element("session-sync-dialog"),
    open: false,
    showModal() { dialog.open = true; },
    close() { dialog.open = false; },
  };
  const elements: Record<string, Record<string, unknown>> = {
    "btn-sync-sessions": element("btn-sync-sessions"),
    "session-sync-dialog": dialog,
    "session-sync-mode-add_only": element("session-sync-mode-add_only", { checked: true }),
    "session-sync-mode-mirror_newest": element("session-sync-mode-mirror_newest", { checked: false }),
    "session-sync-summary-add_only": { textContent: "" },
    "session-sync-summary-mirror_newest": { textContent: "" },
    "session-sync-source": { textContent: "" },
    "session-sync-desktop": { hidden: true },
    "session-sync-error": { hidden: true, textContent: "" },
    "btn-cancel-session-sync": element("btn-cancel-session-sync"),
    "btn-confirm-session-sync": element("btn-confirm-session-sync", { disabled: false, className: "", textContent: "" }),
  };
  const sync = syncNotice();
  const calls: string[] = [];
  const bodies: unknown[] = [];
  const toasts: Array<{ message: string; type: string }> = [];
  runInNewContext(code, {
    document: { getElementById: (id: string) => sync.part(id) ?? elements[id] ?? assert.fail(`unexpected element ${id}`) },
    showToast: (message: string, type = "success") => toasts.push({ message, type }),
    fetch: async (url: string, init?: { method?: string; body?: string }) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (init?.body !== undefined) bodies.push(JSON.parse(init.body));
      return { json: async () => url.endsWith("/plan") ? { ok: true, ...preview } : { ok: true, desktopSessionSync: report } };
    },
  });
  const fire = async (key: string) => { const callback = listeners.get(key); assert.ok(callback, `missing handler ${key}`); await callback({ preventDefault: () => {} }); };
  const choose = async (mode: "add_only" | "mirror_newest") => {
    elements["session-sync-mode-add_only"]!.checked = mode === "add_only";
    elements["session-sync-mode-mirror_newest"]!.checked = mode === "mirror_newest";
    await fire(`session-sync-mode-${mode}:change`);
  };
  return {
    ...sync, calls, bodies, toasts, dialog, elements, choose,
    click: () => fire("btn-sync-sessions:click"),
    confirm: () => fire("btn-confirm-session-sync:click"),
    cancel: () => fire("btn-cancel-session-sync:click"),
  };
}

const modePreview = (changes: number, headline: string) => ({ changes, level: "success", headline, messages: [`A -> B: ${headline}`] });
const pendingPreview = {
  desktop: "not_running",
  modes: {
    add_only: modePreview(2, "Would copy 2 session(s) across 1 account(s)."),
    mirror_newest: { ...modePreview(3, "Would copy 1 session(s) and would remove 2 across 1 account(s)."), source: "Claude-3p (gateway) [gw/org]" },
  },
};
const copied: DesktopSyncReport = { status: "applied", level: "success", headline: "Copied 2 session(s) across 1 account(s).", messages: ["A -> B: copied 2 session(s)."] };

test("Sync all sessions previews both modes and sends add only by default", async () => {
  const ui = syncButton(pendingPreview, copied);
  await ui.click();
  assert.deepEqual(ui.calls, ["GET /api/ui/desktop-sessions/plan"]);
  assert.equal(ui.dialog.open, true);
  assert.equal(ui.elements["session-sync-summary-add_only"]!.textContent, "Would copy 2 session(s) across 1 account(s).");
  assert.equal(ui.elements["session-sync-summary-mirror_newest"]!.textContent, "Would copy 1 session(s) and would remove 2 across 1 account(s).");
  assert.equal(ui.elements["session-sync-source"]!.textContent, " (Claude-3p (gateway) [gw/org])");
  assert.equal(ui.elements["session-sync-desktop"]!.hidden, true);
  assert.equal(ui.elements["btn-confirm-session-sync"]!.className, "btn btn-primary");
  await ui.confirm();
  assert.deepEqual(ui.calls, ["GET /api/ui/desktop-sessions/plan", "POST /api/ui/desktop-sessions/sync"]);
  assert.deepEqual(ui.bodies, [{ mode: "add_only" }]);
  assert.equal(ui.dialog.open, false);
  assert.equal(ui.headline.textContent, "Copied 2 session(s) across 1 account(s).");
  assert.deepEqual(ui.toasts, [{ message: "Session sync completed.", type: "success" }]);
});

test("Choosing to mirror the newest list marks the action destructive and sends that mode", async () => {
  const ui = syncButton(pendingPreview, copied);
  await ui.click();
  await ui.choose("mirror_newest");
  assert.equal(ui.elements["btn-confirm-session-sync"]!.className, "btn btn-danger");
  await ui.confirm();
  assert.deepEqual(ui.bodies, [{ mode: "mirror_newest" }]);
});

test("Cancelling the dialog syncs nothing", async () => {
  const ui = syncButton(pendingPreview, copied);
  await ui.click();
  await ui.cancel();
  assert.equal(ui.dialog.open, false);
  assert.deepEqual(ui.calls, ["GET /api/ui/desktop-sessions/plan"]);
  assert.equal(ui.notice.hidden, true);
});

test("A mode with nothing to change cannot run", async () => {
  const ui = syncButton({ ...pendingPreview, modes: { ...pendingPreview.modes, add_only: modePreview(0, "No sessions needed copying.") } }, copied);
  await ui.click();
  assert.equal(ui.elements["btn-confirm-session-sync"]!.disabled, true);
  await ui.choose("mirror_newest");
  assert.equal(ui.elements["btn-confirm-session-sync"]!.disabled, false);
});

test("Sync all sessions warns while Desktop is open and shows the server's skip report", async () => {
  const ui = syncButton({ ...pendingPreview, desktop: "running" }, { status: "skipped", level: "warning", headline: "Claude Desktop is running. Quit it, then click Sync all sessions again. 2 session(s) waiting to copy.", messages: ["A -> B: would copy 2 session(s)."] });
  await ui.click();
  assert.equal(ui.elements["session-sync-desktop"]!.hidden, false);
  await ui.confirm();
  assert.deepEqual(ui.calls, ["GET /api/ui/desktop-sessions/plan", "POST /api/ui/desktop-sessions/sync"]);
  assert.equal(ui.notice.className, "desktop-sync-report warning");
  assert.equal(ui.title.textContent, "Session sync skipped.");
  assert.match(ui.headline.textContent, /2 session\(s\) waiting to copy\.$/);
});

test("Sync all sessions reports an already complete sync without opening the dialog", async () => {
  const none = modePreview(0, "No sessions needed copying.");
  const ui = syncButton({ desktop: "not_running", modes: { add_only: none, mirror_newest: { ...none, source: null } } }, copied);
  await ui.click();
  assert.deepEqual(ui.calls, ["GET /api/ui/desktop-sessions/plan"]);
  assert.equal(ui.dialog.open, false);
  assert.equal(ui.headline.textContent, "No sessions needed copying.");
});
