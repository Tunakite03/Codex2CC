import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext, Script } from 'node:vm';
import { renderDashboardHtml } from './ui.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

type Reply = { ok: boolean; status: number; json: () => Promise<unknown> };
const reply = (data: unknown = { ok: true }, status = 200): Reply => ({
  ok: status >= 200 && status < 300, status, json: async () => data,
});
type Listener = (event: { preventDefault(): void }) => unknown;

function usageUi() {
  const html = renderDashboardHtml();
  const script = html.match(/<script>([\s\S]*?)<\/script>/i)?.[1];
  assert.ok(script);
  new Script(script); // Validate the whole emitted script, including template escaping.
  function section(start: string, end: string) {
    const from = script!.indexOf(start);
    const to = script!.indexOf(end, from);
    assert.ok(from >= 0 && to > from, `Missing section: ${start}`);
    return script!.slice(from, to);
  }
  class Element {
    textContent = '';
    disabled = false;
    hidden = true;
    open = false;
    focused = false;
    dataset: Record<string, string> = {};
    attributes = new Map<string, string>();
    listeners = new Map<string, Listener>();
    setAttribute(name: string, value: string) { this.attributes.set(name, value); }
    addEventListener(name: string, listener: Listener) { this.listeners.set(name, listener); }
    showModal() { this.open = true; }
    close() { this.open = false; this.listeners.get('close')?.({ preventDefault() {} }); }
    focus() { this.focused = true; }
  }
  const elements = new Map<string, Element>();
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id)!;
  };
  const requests: Array<{ url: string; options: { method?: string; signal: AbortSignal }; result: ReturnType<typeof deferred<Reply>> }> = [];
  const rendered: unknown[] = [];
  const toasts: Array<{ message: string; type: string }> = [];
  const timeouts: number[] = [];
  const api = runInNewContext(
    section('    let usageRequest =', '    let cachedLimits =') +
    section('    function setupUsageControls()', '    setupTabs();') +
    section('    async function switchProvider(', '    document.getElementById("btn-provider-codex")') +
    'setupUsageControls(); ({ fetchUsage, switchProvider });',
    {
      document: { getElementById: element },
      fetchStatus: async () => {},
      providerLabels: { openai: 'OpenAI' },
      AbortSignal: { timeout: (ms: number) => { timeouts.push(ms); return new AbortController().signal; } },
      fetch: (url: string, options: { method?: string; signal: AbortSignal }) => {
        const result = deferred<Reply>();
        requests.push({ url, options, result });
        return result.promise;
      },
      renderUsage: (data: unknown) => rendered.push(data),
      showToast: (message: string, type = 'success') => toasts.push({ message, type }),
    },
  ) as { fetchUsage(refresh?: boolean): Promise<boolean>; switchProvider(provider: string): Promise<void> };
  return {
    ...api, html, element, requests, rendered, toasts, timeouts,
    fire: (id: string, name = 'click') => {
      let prevented = false;
      const result = element(id).listeners.get(name)?.({ preventDefault() { prevented = true; } });
      return { result, prevented };
    },
  };
}

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test('rapid refresh calls share one request and remain busy until JSON is rendered', async () => {
  const ui = usageUi();
  const first = ui.fetchUsage(true);
  for (let i = 0; i < 20; i++) assert.equal(ui.fetchUsage(true), first);
  assert.equal(ui.fetchUsage(), first, 'tab activation joins the same request');
  assert.equal(ui.element('btn-refresh-usage').disabled, true);
  assert.equal(ui.element('btn-refresh-usage').attributes.get('aria-busy'), 'true');
  assert.equal(ui.element('usage-refresh-label').textContent, 'Refreshing…');
  assert.equal(ui.element('btn-reset-usage').disabled, true);
  ui.fire('btn-reset-usage');
  assert.equal(ui.element('usage-reset-dialog').open, false);
  await tick();
  assert.equal(ui.requests.length, 1);
  assert.equal(ui.requests[0]!.url, '/api/ui/usage?refresh=true');
  const body = deferred<unknown>();
  ui.requests[0]!.result.resolve({ ok: true, status: 200, json: () => body.promise });
  await tick();
  assert.equal(ui.element('btn-refresh-usage').disabled, true);
  body.resolve({ grandTotalTokens: 123 });
  assert.equal(await first, true);
  assert.deepEqual(ui.rendered, [{ grandTotalTokens: 123 }]);
  assert.equal(ui.element('btn-refresh-usage').disabled, false);
  assert.equal(ui.element('btn-refresh-usage').attributes.get('aria-busy'), 'false');
  assert.equal(ui.element('usage-refresh-label').textContent, 'Refresh');
  assert.match(ui.element('usage-feedback').textContent, /^Updated at /);
  const retry = ui.fire('btn-refresh-usage').result;
  await tick();
  assert.equal(ui.requests.length, 2);
  ui.requests[1]!.result.resolve(reply({ grandTotalTokens: 456 }));
  await retry;
  assert.deepEqual(ui.timeouts, [20000, 20000]);
});

for (const failure of ['http', 'network', 'json', 'timeout']) {
  test(`refresh ${failure} failure restores controls and allows retry`, async () => {
    const ui = usageUi();
    const pending = ui.fetchUsage(true);
    await tick();
    if (failure === 'http') ui.requests[0]!.result.resolve(reply({}, 503));
    if (failure === 'network') ui.requests[0]!.result.reject(new Error('Offline'));
    if (failure === 'json') ui.requests[0]!.result.resolve({ ok: true, status: 200, json: async () => { throw new Error('Invalid JSON'); } });
    if (failure === 'timeout') ui.requests[0]!.result.reject(Object.assign(new Error('Timed out'), { name: 'TimeoutError' }));
    assert.equal(await pending, false);
    assert.equal(ui.element('btn-refresh-usage').disabled, false);
    assert.equal(ui.element('btn-reset-usage').disabled, false);
    assert.equal(ui.element('usage-feedback').dataset.state, 'error');
    assert.equal(ui.toasts.at(-1)?.type, 'error');
    assert.equal(ui.rendered.length, 0, 'existing data is not cleared on failure');
    const retry = ui.fetchUsage(true);
    await tick();
    ui.requests[1]!.result.resolve(reply({ grandTotalTokens: 1 }));
    assert.equal(await retry, true);
    assert.equal(ui.element('usage-feedback').dataset.state, 'idle');
  });
}

test('reset requires a dialog confirmation; Cancel and Escape do not send requests', () => {
  const ui = usageUi();
  ui.fire('btn-confirm-reset-usage');
  assert.equal(ui.requests.length, 0);
  ui.fire('btn-reset-usage');
  assert.equal(ui.element('usage-reset-dialog').open, true);
  assert.equal(ui.requests.length, 0);
  assert.equal(ui.fire('usage-reset-dialog', 'cancel').prevented, false);
  ui.fire('btn-cancel-reset-usage');
  assert.equal(ui.element('usage-reset-dialog').open, false);
  assert.equal(ui.element('btn-reset-usage').focused, true);
  assert.equal(ui.requests.length, 0);
  assert.match(ui.html, /<dialog[^>]+aria-labelledby="usage-reset-title"/);
  assert.match(ui.html, /id="btn-cancel-reset-usage"[^>]+autofocus/);
  assert.match(ui.html, /account quotas, provider billing, and client settings/);
  assert.match(ui.html, /prefers-reduced-motion: reduce/);
  assert.match(ui.html, /\.usage-refresh-icon, \.usage-reset-icon \{ animation: none !important; \}/);
});

test('double confirmation sends one reset and blocks overlapping refresh until completion', async () => {
  const ui = usageUi();
  ui.fire('btn-reset-usage');
  const pending = ui.fire('btn-confirm-reset-usage').result;
  ui.fire('btn-confirm-reset-usage');
  assert.equal(ui.requests.length, 1);
  assert.equal(ui.requests[0]!.url, '/api/ui/usage/reset');
  assert.equal(ui.requests[0]!.options.method, 'POST');
  assert.equal(ui.element('btn-confirm-reset-usage').disabled, true);
  assert.equal(ui.element('btn-confirm-reset-usage').attributes.get('aria-busy'), 'true');
  assert.equal(ui.element('usage-reset-label').textContent, 'Resetting…');
  assert.equal(ui.element('btn-cancel-reset-usage').disabled, true);
  assert.equal(ui.fire('usage-reset-dialog', 'cancel').prevented, true);
  ui.fire('btn-cancel-reset-usage');
  assert.equal(ui.element('usage-reset-dialog').open, true);
  assert.equal(await ui.fetchUsage(true), false);
  assert.equal(ui.requests.length, 1);
  ui.requests[0]!.result.resolve(reply());
  await tick();
  assert.equal(ui.element('usage-reset-dialog').open, false);
  assert.equal(ui.requests.length, 2);
  assert.equal(ui.requests[1]!.url, '/api/ui/usage');
  assert.equal(ui.element('btn-refresh-usage').disabled, true);
  ui.requests[1]!.result.resolve(reply({ grandTotalTokens: 0 }));
  await pending;
  assert.deepEqual(ui.rendered, [{ grandTotalTokens: 0 }]);
  assert.equal(ui.element('btn-reset-usage').disabled, false);
  assert.equal(ui.element('btn-reset-usage').focused, true);
  assert.equal(ui.toasts[0]?.message, 'Token usage counters reset.');
});

for (const failure of ['http', 'network', 'json', 'application', 'timeout']) {
  test(`reset ${failure} failure stays in dialog and never announces success`, async () => {
    const ui = usageUi();
    ui.fire('btn-reset-usage');
    const pending = ui.fire('btn-confirm-reset-usage').result;
    if (failure === 'http') ui.requests[0]!.result.resolve(reply({}, 500));
    if (failure === 'network') ui.requests[0]!.result.reject(new Error('Offline'));
    if (failure === 'json') ui.requests[0]!.result.resolve({ ok: true, status: 200, json: async () => { throw new Error('Invalid JSON'); } });
    if (failure === 'application') ui.requests[0]!.result.resolve(reply({ ok: false, error: 'Not permitted' }));
    if (failure === 'timeout') ui.requests[0]!.result.reject(Object.assign(new Error('Timed out'), { name: 'TimeoutError' }));
    await pending;
    assert.equal(ui.element('usage-reset-dialog').open, true);
    assert.equal(ui.element('usage-reset-error').hidden, false);
    assert.match(ui.element('usage-reset-error').textContent, /Could not confirm the reset/);
    assert.equal(ui.element('btn-confirm-reset-usage').disabled, false);
    assert.equal(ui.element('btn-cancel-reset-usage').disabled, false);
    assert.equal(ui.element('btn-confirm-reset-usage').attributes.get('aria-busy'), 'false');
    assert.equal(ui.toasts.length, 0);
    assert.equal(ui.requests.length, 1);
    ui.fire('btn-cancel-reset-usage');
    ui.fire('btn-reset-usage');
    assert.equal(ui.element('usage-reset-error').hidden, true);
  });
}

test('a background read prevents confirming reset until the read finishes', async () => {
  const ui = usageUi();
  ui.fire('btn-reset-usage');
  const read = ui.fetchUsage();
  ui.fire('btn-confirm-reset-usage');
  await tick();
  assert.equal(ui.requests.length, 1);
  assert.equal(ui.requests[0]!.url, '/api/ui/usage');
  assert.equal(ui.element('btn-confirm-reset-usage').disabled, true);
  ui.requests[0]!.result.resolve(reply({ grandTotalTokens: 50 }));
  await read;
  assert.equal(ui.element('btn-confirm-reset-usage').disabled, false);
});

test('provider switch waits for an old read then requests fresh provider usage', async () => {
  const ui = usageUi();
  const oldRead = ui.fetchUsage();
  await tick();
  const switching = ui.switchProvider('openai');
  assert.equal(ui.requests[1]!.url, '/api/ui/provider');
  ui.requests[1]!.result.resolve(reply());
  await tick();
  assert.equal(ui.requests.length, 2, 'new read waits for the old request');
  ui.requests[0]!.result.resolve(reply({ provider: 'codex' }));
  await oldRead;
  await tick();
  assert.equal(ui.requests.length, 3);
  assert.equal(ui.requests[2]!.url, '/api/ui/usage?refresh=true');
  ui.requests[2]!.result.resolve(reply({ provider: 'openai' }));
  await switching;
  assert.deepEqual(ui.rendered.at(-1), { provider: 'openai' });
});
