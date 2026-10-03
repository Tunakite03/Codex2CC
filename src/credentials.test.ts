import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CredentialStore, type SavedSession } from "./credentials.js";

test("credentials survive a new store instance and rotated tokens replace the saved session", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "codex2cc-credentials-"));
  context.after(async () => { const { rm } = await import("node:fs/promises"); await rm(directory, { recursive: true, force: true }); });
  let key: string | null = null;
  const keychain = {
    async get(): Promise<string | null> { return key; },
    async set(options: { value: string }): Promise<void> { key = options.value; },
  };
  const first = new CredentialStore(directory, keychain);
  const saved: SavedSession = {
    clientId: "client-id", subject: "subject-id", expiresAt: Date.now() + 3_600_000,
    tokens: { access_token: "access-secret", refresh_token: "refresh-secret", id_token: "identity-secret", token_type: "Bearer", expires_in: 3600, scope: "offline_access chatgpt.tokens.use.direct" },
  };
  assert.equal(await first.load(), null);
  await first.save(saved);
  const file = await readFile(join(directory, "credentials.enc"), "utf8");
  assert.equal(file.includes("refresh-secret"), false);
  assert.equal(file.includes("access-secret"), false);
  assert.equal((await stat(join(directory, "credentials.enc"))).mode & 0o777, 0o600);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  const second = new CredentialStore(directory, keychain);
  assert.deepEqual(await second.load(), saved);
  const rotated: SavedSession = { ...saved, tokens: { ...saved.tokens, refresh_token: "rotated-refresh-secret" } };
  await second.save(rotated);
  assert.deepEqual(await first.load(), rotated);
  assert.equal((await keychain.get())?.length, 43);
  const tampered = JSON.parse(file) as { version: number; nonce: string; ciphertext: string; tag: string };
  tampered.ciphertext = `${tampered.ciphertext[0] === "A" ? "B" : "A"}${tampered.ciphertext.slice(1)}`;
  await writeFile(join(directory, "credentials.enc"), JSON.stringify(tampered));
  await assert.rejects(first.load(), { code: "credential_decryption_failed" });
});

test("credential refresh lock serializes separate store instances", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "codex2cc-lock-"));
  context.after(async () => { const { rm } = await import("node:fs/promises"); await rm(directory, { recursive: true, force: true }); });
  const first = new CredentialStore(directory);
  const second = new CredentialStore(directory);
  let active = 0;
  let maximumActive = 0;
  const lockedOperation = async (store: CredentialStore): Promise<void> => store.withLock(async () => {
    active++;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 50));
    active--;
  });
  await Promise.all([lockedOperation(first), lockedOperation(second)]);
  assert.equal(maximumActive, 1);
});
