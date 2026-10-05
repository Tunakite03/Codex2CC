import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

export const MIN_TOKEN_LENGTH = 16;

export type GuardPolicy =
  | { readonly mode: "token"; readonly token: string }
  | { readonly mode: "open" };

export type GuardResult =
  | { readonly ok: true }
  | {
    readonly ok: false;
    readonly status: 401 | 403;
    readonly type: "authentication_error" | "permission_error";
    readonly message: string;
  };

const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "[::1]"]);

function hostnameOf(hostHeader: string | undefined): string | undefined {
  if (hostHeader === undefined) return undefined;
  if (hostHeader.startsWith("[")) {
    const end = hostHeader.indexOf("]");
    return end < 0 ? undefined : hostHeader.slice(0, end + 1).toLowerCase();
  }
  return hostHeader.split(":")[0]?.toLowerCase();
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function presentedToken(headers: IncomingHttpHeaders): string | undefined {
  const authorization = headers.authorization;
  if (typeof authorization === "string") {
    const match = /^Bearer\s+(\S+)$/i.exec(authorization);
    if (match?.[1] !== undefined) return match[1];
  }
  const apiKey = headers["x-api-key"];
  return typeof apiKey === "string" ? apiKey : undefined;
}

/** Returns the URL pathname, or undefined when the request target is not a valid URL. */
export function requestPathname(rawUrl: string | undefined): string | undefined {
  try {
    return new URL(rawUrl ?? "/", "http://127.0.0.1").pathname;
  } catch (error) {
    if (error instanceof TypeError) return undefined;
    throw error;
  }
}

/** Rejects requests whose Host is not a loopback name, which blocks DNS-rebinding. */
export function checkHost(headers: IncomingHttpHeaders): GuardResult {
  const hostname = hostnameOf(headers.host);
  if (hostname === undefined || !LOOPBACK_HOSTNAMES.has(hostname)) {
    return { ok: false, status: 403, type: "permission_error", message: "Host header is not a loopback address." };
  }
  return { ok: true };
}

/**
 * Protects the control-panel API against cross-site request forgery. The panel is served
 * credential-free from the same origin, so a browser request is legitimate only when its `Origin`
 * header (always present on cross-origin and on same-origin non-GET requests) names this gateway's
 * own loopback origin. Requests without `Origin` come from non-browser tools such as curl.
 */
export function checkUiOrigin(headers: IncomingHttpHeaders, port: number): GuardResult {
  const origin = headers.origin;
  if (origin === undefined) return { ok: true };
  const allowed: readonly string[] = [`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`];
  if (typeof origin === "string" && allowed.includes(origin.toLowerCase())) return { ok: true };
  return { ok: false, status: 403, type: "permission_error", message: "Cross-origin requests to the control panel are not allowed." };
}

/**
 * Authenticates the caller. In token mode the shared secret is mandatory. In open mode
 * (explicit opt-out) any request carrying an Origin header is refused, because only
 * browsers send it and a web page must never reach the gateway without a credential.
 */
export function checkClient(headers: IncomingHttpHeaders, policy: GuardPolicy): GuardResult {
  if (policy.mode === "open") {
    if (headers.origin !== undefined) {
      return { ok: false, status: 403, type: "permission_error", message: "Browser-originated requests are not allowed." };
    }
    return { ok: true };
  }
  const presented = presentedToken(headers);
  if (presented === undefined || !timingSafeEqual(digest(presented), digest(policy.token))) {
    return { ok: false, status: 401, type: "authentication_error", message: "Invalid local gateway credential." };
  }
  return { ok: true };
}
