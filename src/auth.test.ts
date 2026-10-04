import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile, lstat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ChatGPTSession, type SessionOptions } from "./auth.js";
import { BridgeError } from "./bridge.js";

const HOUR_MS = 3_600_000;

function jwt(expiresAtMs: number, accountId = "acct_1"): string {
  const encode = (value: object): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({ exp: Math.floor(expiresAtMs / 1000), "https://api.openai.com/auth": { chatgpt_account_id: accountId } })}.sig`;
}

type AuthFileOptions = { access: string; refresh: string; accountId?: string };

function authFile({ access, refresh, accountId }: AuthFileOptions): string {
  return JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: { id_token: "id-token", access_token: access, refresh_token: refresh, ...(accountId ? { account_id: accountId } : {}) },
    last_refresh: "2026-01-01T00:00:00.000Z",
  });
}

type FakeServer = {
  origin: string;
  refreshBodies: URLSearchParams[];
  onRefresh: (handler: (response: ServerResponse) => Promise<void> | void) => void;
  onModels: (handler: (response: ServerResponse) => void) => void;
  close: () => Promise<void>;
};

async function startFakeServer(): Promise<FakeServer> {
  const refreshBodies: URLSearchParams[] = [];
  let refreshHandler: (response: ServerResponse) => Promise<void> | void = (response) => { response.writeHead(500).end(); };
  let modelsHandler: (response: ServerResponse) => void = (response) => { response.writeHead(500).end(); };
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      if (request.method === "POST" && request.url === "/api/accounts/oauth/token") {
        refreshBodies.push(new URLSearchParams(Buffer.concat(chunks).toString("utf8")));
        void Promise.resolve(refreshHandler(response));
      } else if (request.method === "GET" && request.url?.startsWith("/backend/codex/models")) {
        modelsHandler(response);
      } else {
        response.writeHead(404).end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    refreshBodies,
    onRefresh: (handler) => { refreshHandler = handler; },
    onModels: (handler) => { modelsHandler = handler; },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

type Fixture = { dir: string; authPath: string; fake: FakeServer; options: SessionOptions };

async function withFixture(initial: AuthFileOptions | undefined, run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "codex2cc-auth-"));
  const fake = await startFakeServer();
  const authPath = join(dir, "auth.json");
  if (initial) await writeFile(authPath, authFile(initial), { mode: 0o600 });
  const options: SessionOptions = {
    authPath,
    modelsCachePath: join(dir, "models_cache.json"),
    authOrigin: fake.origin,
    backendOrigin: `${fake.origin}/backend`,
  };
  try {
    await run({ dir, authPath, fake, options });
  } finally {
    await fake.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function json(response: ServerResponse, status: number, body: object): void {
  response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
}

async function rejectsWithCode(promise: Promise<unknown>, status: number, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => error instanceof BridgeError && error.status === status && error.code === code);
}

test("open reads the Codex login and serves a valid token without any network call", async () => {
  const access = jwt(Date.now() + HOUR_MS);
  await withFixture({ access, refresh: "r1" }, async ({ options, fake }) => {
    const session = await ChatGPTSession.open(options);
    assert.equal(session.accountId(), "acct_1");
    assert.equal(await session.accessToken(), access);
    assert.equal(fake.refreshBodies.length, 0);
  });
});

test("open fails loudly for a missing file, a non-ChatGPT login, and a corrupt file", async () => {
  await withFixture(undefined, async ({ options, authPath }) => {
    await rejectsWithCode(ChatGPTSession.open(options), 401, "auth_required");
    await writeFile(authPath, JSON.stringify({ auth_mode: "apikey", tokens: { id_token: "a", access_token: "b", refresh_token: "c" } }));
    await rejectsWithCode(ChatGPTSession.open(options), 401, "auth_required");
    await writeFile(authPath, "{not json");
    await rejectsWithCode(ChatGPTSession.open(options), 500, "invalid_codex_auth");
  });
});

test("an expired token is refreshed and the rotated tokens are saved atomically with other fields intact", async () => {
  const fresh = jwt(Date.now() + HOUR_MS);
  await withFixture({ access: jwt(Date.now() - HOUR_MS), refresh: "r1" }, async ({ options, authPath, fake }) => {
    fake.onRefresh((response) => json(response, 200, { access_token: fresh, refresh_token: "r2" }));
    const session = await ChatGPTSession.open(options);
    assert.equal(await session.accessToken(), fresh);
    assert.equal(fake.refreshBodies.length, 1);
    assert.equal(fake.refreshBodies[0]!.get("grant_type"), "refresh_token");
    assert.equal(fake.refreshBodies[0]!.get("refresh_token"), "r1");

    const saved = JSON.parse(await readFile(authPath, "utf8")) as { OPENAI_API_KEY: unknown; tokens: Record<string, string>; last_refresh: string };
    assert.equal(saved.tokens.access_token, fresh);
    assert.equal(saved.tokens.refresh_token, "r2");
    assert.equal(saved.tokens.id_token, "id-token");
    assert.equal(saved.OPENAI_API_KEY, null);
    assert.notEqual(saved.last_refresh, "2026-01-01T00:00:00.000Z");
    assert.equal((await stat(authPath)).mode & 0o777, 0o600);
  });
});

test("concurrent callers share a single refresh request", async () => {
  const fresh = jwt(Date.now() + HOUR_MS);
  await withFixture({ access: jwt(Date.now() - HOUR_MS), refresh: "r1" }, async ({ options, fake }) => {
    fake.onRefresh(async (response) => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      json(response, 200, { access_token: fresh, refresh_token: "r2" });
    });
    const session = await ChatGPTSession.open(options);
    const tokens = await Promise.all([session.accessToken(), session.accessToken(), session.accessToken()]);
    assert.deepEqual(tokens, [fresh, fresh, fresh]);
    assert.equal(fake.refreshBodies.length, 1);
  });
});

test("tokens rotated on disk by another process are adopted without calling the auth server", async () => {
  const rotated = jwt(Date.now() + HOUR_MS);
  await withFixture({ access: jwt(Date.now() - HOUR_MS), refresh: "r1" }, async ({ options, authPath, fake }) => {
    const session = await ChatGPTSession.open(options);
    await writeFile(authPath, authFile({ access: rotated, refresh: "r2" }), { mode: 0o600 });
    assert.equal(await session.accessToken(), rotated);
    assert.equal(fake.refreshBodies.length, 0);
  });
});

test("a rejected refresh that lost a race to another process adopts the winner's tokens", async () => {
  const rotated = jwt(Date.now() + HOUR_MS);
  await withFixture({ access: jwt(Date.now() - HOUR_MS), refresh: "r1" }, async ({ options, authPath, fake }) => {
    fake.onRefresh(async (response) => {
      await writeFile(authPath, authFile({ access: rotated, refresh: "r2" }), { mode: 0o600 });
      json(response, 400, { error: "refresh_token_reused" });
    });
    const session = await ChatGPTSession.open(options);
    assert.equal(await session.accessToken(), rotated);
    assert.equal(fake.refreshBodies.length, 1);
  });
});

test("a rejected refresh with nothing rotated asks the user to log in again", async () => {
  await withFixture({ access: jwt(Date.now() - HOUR_MS), refresh: "r1" }, async ({ options, fake }) => {
    fake.onRefresh((response) => json(response, 400, { error: "invalid_grant" }));
    const session = await ChatGPTSession.open(options);
    await rejectsWithCode(session.accessToken(), 401, "refresh_failed");
  });
});

test("refreshAfterRejection returns a newer token when one exists and otherwise forces a refresh", async () => {
  const original = jwt(Date.now() + HOUR_MS, "acct_1");
  const refreshed = jwt(Date.now() + 2 * HOUR_MS, "acct_1");
  await withFixture({ access: original, refresh: "r1" }, async ({ options, fake }) => {
    fake.onRefresh((response) => json(response, 200, { access_token: refreshed, refresh_token: "r2" }));
    const session = await ChatGPTSession.open(options);
    assert.equal(await session.refreshAfterRejection("some-older-token"), original);
    assert.equal(fake.refreshBodies.length, 0);
    assert.equal(await session.refreshAfterRejection(original), refreshed);
    assert.equal(fake.refreshBodies.length, 1);
    assert.equal(await session.accessToken(), refreshed);
  });
});

test("listModels prefers the remote catalog, then the local cache, then built-in defaults", async () => {
  await withFixture({ access: jwt(Date.now() + HOUR_MS), refresh: "r1" }, async ({ options, dir, fake }) => {
    const session = await ChatGPTSession.open(options);

    fake.onModels((response) => json(response, 200, { models: [{ slug: "remote-model", display_name: "Remote", context_window: 272000 }] }));
    assert.deepEqual(await session.listModels(), [{ slug: "remote-model", displayName: "Remote", contextWindow: 272000 }]);

    fake.onModels((response) => json(response, 404, {}));
    await writeFile(join(dir, "models_cache.json"), JSON.stringify({ models: [{ slug: "cached-model", context_window: 180000 }] }));
    assert.deepEqual(await session.listModels(), [{ slug: "cached-model", displayName: "cached-model", contextWindow: 180000 }]);

    await writeFile(join(dir, "models_cache.json"), JSON.stringify({ models: [] }));
    const defaults = await session.listModels();
    assert.deepEqual(defaults.map((model) => model.slug), ["gpt-6-astra", "gpt-6-sol", "gpt-6.1-sol", "gpt-6-luna"]);
  });
});

test("a failed write-back never resurrects the consumed refresh token on the next refresh", async () => {
  const first = jwt(Date.now() + 1_000);
  const second = jwt(Date.now() + HOUR_MS);
  await withFixture({ access: jwt(Date.now() - HOUR_MS), refresh: "r1" }, async ({ options, dir, fake }) => {
    let call = 0;
    fake.onRefresh((response) => {
      call++;
      json(response, 200, call === 1 ? { access_token: first, refresh_token: "r2" } : { access_token: second, refresh_token: "r3" });
    });
    const session = await ChatGPTSession.open(options);
    await chmod(dir, 0o500);
    try {
      assert.equal(await session.accessToken(), first);
      assert.equal(await session.accessToken(), second);
    } finally {
      await chmod(dir, 0o700);
    }
    assert.deepEqual(fake.refreshBodies.map((body) => body.get("refresh_token")), ["r1", "r2"]);
  });
});

test("a Codex login switched to another account is refused instead of adopted or overwritten", async () => {
  await withFixture({ access: jwt(Date.now() - HOUR_MS, "acct_1"), refresh: "r1" }, async ({ options, authPath, fake }) => {
    const session = await ChatGPTSession.open(options);
    const other = authFile({ access: jwt(Date.now() + HOUR_MS, "acct_2"), refresh: "other-refresh" });
    await writeFile(authPath, other, { mode: 0o600 });
    await rejectsWithCode(session.accessToken(), 401, "account_changed");
    assert.equal(session.accountId(), "acct_1");
    assert.equal(fake.refreshBodies.length, 0);
    assert.equal(await readFile(authPath, "utf8"), other);
  });
});

test("refreshed tokens are written through a symlinked auth.json without replacing the link", async () => {
  const fresh = jwt(Date.now() + HOUR_MS);
  await withFixture(undefined, async ({ options, dir, fake }) => {
    const realDir = join(dir, "dotfiles");
    await mkdir(realDir);
    const realPath = join(realDir, "auth.json");
    await writeFile(realPath, authFile({ access: jwt(Date.now() - HOUR_MS), refresh: "r1" }), { mode: 0o600 });
    await symlink(realPath, options.authPath);
    fake.onRefresh((response) => json(response, 200, { access_token: fresh, refresh_token: "r2" }));
    const session = await ChatGPTSession.open(options);
    assert.equal(await session.accessToken(), fresh);
    assert.ok((await lstat(options.authPath)).isSymbolicLink());
    assert.equal((JSON.parse(await readFile(realPath, "utf8")) as { tokens: { refresh_token: string } }).tokens.refresh_token, "r2");
  });
});

test("persisting does not clobber tokens another process saved during the refresh", async () => {
  const fresh = jwt(Date.now() + HOUR_MS);
  const theirs = authFile({ access: jwt(Date.now() + 2 * HOUR_MS), refresh: "their-refresh" });
  await withFixture({ access: jwt(Date.now() - HOUR_MS), refresh: "r1" }, async ({ options, authPath, fake }) => {
    fake.onRefresh(async (response) => {
      await writeFile(authPath, theirs, { mode: 0o600 });
      json(response, 200, { access_token: fresh, refresh_token: "r2" });
    });
    const session = await ChatGPTSession.open(options);
    assert.equal(await session.accessToken(), fresh);
    assert.equal(await readFile(authPath, "utf8"), theirs);
  });
});

test("a refresh that loses a race waits briefly for the winner to save its tokens", async () => {
  const rotated = jwt(Date.now() + HOUR_MS);
  await withFixture({ access: jwt(Date.now() - HOUR_MS), refresh: "r1" }, async ({ options, authPath, fake }) => {
    fake.onRefresh((response) => {
      setTimeout(() => { void writeFile(authPath, authFile({ access: rotated, refresh: "r2" }), { mode: 0o600 }); }, 250);
      json(response, 400, { error: "refresh_token_reused" });
    });
    const session = await ChatGPTSession.open(options);
    assert.equal(await session.accessToken(), rotated);
  });
});

test("the single-use refresh request is never retried", async () => {
  await withFixture({ access: jwt(Date.now() - HOUR_MS), refresh: "r1" }, async ({ options, fake }) => {
    fake.onRefresh((response) => { response.writeHead(503).end(); });
    const session = await ChatGPTSession.open(options);
    await rejectsWithCode(session.accessToken(), 502, "refresh_failed");
    assert.equal(fake.refreshBodies.length, 1);
  });
});

test("a token refreshed moments ago is not refreshed again after another 401", async () => {
  const fresh = jwt(Date.now() + HOUR_MS);
  await withFixture({ access: jwt(Date.now() - HOUR_MS), refresh: "r1" }, async ({ options, fake }) => {
    fake.onRefresh((response) => json(response, 200, { access_token: fresh, refresh_token: "r2" }));
    const session = await ChatGPTSession.open(options);
    assert.equal(await session.accessToken(), fresh);
    await rejectsWithCode(session.refreshAfterRejection(fresh), 401, "token_rejected");
    assert.equal(fake.refreshBodies.length, 1);
  });
});

test("an unreadable auth file does not stop a refresh that the in-memory token can serve", async () => {
  const fresh = jwt(Date.now() + HOUR_MS);
  await withFixture({ access: jwt(Date.now() - HOUR_MS), refresh: "r1" }, async ({ options, authPath, fake }) => {
    fake.onRefresh((response) => json(response, 200, { access_token: fresh, refresh_token: "r2" }));
    const session = await ChatGPTSession.open(options);
    await writeFile(authPath, "{truncated");
    assert.equal(await session.accessToken(), fresh);
    assert.equal(fake.refreshBodies[0]!.get("refresh_token"), "r1");
  });
});
