import { randomUUID } from "node:crypto";
import { chmod, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { BridgeError } from "../bridge/bridge.js";

const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_CLIENT_VERSION = "0.159.0";
const REFRESH_MARGIN_MS = 60_000;
const FRESH_TOKEN_WINDOW_MS = 30_000;
const LOST_RACE_POLLS = 5;
const LOST_RACE_POLL_INTERVAL_MS = 150;

export type SessionOptions = {
  readonly authPath: string;
  readonly modelsCachePath: string;
  readonly authOrigin: string;
  readonly backendOrigin: string;
};

export function defaultSessionOptions(): SessionOptions {
  return {
    authPath: join(homedir(), ".codex", "auth.json"),
    modelsCachePath: join(homedir(), ".codex", "models_cache.json"),
    authOrigin: "https://auth.openai.com",
    backendOrigin: "https://chatgpt.com/backend-api",
  };
}

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

const RefreshResponse = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  id_token: z.string().min(1).optional(),
});

const ModelsApiResponse = z.object({
  models: z.array(z.object({
    slug: z.string().min(1),
    display_name: z.string().optional(),
    context_window: z.number().int().positive().optional(),
  })),
});

export type UsageWindowLimit = {
  readonly usedPercent: number;
  readonly remainingPercent: number;
  readonly limitWindowSeconds: number;
  readonly resetAfterSeconds: number;
  readonly resetAt: number;
};

export type AccountUsageLimits = {
  readonly planType: string;
  readonly allowed: boolean;
  readonly limitReached: boolean;
  readonly primaryWindow: UsageWindowLimit | null;
  readonly secondaryWindow: UsageWindowLimit | null;
  readonly lastUpdated: string;
};

const WhamUsageWindowSchema = z.object({
  used_percent: z.number(),
  limit_window_seconds: z.number().int().nonnegative().optional(),
  reset_after_seconds: z.number().int().nonnegative().optional(),
  reset_at: z.number().int().nonnegative().optional(),
}).passthrough();

const WhamUsageResponseSchema = z.object({
  plan_type: z.string().optional(),
  rate_limit: z.object({
    allowed: z.boolean().optional(),
    limit_reached: z.boolean().optional(),
    primary_window: WhamUsageWindowSchema.nullable().optional(),
    secondary_window: WhamUsageWindowSchema.nullable().optional(),
  }).passthrough().optional(),
}).passthrough();

type Tokens = { access_token: string; refresh_token: string; id_token: string; account_id?: string | undefined };
type AuthDocument = { readonly document: Record<string, unknown>; readonly tokens: Tokens };

function isErrnoException(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function warn(operation: string, detail: Record<string, unknown>): void {
  process.stderr.write(`${JSON.stringify({ level: "warn", operation, ...detail })}\n`);
}

async function fetchRetry(url: string, init: RequestInit, operation: string): Promise<Response> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
    } catch (error) {
      if (!(error instanceof TypeError) || attempt === 3) throw new BridgeError(502, "network_error", `${operation} failed because OpenAI was unreachable.`);
      warn(operation, { attempt, status: "network_error" });
      await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
      continue;
    }
    if ((response.status === 429 || response.status >= 500) && attempt < 3) {
      warn(operation, { attempt, status: response.status });
      await response.body?.cancel();
      await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
      continue;
    }
    return response;
  }
  throw new BridgeError(502, "retry_exhausted", `${operation} failed after bounded retries.`);
}

/** One attempt, no retry: refresh tokens are single-use, so resending a possibly-consumed token only makes things worse. */
async function fetchOnce(url: string, init: RequestInit, operation: string): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  } catch (error) {
    if (error instanceof TypeError || error instanceof DOMException) {
      throw new BridgeError(502, "network_error", `${operation} failed because OpenAI was unreachable. If requests are then rejected, run 'codex login'.`);
    }
    throw error;
  }
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

async function readAuthFile(path: string): Promise<AuthDocument> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isErrnoException(error, "ENOENT")) {
      throw new BridgeError(401, "auth_required", `No Codex login found at ${path}. Run 'codex login' in your terminal to sign in with ChatGPT first.`);
    }
    throw error;
  }
  try {
    const json: unknown = JSON.parse(raw);
    const document = z.record(z.string(), z.unknown()).parse(json);
    const parsed = CodexAuthFile.parse(json);
    if (parsed.auth_mode !== "chatgpt") {
      throw new BridgeError(401, "auth_required", `${path} uses auth_mode "${parsed.auth_mode}". Run 'codex login' and sign in with ChatGPT.`);
    }
    return { document, tokens: parsed.tokens };
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof z.ZodError) {
      throw new BridgeError(500, "invalid_codex_auth", `${path} is not a valid Codex auth file.`);
    }
    throw error;
  }
}

async function writeFileAtomic(path: string, content: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  await chmod(path, 0o600);
}

/**
 * A ChatGPT session backed by the Codex CLI login in ~/.codex/auth.json. Refresh tokens are
 * single-use and Codex CLI (or another Codex2CC process) may rotate them, so the file is the source
 * of truth for tokens this process has never seen: it is re-read before and after a refresh to adopt
 * them, but a refresh token this process already held is never adopted again, so a failed write-back
 * cannot resurrect a consumed token.
 */
export class ChatGPTSession {
  private pendingRefresh: Promise<string> | undefined;
  private readonly seenRefreshTokens = new Set<string>();
  private lastRefreshAt: number | undefined;
  private cachedLimits: { limits: AccountUsageLimits; fetchedAt: number } | null = null;

  private constructor(
    private readonly options: SessionOptions,
    private tokens: Tokens,
    private readonly accountIdValue: string,
    private expiresAt: number,
  ) {
    this.seenRefreshTokens.add(tokens.refresh_token);
  }

  accountId(): string {
    return this.accountIdValue;
  }

  static async open(options: SessionOptions = defaultSessionOptions()): Promise<ChatGPTSession> {
    const { tokens } = await readAuthFile(options.authPath);
    const accountId = extractAccountId(tokens.access_token, tokens.account_id);
    if (!accountId) {
      throw new BridgeError(500, "missing_account_id", `ChatGPT Account ID could not be resolved from ${options.authPath}.`);
    }
    return new ChatGPTSession(options, tokens, accountId, extractTokenExp(tokens.access_token));
  }

  async accessToken(): Promise<string> {
    if (Date.now() < this.expiresAt - REFRESH_MARGIN_MS) return this.tokens.access_token;
    return this.refreshDeduplicated();
  }

  /**
   * Called when upstream rejected `rejected` with 401. Returns a different valid token when one
   * is already available, otherwise refreshes. A token refreshed moments ago is not refreshed
   * again: that would burn a rotation per request when 401 has another cause.
   */
  async refreshAfterRejection(rejected: string): Promise<string> {
    if (this.tokens.access_token !== rejected) return this.tokens.access_token;
    if (this.lastRefreshAt !== undefined && Date.now() - this.lastRefreshAt < FRESH_TOKEN_WINDOW_MS) {
      throw new BridgeError(401, "token_rejected", "ChatGPT rejected a token that was refreshed moments ago. Run 'codex login' to sign in again.");
    }
    return this.refreshDeduplicated();
  }

  private refreshDeduplicated(): Promise<string> {
    if (this.pendingRefresh) return this.pendingRefresh;
    const pending: Promise<string> = this.refresh().finally(() => {
      if (this.pendingRefresh === pending) this.pendingRefresh = undefined;
    });
    this.pendingRefresh = pending;
    return pending;
  }

  private adopt(tokens: Tokens): void {
    this.seenRefreshTokens.add(tokens.refresh_token);
    this.tokens = { ...tokens, account_id: this.accountIdValue };
    this.expiresAt = extractTokenExp(tokens.access_token);
  }

  /** Adopts tokens another process rotated on disk. Returns true when a usable token was adopted. */
  private async adoptRotatedTokens(): Promise<boolean> {
    const onDisk = (await readAuthFile(this.options.authPath)).tokens;
    if (this.seenRefreshTokens.has(onDisk.refresh_token)) return false;
    const diskAccountId = extractAccountId(onDisk.access_token, onDisk.account_id);
    if (diskAccountId !== undefined && diskAccountId !== this.accountIdValue) {
      throw new BridgeError(401, "account_changed", "The Codex login now belongs to a different ChatGPT account. Restart codex2cc to use it.");
    }
    this.adopt(onDisk);
    return Date.now() < this.expiresAt - REFRESH_MARGIN_MS;
  }

  private async refresh(): Promise<string> {
    try {
      if (await this.adoptRotatedTokens()) return this.tokens.access_token;
    } catch (error) {
      if (error instanceof BridgeError && error.code === "account_changed") throw error;
      // An unreadable file must not fail a session whose in-memory refresh token is still usable.
      warn("adopt_rotated_tokens", { message: error instanceof Error ? error.message : String(error) });
    }

    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: CODEX_CLIENT_ID,
      refresh_token: this.tokens.refresh_token,
    });
    const response = await fetchOnce(
      `${this.options.authOrigin}/api/accounts/oauth/token`,
      { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body },
      "Codex token refresh",
    );
    if (!response.ok) {
      await response.body?.cancel();
      if (await this.adoptAfterLostRace()) return this.tokens.access_token;
      throw new BridgeError(
        response.status === 401 || response.status === 400 ? 401 : 502,
        "refresh_failed",
        `ChatGPT token refresh returned HTTP ${response.status}. Please run 'codex login' in terminal to refresh.`,
      );
    }
    const data = RefreshResponse.parse(await response.json());
    const updated: Tokens = {
      access_token: data.access_token,
      refresh_token: data.refresh_token ?? this.tokens.refresh_token,
      id_token: data.id_token ?? this.tokens.id_token,
    };
    this.adopt(updated);
    this.lastRefreshAt = Date.now();
    await this.persist(updated);
    return updated.access_token;
  }

  /** A rejected refresh usually means a concurrent process used the single-use token first; give it time to save. */
  private async adoptAfterLostRace(): Promise<boolean> {
    for (let poll = 0; poll < LOST_RACE_POLLS; poll++) {
      if (poll > 0) await new Promise((resolve) => setTimeout(resolve, LOST_RACE_POLL_INTERVAL_MS));
      try {
        if (await this.adoptRotatedTokens()) return true;
      } catch (error) {
        if (error instanceof BridgeError && error.code === "account_changed") throw error;
        warn("adopt_rotated_tokens", { message: error instanceof Error ? error.message : String(error) });
      }
    }
    return false;
  }

  private async persist(updated: Tokens): Promise<void> {
    try {
      // Write through a symlinked auth.json instead of replacing the link.
      const target = await realpath(this.options.authPath);
      const { document, tokens: onDisk } = await readAuthFile(target);
      if (!this.seenRefreshTokens.has(onDisk.refresh_token)) {
        warn("persist_codex_auth", { path: target, message: "auth.json was rotated by another process during the refresh; leaving it untouched." });
        return;
      }
      const existing = typeof document.tokens === "object" && document.tokens !== null ? document.tokens : {};
      const tokens = { ...existing, access_token: updated.access_token, refresh_token: updated.refresh_token, id_token: updated.id_token };
      await writeFileAtomic(target, JSON.stringify({ ...document, tokens, last_refresh: new Date().toISOString() }, null, 2));
    } catch (error) {
      // The in-memory session stays valid, but the rotated refresh token is not saved: Codex CLI may need 'codex login'.
      warn("persist_codex_auth", { path: this.options.authPath, message: error instanceof Error ? error.message : String(error) });
    }
  }

  async listModels(): Promise<Array<{ slug: string; displayName: string; contextWindow?: number }>> {
    try {
      const response = await fetchRetry(
        `${this.options.backendOrigin}/codex/models?client_version=${CODEX_CLIENT_VERSION}`,
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
            ...(m.context_window === undefined ? {} : { contextWindow: m.context_window }),
          }));
        }
      }
    } catch (error) {
      warn("remote_model_discovery", { message: error instanceof Error ? error.message : String(error) });
    }

    try {
      const parsed = ModelsApiResponse.safeParse(JSON.parse(await readFile(this.options.modelsCachePath, "utf8")));
      if (parsed.success && parsed.data.models.length > 0) {
        return parsed.data.models.map((m) => ({
          slug: m.slug,
          displayName: m.display_name ?? m.slug,
          ...(m.context_window === undefined ? {} : { contextWindow: m.context_window }),
        }));
      }
    } catch (error) {
      if (!isErrnoException(error, "ENOENT")) {
        warn("local_model_cache", { path: this.options.modelsCachePath, message: error instanceof Error ? error.message : String(error) });
      }
    }

    return [
      { slug: "gpt-6-astra", displayName: "GPT-6 Astra" },
      { slug: "gpt-6-sol", displayName: "GPT-6 Sol" },
      { slug: "gpt-6.1-sol", displayName: "GPT-6.1 Sol" },
      { slug: "gpt-6-luna", displayName: "GPT-6 Luna" },
    ];
  }

  async getUsageLimits(forceRefresh = false): Promise<AccountUsageLimits | null> {
    const now = Date.now();
    if (!forceRefresh && this.cachedLimits && now - this.cachedLimits.fetchedAt < 15_000) {
      return this.cachedLimits.limits;
    }

    try {
      const response = await fetchRetry(
        `${this.options.backendOrigin}/wham/usage`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${await this.accessToken()}`,
            "ChatGPT-Account-Id": this.accountIdValue,
            "User-Agent": `codex-cli/${CODEX_CLIENT_VERSION}`,
            Accept: "application/json",
          },
        },
        "account usage quota discovery",
      );

      if (response.ok) {
        const json = await response.json();
        const parsed = WhamUsageResponseSchema.safeParse(json);
        if (parsed.success && parsed.data.rate_limit) {
          const rl = parsed.data.rate_limit;
          const mapWindow = (win?: z.infer<typeof WhamUsageWindowSchema> | null): UsageWindowLimit | null => {
            if (!win || typeof win.used_percent !== "number" || Number.isNaN(win.used_percent)) return null;
            const used = Math.max(0, Math.min(100, Math.round(win.used_percent)));
            const resetAfter = win.reset_after_seconds ?? 0;
            const resetAt = win.reset_at ?? Math.floor((now + resetAfter * 1000) / 1000);
            return {
              usedPercent: used,
              remainingPercent: Math.max(0, 100 - used),
              limitWindowSeconds: win.limit_window_seconds ?? 0,
              resetAfterSeconds: resetAfter,
              resetAt,
            };
          };

          const limits: AccountUsageLimits = {
            planType: parsed.data.plan_type ?? "standard",
            allowed: rl.allowed ?? true,
            limitReached: rl.limit_reached ?? false,
            primaryWindow: mapWindow(rl.primary_window),
            secondaryWindow: mapWindow(rl.secondary_window),
            lastUpdated: new Date().toISOString(),
          };

          this.cachedLimits = { limits, fetchedAt: now };
          return limits;
        }
      }
    } catch (error) {
      warn("account_usage_limits", { message: error instanceof Error ? error.message : String(error) });
    }

    return this.cachedLimits?.limits ?? null;
  }
}
