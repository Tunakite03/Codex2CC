import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { secrets, type SecretsOptions } from "just-secrets";
import { lock } from "proper-lockfile";
import { z } from "zod";
import { BridgeError } from "./bridge.js";

const KEY_NAME = { service: "Codex2CC", name: "credential-encryption-key" };
const AAD = Buffer.from("Codex2CC credentials v1", "utf8");
const Encoded = z.string().min(1).regex(/^[A-Za-z0-9_-]+$/);

export const TokenResponse = z.object({
  access_token: z.string().min(1), refresh_token: z.string().min(1),
  id_token: z.string().min(1), token_type: z.literal("Bearer"),
  expires_in: z.number().positive(), scope: z.string(),
  earliest_refresh_at: z.union([z.string(), z.number()]).optional(),
});
export type TokenResponse = z.infer<typeof TokenResponse>;

const SavedSession = z.object({
  clientId: z.string().min(1), subject: z.string().min(1),
  tokens: TokenResponse, expiresAt: z.number().int().positive(),
});
export type SavedSession = z.infer<typeof SavedSession>;

const EncryptedSession = z.object({
  version: z.literal(1), nonce: Encoded, ciphertext: Encoded, tag: Encoded,
});
type CredentialKeychain = {
  get(options: SecretsOptions): Promise<string | null>;
  set(options: SecretsOptions & { value: string }): Promise<void>;
};

function encryptionKey(encoded: string): Buffer {
  if (!/^[A-Za-z0-9_-]{43}$/.test(encoded)) throw new BridgeError(500, "invalid_keychain_key", "Codex2CC encryption key in the credential store has an invalid encoding.");
  const key = Buffer.from(encoded, "base64url");
  if (key.length !== 32) throw new BridgeError(500, "invalid_keychain_key", "Codex2CC encryption key in the credential store has an invalid length.");
  return key;
}

function decryptSession(raw: string, key: Buffer): SavedSession {
  let envelope: z.infer<typeof EncryptedSession>;
  try {
    envelope = EncryptedSession.parse(JSON.parse(raw));
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError) throw new BridgeError(500, "invalid_credential_file", "Codex2CC credential file has an invalid encrypted envelope.");
    throw error;
  }
  const nonce = Buffer.from(envelope.nonce, "base64url");
  const tag = Buffer.from(envelope.tag, "base64url");
  if (nonce.length !== 12 || tag.length !== 16) throw new BridgeError(500, "invalid_credential_file", "Codex2CC credential file has invalid encryption metadata.");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(AAD);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64url")), decipher.final()]);
    return SavedSession.parse(JSON.parse(plaintext.toString("utf8")));
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError) throw new BridgeError(500, "invalid_credential_file", "Codex2CC credential file decrypted to an invalid session.");
    throw new BridgeError(500, "credential_decryption_failed", "Codex2CC credential file could not be decrypted with the macOS Keychain key.");
  }
}

export class CredentialStore {
  constructor(private readonly directory: string, private readonly keychain: CredentialKeychain = secrets) {}

  async withLock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    const release = await lock(this.directory, {
      stale: 30_000, update: 10_000,
      retries: { retries: 900, factor: 1, minTimeout: 100, maxTimeout: 100 },
    });
    try { return await operation(); }
    finally { await release(); }
  }

  async load(): Promise<SavedSession | null> {
    let raw: string;
    try {
      raw = await readFile(join(this.directory, "credentials.enc"), "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    }
    const storedKey = await this.keychain.get(KEY_NAME);
    if (storedKey === null) throw new BridgeError(500, "missing_keychain_key", "Codex2CC credential file exists but its encryption key is missing from the macOS Keychain.");
    return decryptSession(raw, encryptionKey(storedKey));
  }

  async save(session: SavedSession): Promise<void> {
    const validated = SavedSession.parse(session);
    let storedKey = await this.keychain.get(KEY_NAME);
    if (storedKey === null) {
      storedKey = randomBytes(32).toString("base64url");
      await this.keychain.set({ ...KEY_NAME, value: storedKey });
    }
    const key = encryptionKey(storedKey);
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(AAD);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(validated), "utf8"), cipher.final()]);
    const envelope = { version: 1, nonce: nonce.toString("base64url"), ciphertext: ciphertext.toString("base64url"), tag: cipher.getAuthTag().toString("base64url") };
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    const temporary = join(this.directory, `credentials-${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(envelope));
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, join(this.directory, "credentials.enc"));
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
    await chmod(join(this.directory, "credentials.enc"), 0o600);
  }
}
