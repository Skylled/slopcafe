/**
 * Browser session layer — a SECOND door onto the SAME operator authorization
 * check, so the operator can log in once and carry a cookie instead of pasting
 * `OPERATOR_TOKEN` on every browser action. Programmatic `Authorization: Bearer`
 * auth is untouched; this is purely additive for browsers. (HTTP/browser only —
 * `/mcp` is owned by the OAuth wrap and never consults these cookies.)
 *
 * STATELESS SIGNED COOKIE. No D1/KV, no migration. The cookie carries its own
 * signed payload; the signing key is DERIVED from `OPERATOR_TOKEN`:
 *
 *   awh_session = base64url(JSON {v, iat, exp, csrf}) "." hmacSha256Hex(payload, signingKey)
 *   signingKey  = hmacSha256Hex("awh-session-signing/v" + EPOCH, OPERATOR_TOKEN)
 *
 * Two real invalidation levers, both of which change `signingKey` so every
 * existing cookie fails verification at once:
 *   - bump `SESSION_EPOCH` (a [var] — the cheap "log everyone out" knob), or
 *   - rotate `OPERATOR_TOKEN` (the compromise response).
 *
 * The key is derived from `OPERATOR_TOKEN` ON PURPOSE, not from `HMAC_PEPPER`:
 * the session authenticates the *operator principal*, so its trust root must be
 * the operator secret. Deriving from the pepper would mean rotating the token
 * does NOT invalidate sessions — silently breaking the rotation-is-revocation
 * promise. Do not "fix" this by switching to the pepper.
 *
 * CSRF — stateless signed double-submit (stronger than naive): a random nonce
 * is embedded INSIDE the signed payload, and also delivered to the page in a
 * readable `awh_csrf` cookie / hidden form field. A cookie-authenticated
 * state-changing request must echo it (`X-CSRF-Token` header or `csrf_token`
 * form field); the server constant-time-compares the echo against the nonce in
 * the VERIFIED session. Because the trusted value comes from the signed cookie
 * (not a cookie-vs-cookie compare), subdomain cookie-injection can't defeat it.
 * Bearer-authenticated requests need no CSRF (a bearer header is never ambient).
 *
 * The crypto/cookie core below is pure (explicit `nowMs`/`operatorToken`/`epoch`
 * args, no `Date.now()`, no env, no D1/R2/WASM) — same discipline as
 * `computeExpiresAt`/`isKeyExpired` in auth.ts — so it's unit-testable under the
 * `--experimental-strip-types` runner. Only the thin env-aware wrappers at the
 * bottom read `env`.
 */

import { authenticateOperator, hmacSha256Hex, timingSafeEqual } from "./auth.js";
import type { ErrorCode } from "./contract.js";
import type { Env } from "./env.js";

/** HttpOnly auth cookie. */
export const COOKIE_SESSION = "awh_session";
/** Readable (non-HttpOnly) cookie carrying the CSRF nonce for the page to echo. */
export const COOKIE_CSRF = "awh_csrf";
/** 30 days — fixed absolute expiry; no sliding renewal in v1. */
export const SESSION_TTL_SECONDS = 2592000;
/** Payload structure version. Bump to reject an old cookie SHAPE independent of EPOCH. */
const PAYLOAD_V = 1;
/** Domain-separation label for the signing-key derivation. Wire format — keep stable. */
const SIGNING_LABEL_PREFIX = "awh-session-signing/v";
/** Base for resolving `next` redirects; a host we will never actually serve. */
const PLACEHOLDER_ORIGIN = "https://placeholder.invalid";

export type SessionPayload = { v: number; iat: number; exp: number; csrf: string };

// -- base64url (ASCII JSON payloads; same btoa/atob caveat as pagination cursors) --

function base64UrlEncode(s: string): string {
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(s: string): string {
  const padded = s + "=".repeat((4 - (s.length % 4)) % 4);
  return atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return base64UrlEncode(bin);
}

/** True if the string contains any C0 control char or DEL — used to reject
 *  header-injection / CRLF tricks in `next` without embedding control chars
 *  in source (mirrors the programmatic-range discipline in metadata.ts). */
function hasControlChars(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

// -- signing core -------------------------------------------------------------

/** signingKey = HMAC(message = "awh-session-signing/v{epoch}", key = OPERATOR_TOKEN). */
async function deriveSigningKey(operatorToken: string, epoch: string): Promise<string> {
  return hmacSha256Hex(`${SIGNING_LABEL_PREFIX}${epoch}`, operatorToken);
}

/** A fresh CSRF nonce: 18 random bytes → 24 base64url chars. */
export function mintCsrfNonce(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

/**
 * Mint a signed session cookie VALUE (not the full Set-Cookie line). The csrf
 * nonce is baked into the signed payload so it can't be swapped independently.
 */
export async function mintSessionCookieValue(
  operatorToken: string,
  epoch: string,
  nowMs: number,
  ttlSeconds: number,
  csrfNonce: string,
): Promise<string> {
  const payload: SessionPayload = {
    v: PAYLOAD_V,
    iat: nowMs,
    exp: nowMs + ttlSeconds * 1000,
    csrf: csrfNonce,
  };
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const signingKey = await deriveSigningKey(operatorToken, epoch);
  const sig = await hmacSha256Hex(payloadB64, signingKey);
  return `${payloadB64}.${sig}`;
}

function isValidPayload(p: unknown, nowMs: number): p is SessionPayload {
  if (typeof p !== "object" || p === null) return false;
  const o = p as Record<string, unknown>;
  if (o.v !== PAYLOAD_V) return false;
  if (typeof o.iat !== "number" || !Number.isFinite(o.iat)) return false;
  if (typeof o.exp !== "number" || !Number.isFinite(o.exp)) return false;
  if (typeof o.csrf !== "string" || o.csrf.length === 0) return false;
  if (!(o.exp > o.iat)) return false;
  // Valid strictly while now < exp; expired the instant now reaches exp.
  if (!(nowMs < o.exp)) return false;
  return true;
}

/**
 * Verify a session cookie value. Returns the decoded payload, or null on ANY
 * failure (bad shape, bad signature, expired, unset token) — fail closed. The
 * signature is checked BEFORE the payload is parsed, so only trusted bytes are
 * decoded. Constant-time signature compare via `timingSafeEqual`.
 */
export async function verifySessionCookieValue(
  value: string,
  operatorToken: string,
  epoch: string,
  nowMs: number,
): Promise<SessionPayload | null> {
  if (!operatorToken) return null; // no trust root → no session
  const dot = value.indexOf(".");
  if (dot <= 0 || dot === value.length - 1) return null;
  const payloadB64 = value.slice(0, dot);
  const sig = value.slice(dot + 1);

  const signingKey = await deriveSigningKey(operatorToken, epoch);
  const expected = await hmacSha256Hex(payloadB64, signingKey);
  if (!timingSafeEqual(sig, expected)) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(base64UrlDecode(payloadB64));
  } catch {
    return null;
  }
  if (!isValidPayload(payload, nowMs)) return null;
  return payload;
}

// -- cookies ------------------------------------------------------------------

/** Parse a `Cookie:` header into name→value. First occurrence of a name wins. */
export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (!name || name in out) continue;
    out[name] = part.slice(eq + 1).trim();
  }
  return out;
}

export function readCookie(req: Request, name: string): string | null {
  return parseCookies(req.headers.get("cookie"))[name] ?? null;
}

export type SetCookieOpts = {
  maxAge: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Lax" | "Strict" | "None";
  path?: string;
};

/**
 * Build one `Set-Cookie` value. `Max-Age=0` clears (matching name/path/secure/
 * samesite). `secure` is caller-supplied so the core stays pure; the env layer
 * keys it off the request protocol (omitted over http://localhost dev, set
 * behind https custom domains). Cookies are HOST-ONLY (no `Domain`) on purpose.
 */
export function serializeSetCookie(name: string, value: string, opts: SetCookieOpts): string {
  const parts = [`${name}=${value}`, `Path=${opts.path ?? "/"}`, `Max-Age=${opts.maxAge}`];
  if (opts.httpOnly) parts.push("HttpOnly");
  if (opts.secure) parts.push("Secure");
  parts.push(`SameSite=${opts.sameSite ?? "Lax"}`);
  return parts.join("; ");
}

/** The two Set-Cookie lines a successful login emits (append both, don't .set). */
export function buildSessionSetCookies(
  sessionValue: string,
  csrfNonce: string,
  secure: boolean,
): [string, string] {
  return [
    serializeSetCookie(COOKIE_SESSION, sessionValue, {
      maxAge: SESSION_TTL_SECONDS,
      httpOnly: true,
      secure,
      sameSite: "Lax",
    }),
    serializeSetCookie(COOKIE_CSRF, csrfNonce, {
      maxAge: SESSION_TTL_SECONDS,
      httpOnly: false,
      secure,
      sameSite: "Lax",
    }),
  ];
}

/** The two expired Set-Cookie lines logout emits. Attributes must match the
 *  originals (path/secure/samesite) or the clear silently no-ops. */
export function buildLogoutSetCookies(secure: boolean): [string, string] {
  return [
    serializeSetCookie(COOKIE_SESSION, "", { maxAge: 0, httpOnly: true, secure, sameSite: "Lax" }),
    serializeSetCookie(COOKIE_CSRF, "", { maxAge: 0, httpOnly: false, secure, sameSite: "Lax" }),
  ];
}

// -- CSRF + redirect helpers --------------------------------------------------

/** Constant-time compare of a submitted CSRF token against the session nonce. */
export function csrfMatches(submitted: string | null | undefined, sessionNonce: string): boolean {
  if (!submitted || !sessionNonce) return false;
  return timingSafeEqual(submitted, sessionNonce);
}

/**
 * Resolve a post-login `next` to a SAFE same-origin path, or `/` on anything
 * suspicious. Whitelist by origin, not blacklist: parsing against a placeholder
 * origin neutralizes `//evil.com`, `https://evil.com`, and (since `\` is
 * normalized to `/` under special schemes) `/\evil.com`. We only ever redirect
 * to the resolved `pathname + search`, never the raw input.
 */
export function validateNext(next: string | null | undefined): string {
  if (!next) return "/";
  if (next.includes("\\")) return "/"; // belt-and-suspenders vs backslash tricks
  if (hasControlChars(next)) return "/"; // control chars / CRLF (header-injection guard)
  let u: URL;
  try {
    u = new URL(next, PLACEHOLDER_ORIGIN);
  } catch {
    return "/";
  }
  if (u.origin !== PLACEHOLDER_ORIGIN) return "/";
  const path = u.pathname + u.search;
  return path.startsWith("/") ? path : "/";
}

/**
 * Validate an operator-approvable OAuth callback (the inline TOFU path in
 * authorize.ts). Returns the NORMALIZED https URL string, or null on anything
 * we won't remember. This is the ONLY scheme/host gate before
 * `OAUTH_PROVIDER.updateClient` — the provider validates redirect scheme on
 * `createClient` but NOT on update, so a permanently-stored callback flows
 * through here or not at all. Pure (no env) so it's unit-testable.
 *
 * Rejects: non-https; embedded credentials (userinfo — "https://claude.ai@evil.com"
 * has host evil.com but reads as claude.ai); a fragment; control chars; an
 * unparseable URL; and any host NOT on the supplied allowlist.
 *
 * `allowedHosts` is the SAME source of truth as AUTHORIZE_CSP's form-action set:
 * a host the CSP would block on the post-grant 302 must never be approvable.
 * Passing it in keeps this pure and makes the coupling explicit at the call site.
 * Comparison is on `URL.host` (includes any non-default port), so the allowlist,
 * the dedup check, and what we store all agree on one canonical form.
 */
export function validateCallbackUri(
  uri: string | null | undefined,
  allowedHosts: ReadonlySet<string>,
): string | null {
  if (!uri) return null;
  if (hasControlChars(uri)) return null;
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  if (u.username !== "" || u.password !== "") return null; // userinfo confusion
  if (u.hash !== "") return null; // no fragment
  if (!allowedHosts.has(u.host)) return null; // host == CSP form-action set
  return u.toString(); // single canonical normalized form (dedup against THIS)
}

// -- env-aware wrappers (thin; not part of the pure, unit-tested core) ---------

/** EPOCH input to the signing-key derivation; defaults to "1" when unset. */
export function sessionEpoch(env: Env): string {
  return env.SESSION_EPOCH ?? "1";
}

/** Is this request over HTTPS? Drives the conditional `Secure` cookie attribute. */
export function isSecureRequest(req: Request): boolean {
  return new URL(req.url).protocol === "https:";
}

export type OperatorAuth =
  | { ok: true; via: "bearer" }
  | { ok: true; via: "cookie"; csrf: string }
  | { ok: false };

/**
 * Resolve the operator principal from EITHER a Bearer token OR a session cookie.
 * Bearer is tried FIRST so a programmatic caller that happens to also carry a
 * stale cookie is treated as bearer (and never has CSRF demanded of it). Fails
 * closed when `OPERATOR_TOKEN` is unset — guarded before any key derivation so
 * we never HMAC an empty key.
 */
export async function authenticateOperatorRequest(req: Request, env: Env): Promise<OperatorAuth> {
  if (authenticateOperator(req, env)) return { ok: true, via: "bearer" };
  if (!env.OPERATOR_TOKEN) return { ok: false };
  const cookie = readCookie(req, COOKIE_SESSION);
  if (!cookie) return { ok: false };
  const payload = await verifySessionCookieValue(
    cookie,
    env.OPERATOR_TOKEN,
    sessionEpoch(env),
    Date.now(),
  );
  if (!payload) return { ok: false };
  return { ok: true, via: "cookie", csrf: payload.csrf };
}

function isUnsafeMethod(method: string): boolean {
  const m = method.toUpperCase();
  return m !== "GET" && m !== "HEAD" && m !== "OPTIONS";
}

function operatorError(status: number, code: ErrorCode, message: string): Response {
  return Response.json({ error: code, message }, { status });
}

/**
 * Shared operator guard for the JSON/admin surfaces (admin.ts, admin-oauth.ts,
 * and `DELETE /d/:id`). Returns a ready-to-send error Response, or null when the
 * request is authorized:
 *
 *   401 unauthorized — neither a valid Bearer token nor a valid session cookie
 *   403 csrf_failed  — cookie-authed + unsafe method + missing/bad X-CSRF-Token
 *
 * Bearer-authed requests are CSRF-exempt (a bearer header is not ambient). Safe
 * methods (GET/HEAD/OPTIONS) never require a CSRF token. HTML form surfaces
 * (login/logout/revoke) read the token from a form field instead and don't use
 * this guard.
 */
export async function requireOperator(req: Request, env: Env): Promise<Response | null> {
  const auth = await authenticateOperatorRequest(req, env);
  if (!auth.ok) {
    return operatorError(401, "unauthorized", "operator token or session required");
  }
  if (auth.via === "cookie" && isUnsafeMethod(req.method)) {
    if (!csrfMatches(req.headers.get("x-csrf-token"), auth.csrf)) {
      return operatorError(403, "csrf_failed", "missing or invalid X-CSRF-Token");
    }
  }
  return null;
}
