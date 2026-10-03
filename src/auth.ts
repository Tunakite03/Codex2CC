import { randomUUID } from "node:crypto";
import { open, readFile, rename, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { BridgeError } from "./bridge.js";
import { CredentialStore, TokenResponse, type TokenResponse as Tokens } from "./credentials.js";

const AUTH_ORIGIN = "https://auth.openai.com";
const CHATGPT_BACKEND_ORIGIN = "https://chatgpt.com/backend-api";
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_AUTH_PATH = join(homedir(), ".codex", "auth.json");
const CODEX_MODELS_CACHE_PATH = join(homedir(), ".codex", "models_cache.json");
const SETTINGS_DIRECTORY = join(homedir(), ".config", "codex2cc");
const credentialStore = new CredentialStore(SETTINGS_DIRECTORY);

const CodexAuthFile = z.object({
  auth_mode: z.string(),
  tokens: z.object({
    id_token: z.string().min(1),
    access_token: z.string().min(1),
    refresh_token: z.string().min(1),
    account_id: z.string().optional(),
  }),
  last_refresh: z.string().optional(),
});

const ModelsApiResponse = z.object({
  models: z.array(z.object({
    slug: z.string().min(1),
    display_name: z.string().optional(),
  })),
});

function warn(operation: string, attempt: number, status: number | string): void {
  process.stderr.write(`${JSON.stringify({ level: "warn", operation, attempt, status })}\n`);
}

async function fetchRetry(url: string, init: RequestInit, operation: string): Promise<Response> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
    } catch (error) {
      if (!(error instanceof TypeError) || attempt === 3) throw new BridgeError(502, "network_error", `${operation} failed because OpenAI was unreachable.`);
      warn(operation, attempt, "network_error");
      await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
      continue;
    }
    if ((response.status === 429 || response.status >= 500) && attempt < 3) {
      warn(operation, attempt, response.status);
      await response.body?.cancel();
      await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
      continue;
    }
    return response;
  }
  throw new BridgeError(502, "retry_exhausted", `${operation} failed after bounded retries.`);
}

function parseJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    const part = parts[1];
    if (!part) return null;
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function extractAccountId(accessToken: string, candidate?: string): string | undefined {
  if (candidate && candidate.length > 0) return candidate;
  const payload = parseJwtPayload(accessToken);
  if (!payload) return undefined;
  const authObj = payload["https://api.openai.com/auth"] as Record<string, unknown> | undefined;
  if (authObj && typeof authObj.chatgpt_account_id === "string") return authObj.chatgpt_account_id;
  if (typeof payload.chatgpt_account_id === "string") return payload.chatgpt_account_id;
  if (typeof payload.account_id === "string") return payload.account_id;
  return undefined;
}

function extractTokenExp(accessToken: string): number {
  const payload = parseJwtPayload(accessToken);
  if (payload && typeof payload.exp === "number") {
    return payload.exp * 1000;
  }
  return Date.now() + 3600_000;
}

export class ChatGPTSession {
  private pendingRefresh: Promise<string> | undefined;

  private constructor(
    private tokens: { access_token: string; refresh_token: string; id_token: string; account_id?: string | undefined },
    private accountIdValue: string,
    private expiresAt: number,
    private readonly isCodexAuth: boolean,
  ) {}

  accountId(): string {
    return this.accountIdValue;
  }

  static async open(): Promise<ChatGPTSession> {
    // 1. Prioritize ~/.codex/auth.json from official Codex CLI login
    try {
      const raw = await readFile(CODEX_AUTH_PATH, "utf8");
      const parsed = CodexAuthFile.parse(JSON.parse(raw));
      if (parsed.auth_mode === "chatgpt") {
        const accountId = extractAccountId(parsed.tokens.access_token, parsed.tokens.account_id);
        if (!accountId) {
          throw new BridgeError(500, "missing_account_id", "ChatGPT Account ID could not be resolved from ~/.codex/auth.json.");
        }
        const expiresAt = extractTokenExp(parsed.tokens.access_token);
        const session = new ChatGPTSession(parsed.tokens, accountId, expiresAt, true);
        return session;
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        process.stderr.write(`${JSON.stringify({ level: "warn", operation: "read_codex_auth", error: error instanceof Error ? error.message : String(error) })}\n`);
      }
    }

    // 2. Check saved credentials in CredentialStore
    const saved = await credentialStore.load();
    if (saved) {
      const accountId = extractAccountId(saved.tokens.access_token);
      if (accountId) {
        return new ChatGPTSession(saved.tokens, accountId, saved.expiresAt, false);
      }
    }

    throw new BridgeError(
      401,
      "auth_required",
      "No active ChatGPT Plus session found. Please run 'codex login' in your terminal to sign in to ChatGPT Plus via Codex CLI first.",
    );
  }

  async accessToken(): Promise<string> {
    if (Date.now() < this.expiresAt - 60_000) return this.tokens.access_token;
    if (this.pendingRefresh) return this.pendingRefresh;
    const pending = this.refreshAccessToken();
    this.pendingRefresh = pending;
    try { return await pending; }
    finally { if (this.pendingRefresh === pending) this.pendingRefresh = undefined; }
  }

  private async refreshAccessToken(): Promise<string> {
    if (this.isCodexAuth) {
      const body = new URLSearchParams({
        grant_type: "refresh_token",
        client_id: CODEX_CLIENT_ID,
        refresh_token: this.tokens.refresh_token,
      });
      const response = await fetchRetry(
        `${AUTH_ORIGIN}/api/accounts/oauth/token`,
        { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body },
        "Codex token refresh",
      );
      if (!response.ok) {
        throw new BridgeError(
          response.status === 401 || response.status === 400 ? 401 : 502,
          "refresh_failed",
          `ChatGPT token refresh returned HTTP ${response.status}. Please run 'codex login' in terminal to refresh.`,
        );
      }
      const data = await response.json();
      const updatedTokens = {
        access_token: data.access_token,
        refresh_token: data.refresh_token ?? this.tokens.refresh_token,
        id_token: data.id_token ?? this.tokens.id_token,
        account_id: this.accountIdValue,
      };
      this.tokens = updatedTokens;
      this.expiresAt = extractTokenExp(updatedTokens.access_token);

      // Persist refreshed tokens back to ~/.codex/auth.json
      try {
        const raw = await readFile(CODEX_AUTH_PATH, "utf8");
        const current = JSON.parse(raw);
        current.tokens = { ...current.tokens, ...updatedTokens };
        current.last_refresh = new Date().toISOString();
        const temporary = `${CODEX_AUTH_PATH}.${randomUUID()}.tmp`;
        const handle = await open(temporary, "wx", 0o600);
        try {
          await handle.writeFile(JSON.stringify(current, null, 2));
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temporary, CODEX_AUTH_PATH);
        await chmod(CODEX_AUTH_PATH, 0o600);
      } catch (err) {
        process.stderr.write(`Failed to update ~/.codex/auth.json: ${err instanceof Error ? err.message : String(err)}\n`);
      }

      return updatedTokens.access_token;
    }

    // Refresh via CredentialStore
    return credentialStore.withLock(async () => {
      const latest = await credentialStore.load();
      if (!latest) throw new BridgeError(500, "missing_saved_credentials", "ChatGPT credentials disappeared before token refresh.");
      if (latest.tokens.refresh_token !== this.tokens.refresh_token) {
        this.tokens = latest.tokens;
        this.expiresAt = latest.expiresAt;
        if (Date.now() < this.expiresAt - 60_000) return this.tokens.access_token;
      }
      const body = new URLSearchParams({
        grant_type: "refresh_token",
        client_id: latest.clientId,
        refresh_token: this.tokens.refresh_token,
      });
      const response = await fetchRetry(
        `${AUTH_ORIGIN}/api/accounts/oauth/token`,
        { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body },
        "OAuth token refresh",
      );
      if (!response.ok) {
        throw new BridgeError(401, "reauth_required", `ChatGPT token refresh returned HTTP ${response.status}.`);
      }
      const replacement = TokenResponse.parse(await response.json());
      this.tokens = replacement;
      this.expiresAt = Date.now() + replacement.expires_in * 1000;
      await credentialStore.save({ clientId: latest.clientId, subject: latest.subject, tokens: replacement, expiresAt: this.expiresAt });
      return replacement.access_token;
    });
  }

  async listModels(): Promise<Array<{ slug: string; displayName: string }>> {
    // 1. Try remote ChatGPT backend models catalog
    try {
      const url = `${CHATGPT_BACKEND_ORIGIN}/codex/models?client_version=0.159.0`;
      const response = await fetchRetry(
        url,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${await this.accessToken()}`,
            "ChatGPT-Account-Id": this.accountIdValue,
          },
        },
        "model discovery",
      );
      if (response.ok) {
        const parsed = ModelsApiResponse.safeParse(await response.json());
        if (parsed.success && parsed.data.models.length > 0) {
          return parsed.data.models.map((m) => ({
            slug: m.slug,
            displayName: m.display_name ?? m.slug,
          }));
        }
      }
    } catch (error) {
      process.stderr.write(`${JSON.stringify({ level: "warn", operation: "remote_model_discovery", message: error instanceof Error ? error.message : String(error) })}\n`);
    }

    // 2. Try local ~/.codex/models_cache.json
    try {
      const raw = await readFile(CODEX_MODELS_CACHE_PATH, "utf8");
      const cache = JSON.parse(raw);
      if (Array.isArray(cache.models)) {
        return cache.models.map((m: { slug: string; display_name?: string }) => ({
          slug: m.slug,
          displayName: m.display_name ?? m.slug,
        }));
      }
    } catch {
      // Fallback
    }

    // 3. Sensible defaults
    return [
      { slug: "gpt-6-sol", displayName: "GPT-6 Sol" },
      { slug: "gpt-6.1-sol", displayName: "GPT-6.1 Sol" },
      { slug: "gpt-5.6-sol", displayName: "GPT-5.6 Sol" },
    ];
  }
}
