// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/**
 * Browser session layer — a SECOND door onto the SAME operator authorization
 * check, so the operator can log in once and carry a cookie instead of pasting
 * `OPERATOR_TOKEN` on every browser action. Programmatic `Authorization: Bearer`
 * auth is untouched; this is purely additive for browsers. (HTTP/browser only —
 * `/mcp` is owned by the OAuth wrap and never consults these cookies.)
 *
 * TWO TIERS SHARE ONE COOKIE FORMAT (the insight fork's reader tier):
 *
 *   - OPERATOR session — payload has NO `r` field. Everything the operator can
 *     do through a browser.
 *   - READER session — payload carries `r`, a fingerprint of the specific
 *     `READER_TOKENS` entry it was minted from. READ-ONLY, always: it satisfies
 *     `authenticateSessionRequest` at tier "reader" and NOTHING else. It can
 *     never satisfy `authenticateOperatorRequest`, `requireOperator` or
 *     `authorizeOperatorForm` — those three check the tier and refuse — so every
 *     mutation, credential and agent-management surface denies a reader with the
 *     SAME response an anonymous caller gets.
 *
 * The absent-`r`-means-operator encoding is what keeps live operator cookies
 * valid across this change (no `PAYLOAD_V` bump, no forced re-login), and it
 * fails in the safe direction: a payload that loses its `r` in transit also
 * loses its signature.
 *
 * STATELESS SIGNED COOKIE. No D1/KV, no migration. The cookie carries its own
 * signed payload; the signing key is DERIVED from `OPERATOR_TOKEN`:
 *
 *   awh_session = base64url(JSON {v, iat, exp, csrf, r?}) "." hmacSha256Hex(payload, signingKey)
 *   signingKey  = hmacSha256Hex("awh-session-signing/v" + EPOCH, OPERATOR_TOKEN)
 *   r           = hmacSha256Hex("awh-reader-id/v1:" + readerToken, signingKey)[0..16]
 *
 * Two real invalidation levers, both of which change `signingKey` so every
 * existing cookie fails verification at once:
 *   - bump `SESSION_EPOCH` (a [var] — the cheap "log everyone out" knob), or
 *   - rotate `OPERATOR_TOKEN` (the compromise response).
 *
 * Plus a THIRD, per-person lever that exists only for readers: delete one entry
 * from `READER_TOKENS`. Because a reader cookie carries `r` (an HMAC of the
 * minting token under the same signing key) and verification recomputes `r` for
 * every CURRENTLY configured reader token, dropping one entry invalidates
 * exactly that person's live sessions and leaves every other reader — and the
 * operator — signed in. That is the whole reason the tokens are per-person and
 * the reason `r` is a fingerprint of the token rather than its INDEX in the
 * list: an index would silently re-point at a different human the moment an
 * earlier entry was removed.
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

import {
  authenticateOperator,
  bearerToken,
  hmacSha256Hex,
  matchReaderToken,
  readerTokens,
  timingSafeEqual,
} from "./auth.js";
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
/**
 * Domain-separation label for the reader-identity derivation. A DIFFERENT label
 * from the signing one so the two HMACs over related inputs can never be made to
 * collide, and versioned so a future identity scheme can coexist. Wire format
 * (it is baked into live cookies) — keep stable.
 */
const READER_ID_LABEL = "awh-reader-id/v1:";
/**
 * Hex characters kept from the reader-identity HMAC. 16 hex chars = 64 bits,
 * which is not a secret (the cookie is signed; `r` is an opaque tag, not a
 * credential) and only needs to make an accidental collision between two
 * configured reader tokens impossible in practice. Truncating keeps the cookie
 * small.
 */
const READER_ID_HEX_LEN = 16;
/** Base for resolving `next` redirects; a host we will never actually serve. */
const PLACEHOLDER_ORIGIN = "https://placeholder.invalid";

/**
 * The decoded session payload. `r` present ⇒ a READER session, and its value is
 * the `deriveReaderId` fingerprint of the `READER_TOKENS` entry that minted it.
 * `r` absent ⇒ an OPERATOR session (which is why existing operator cookies keep
 * verifying unchanged).
 */
export type SessionPayload = { v: number; iat: number; exp: number; csrf: string; r?: string };

/** Which tier a verified session grants. */
export type SessionTier = "operator" | "reader";

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

/**
 * The per-person reader identity baked into a reader cookie:
 * `HMAC(message = "awh-reader-id/v1:" + readerToken, key = signingKey)`,
 * truncated to `READER_ID_HEX_LEN` hex chars.
 *
 * Keyed under the SESSION SIGNING KEY (not the raw operator token, not the
 * pepper) so the identity inherits both invalidation levers for free: rotating
 * `OPERATOR_TOKEN` or bumping `SESSION_EPOCH` changes every `r`, which is
 * consistent with those levers already invalidating the signature.
 *
 * Derived from the TOKEN, never from its position in `READER_TOKENS`. That is
 * the property the whole per-person-revocation story rests on: the operator
 * deletes one entry, that entry's `r` stops being recomputable from the live
 * config, and only that person is logged out. An index-based id would re-map
 * survivors onto each other's identities on every removal.
 *
 * Pure (explicit token/operatorToken/epoch args) so it is unit-testable.
 */
export async function deriveReaderId(
  readerToken: string,
  operatorToken: string,
  epoch: string,
): Promise<string> {
  const signingKey = await deriveSigningKey(operatorToken, epoch);
  const full = await hmacSha256Hex(`${READER_ID_LABEL}${readerToken}`, signingKey);
  return full.slice(0, READER_ID_HEX_LEN);
}

/**
 * The set of reader ids that are VALID RIGHT NOW — one per currently configured
 * `READER_TOKENS` entry. A reader cookie is honored only if its `r` is in here,
 * so the set IS the revocation list: it shrinks the moment the operator removes
 * a token and redeploys the secret.
 */
export async function currentReaderIds(
  tokens: readonly string[],
  operatorToken: string,
  epoch: string,
): Promise<Set<string>> {
  const ids = await Promise.all(tokens.map((t) => deriveReaderId(t, operatorToken, epoch)));
  return new Set(ids);
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
 *
 * `readerId` (optional, last so every existing call site is unchanged) makes
 * this a READER session: pass the `deriveReaderId` fingerprint of the token the
 * person signed in with. Omit it for an operator session — absence of `r` IS the
 * operator marker, so an accidental omission downgrades nothing, it UPGRADES,
 * which is exactly why `postLogin` derives the id and passes it in one place and
 * `authenticateOperatorRequest` re-checks the tier at every use.
 */
export async function mintSessionCookieValue(
  operatorToken: string,
  epoch: string,
  nowMs: number,
  ttlSeconds: number,
  csrfNonce: string,
  readerId?: string,
): Promise<string> {
  const payload: SessionPayload = {
    v: PAYLOAD_V,
    iat: nowMs,
    exp: nowMs + ttlSeconds * 1000,
    csrf: csrfNonce,
    ...(readerId ? { r: readerId } : {}),
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
  // `r` is optional, but if present it must be a non-empty string — a null/
  // number/empty `r` would otherwise slip past `payload.r === undefined` and be
  // read as an OPERATOR session. The signature already makes this unreachable
  // for an attacker; the check is here so the "absent ⇒ operator" encoding has
  // exactly one spelling of "absent".
  if (o.r !== undefined && (typeof o.r !== "string" || o.r.length === 0)) return false;
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
 * (`isSecureRequest`) keys it off the request protocol AND host — omitted only
 * over loopback http (`wrangler dev`), set everywhere else, https or not.
 * Cookies are HOST-ONLY (no `Domain`) on purpose.
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
 *
 * The origin check alone is NOT sufficient, because the value we emit is a
 * *relative* `Location:` and the browser re-parses it: a resolved path starting
 * `//` is a PROTOCOL-RELATIVE URL (`//evil.com` → `https://evil.com`), i.e. it
 * escapes the origin at redirect time even though it parsed same-origin here.
 * Dot-segment resolution manufactures exactly that from input that never looked
 * scheme-relative — `/..//evil.com` resolves to pathname `//evil.com` — so the
 * `//` check has to be on the OUTPUT, after normalization, not on the input.
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
  if (!path.startsWith("/") || path.startsWith("//")) return "/";
  return path;
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

/**
 * Hosts where plain http is the EXPECTED transport — `wrangler dev` serves
 * `http://localhost:8787`. Matched on `URL.hostname`, which keeps the brackets
 * on an IPv6 literal (`http://[::1]:8787` → `"[::1]"`), so the literal forms
 * here are what a real request actually presents.
 */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Should the session cookies carry `Secure`? Drives the conditional attribute
 * in `buildSessionSetCookies` / `buildLogoutSetCookies`.
 *
 * https → always yes. Plain http → yes UNLESS the host is loopback. The
 * exemption exists for exactly one reason: a browser silently DROPS a `Secure`
 * cookie set over `http://localhost`, so a blanket `Secure` would break login
 * under `wrangler dev`. It is deliberately NOT scheme-only — an http request to
 * a real hostname is either a misconfigured zone (Cloudflare answers port 80
 * unless "Always Use HTTPS" is on — see docs/cloudflare-setup.md) or an active
 * downgrade, and in both cases we'd rather mint a cookie the browser then
 * refuses to send over cleartext than hand a 30-day operator session to an
 * on-path observer. Failing closed here costs nothing in the only environment
 * that matters (https), and costs a broken-looking login in the environment
 * that shouldn't exist.
 *
 * Consequence, accepted: `wrangler dev --ip 0.0.0.0` reached from another device
 * at `http://192.168.x.y:8787` is NOT loopback, so its login cookie gets `Secure`
 * and the browser drops it. Use `http://localhost:8787`, or an https tunnel.
 */
export function isSecureRequest(req: Request): boolean {
  const url = new URL(req.url);
  if (url.protocol === "https:") return true;
  return !LOOPBACK_HOSTS.has(url.hostname);
}

export type OperatorAuth =
  | { ok: true; via: "bearer" }
  | { ok: true; via: "cookie"; csrf: string }
  | { ok: false };

/** A resolved session, with the tier it grants. See `authenticateSessionRequest`. */
export type SessionAuth =
  | { ok: true; tier: SessionTier; via: "bearer" }
  | { ok: true; tier: SessionTier; via: "cookie"; csrf: string }
  | { ok: false };

/**
 * Resolve ANY session tier — operator or reader — from EITHER a Bearer token OR
 * a session cookie. This is the widened resolver every READ surface uses; the
 * operator-only surfaces keep calling `authenticateOperatorRequest` below, which
 * is this function narrowed to `tier === "operator"`.
 *
 * Resolution order (each rung strictly dominates the next):
 *   1. `Authorization: Bearer <OPERATOR_TOKEN>` → operator/bearer.
 *   2. `Authorization: Bearer <one of READER_TOKENS>` → reader/bearer. The
 *      reader tier gets a Bearer door for the same reason the operator has one:
 *      a human with `curl` (or a script fetching `/d/:id/text`) should not have
 *      to drive a cookie jar. It buys exactly the read reach the cookie does.
 *   3. A valid `awh_session` cookie → operator or reader, per the payload's `r`.
 *
 * Bearer is tried FIRST so a programmatic caller that happens to also carry a
 * stale cookie is treated as bearer (and never has CSRF demanded of it). Fails
 * closed when `OPERATOR_TOKEN` is unset — guarded before any key derivation so
 * we never HMAC an empty key, and note that this means the reader tier is also
 * off without an operator token, since the reader ids are derived under the
 * session signing key.
 *
 * A reader cookie whose `r` is NOT among the currently configured tokens' ids is
 * rejected outright (`{ ok: false }`) — that is the per-person revocation.
 */
export async function authenticateSessionRequest(req: Request, env: Env): Promise<SessionAuth> {
  if (authenticateOperator(req, env)) return { ok: true, tier: "operator", via: "bearer" };
  if (!env.OPERATOR_TOKEN) return { ok: false };

  const tokens = readerTokens(env);
  if (tokens.length > 0 && matchReaderToken(bearerToken(req), env) !== null) {
    return { ok: true, tier: "reader", via: "bearer" };
  }

  const cookie = readCookie(req, COOKIE_SESSION);
  if (!cookie) return { ok: false };
  const epoch = sessionEpoch(env);
  const payload = await verifySessionCookieValue(cookie, env.OPERATOR_TOKEN, epoch, Date.now());
  if (!payload) return { ok: false };
  if (payload.r === undefined) {
    return { ok: true, tier: "operator", via: "cookie", csrf: payload.csrf };
  }
  // Reader cookie: honored only while the token that minted it is still listed.
  const live = await currentReaderIds(tokens, env.OPERATOR_TOKEN, epoch);
  if (!live.has(payload.r)) return { ok: false };
  return { ok: true, tier: "reader", via: "cookie", csrf: payload.csrf };
}

/**
 * Resolve the OPERATOR principal specifically — the narrow view of
 * `authenticateSessionRequest`. Every pre-existing caller (admin.ts, console.ts,
 * serve.ts's manage/revoke/version surfaces, authorize.ts, login.ts,
 * `requireOperator`, `authorizeOperatorForm`) keeps calling this, so the reader
 * tier is DENY-BY-DEFAULT across the whole existing surface: a new principal
 * that no existing gate knows about cannot pass one by accident. Widening a read
 * surface to readers is an explicit, greppable edit at that surface.
 */
export async function authenticateOperatorRequest(req: Request, env: Env): Promise<OperatorAuth> {
  const auth = await authenticateSessionRequest(req, env);
  if (!auth.ok || auth.tier !== "operator") return { ok: false };
  return auth.via === "bearer" ? { ok: true, via: "bearer" } : { ok: true, via: "cookie", csrf: auth.csrf };
}

function isUnsafeMethod(method: string): boolean {
  const m = method.toUpperCase();
  return m !== "GET" && m !== "HEAD" && m !== "OPTIONS";
}

/**
 * The operator-surface JSON error envelope (the `requireOperator` 401/403).
 *
 * Carries the same `service-desc` Link header as the agent door's `jsonError`
 * (index.ts) and `unauthorizedJson` (serve.ts), so an operator script that only
 * ever sees a 401 still learns where the contract is written down. The literal
 * is duplicated here on purpose rather than imported from serve.ts: `serve.ts`
 * imports THIS module, so the reverse edge would be a module cycle. Three
 * copies of one header string, each pointing at the same route — if a fourth
 * appears, promote it to a leaf module.
 */
const SERVICE_DESC_LINK = '</openapi.json>; rel="service-desc"';

function operatorError(status: number, code: ErrorCode, message: string): Response {
  return Response.json({ error: code, message }, { status, headers: { link: SERVICE_DESC_LINK } });
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
    return operatorError(
      401,
      "unauthorized",
      "operator token or session required — see /openapi.json for the routes and auth scheme",
    );
  }
  if (auth.via === "cookie" && isUnsafeMethod(req.method)) {
    if (!csrfMatches(req.headers.get("x-csrf-token"), auth.csrf)) {
      return operatorError(403, "csrf_failed", "missing or invalid X-CSRF-Token");
    }
  }
  return null;
}

/**
 * The READ twin of `requireOperator` for the JSON `/admin/*` surface: accepts an
 * operator OR a reader (either door), refuses everything else with the SAME 401
 * `unauthorized` envelope `requireOperator` emits. Use it ONLY on routes that
 * read — `GET /admin/documents`, `/admin/documents/search`,
 * `/admin/documents/:id`, `/admin/documents/:id/versions`, `/admin/links/orphans`.
 *
 * NOT for `/admin/agents*`, `/admin/keys*` or `/admin/oauth-clients*`: those are
 * credential surfaces, and listing an agent's keys is a step in an attack on the
 * write path even though it is technically a read. They stay `requireOperator`.
 *
 * The identical error text on refusal is the point — a reader probing a mutation
 * route must learn nothing beyond "read works, this didn't", so there is no
 * capability oracle to enumerate.
 *
 * CSRF is still enforced on a cookie session + unsafe method, exactly as in
 * `requireOperator`. No current caller is unsafe (they are all GETs); keeping the
 * rung means a future POST wired to this guard doesn't quietly lose CSRF.
 */
export async function requireReadSession(req: Request, env: Env): Promise<Response | null> {
  const auth = await authenticateSessionRequest(req, env);
  if (!auth.ok) {
    return operatorError(
      401,
      "unauthorized",
      "operator token or session required — see /openapi.json for the routes and auth scheme",
    );
  }
  if (auth.via === "cookie" && isUnsafeMethod(req.method)) {
    if (!csrfMatches(req.headers.get("x-csrf-token"), auth.csrf)) {
      return operatorError(403, "csrf_failed", "missing or invalid X-CSRF-Token");
    }
  }
  return null;
}

/**
 * Operator-auth ladder for HTML POST forms (the manage page's visibility/slug/
 * tags/status/restore forms, the console's mutating forms). `handleRevokeForm`
 * is the one HTML POST that deliberately does NOT call this — it keeps its own
 * inline copy of rungs 1 and 3 only, so the single irreversible action stays
 * strictly narrower than the reversible ones. Three accepted credentials here,
 * in order:
 *
 *   1. a non-empty pasted `operator_token` form field (synthetic Bearer — the
 *      token IS the inline credential, so CSRF-exempt);
 *   2. a real `Authorization: Bearer <OPERATOR_TOKEN>` header (same credential,
 *      just in its natural place — likewise CSRF-exempt, because a bearer
 *      header is never ambient the way a cookie is);
 *   3. a valid session cookie PLUS a matching `csrf_token` form field. On this
 *      path the verified nonce is returned so a re-rendered page's forms can
 *      carry it.
 *
 * (2) is not a convenience: `requireOperator` accepts the identical header, so
 * rejecting it here made the two operator ladders disagree about the same
 * credential for no stated reason — a *successfully authenticated* operator got
 * a 401 telling it to sign in. The original motivation was sharper still:
 * `POST /d/:id/restore` was then the ONLY restore surface, so refusing a header
 * Bearer forced an operator script to move `OPERATOR_TOKEN` out of the header
 * and into a request body. That specific corner is gone — restore now has a
 * JSON twin at `POST /admin/documents/:public_id/restore` (admin.ts) — but the
 * uniformity argument is the durable one, and it covers every manage form, not
 * just restore.
 *
 * This is the FORM-FIELD CSRF twin of `requireOperator` (which reads the
 * `X-CSRF-Token` *header* a no-JS form can't send), kept separate on purpose.
 *
 * READERS ARE REFUSED on every rung, without a special case: rung 1 compares the
 * pasted field against `OPERATOR_TOKEN` alone, and rungs 2-3 go through
 * `authenticateOperatorRequest`, which rejects a reader-tier bearer or cookie.
 * A reader submitting any manage-page or console form therefore gets the
 * verbatim "Sign in or paste the operator token to make changes." an anonymous
 * visitor gets. Do not "helpfully" widen this to `authenticateSessionRequest` —
 * every caller of this ladder is a mutation.
 */
export type FormAuthz =
  | { ok: true; via: "bearer" }
  | { ok: true; via: "cookie"; csrf: string }
  | { ok: false; status: number; message: string };

export async function authorizeOperatorForm(
  req: Request,
  env: Env,
  form: FormData,
): Promise<FormAuthz> {
  const operatorToken = String(form.get("operator_token") ?? "");
  if (operatorToken) {
    const synth = new Request(req.url, {
      headers: { authorization: `Bearer ${operatorToken}` },
    });
    if (!authenticateOperator(synth, env)) {
      return { ok: false, status: 401, message: "Operator token incorrect." };
    }
    return { ok: true, via: "bearer" };
  }
  const auth = await authenticateOperatorRequest(req, env);
  if (!auth.ok) {
    return { ok: false, status: 401, message: "Sign in or paste the operator token to make changes." };
  }
  // Header Bearer: authorized outright, no CSRF echo demanded — identical
  // reasoning to the pasted-token branch above and to `requireOperator`.
  if (auth.via === "bearer") return { ok: true, via: "bearer" };
  if (!csrfMatches(String(form.get("csrf_token") ?? ""), auth.csrf)) {
    return { ok: false, status: 403, message: "CSRF check failed — reload and try again." };
  }
  return { ok: true, via: "cookie", csrf: auth.csrf };
}
