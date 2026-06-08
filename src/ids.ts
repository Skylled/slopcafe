// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/**
 * Identifier minting. Three flavours:
 *
 *   - `newUuid()`        – internal primary keys (agents, agent_keys, documents)
 *   - `newPublicId()`    – the unguessable URL capability (≥128-bit CSPRNG)
 *   - `newApiKey()`      – API key with a grep-able tag and an indexed prefix
 *
 * All use Web Crypto via `crypto.randomUUID` and `crypto.getRandomValues`,
 * both available in the Workers runtime.
 */

/** URL-safe base64 (RFC 4648 §5) of `bytes`, padding stripped. */
function b64url(bytes: Uint8Array): string {
  // btoa wants a binary string. Workers has no Buffer; build it by char code.
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** Random v4 UUID — for any internal row PK where opacity is not security. */
export function newUuid(): string {
  return crypto.randomUUID();
}

/**
 * Loose v4-ish UUID matcher — version nibble unconstrained. The SINGLE shape
 * gate for agent/key ids, used to reject a malformed id before it reaches a
 * route/href (admin.ts / admin-oauth.ts / authorize.ts / console.ts / index.ts
 * all import this rather than re-declaring it). Lowercase only — `crypto` and
 * D1 never emit uppercase, so this matches every id we actually store.
 */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * 16 bytes of CSPRNG output, URL-safe base64 (22 chars). This is the
 * "capability is the URL" id from the action plan: non-sequential,
 * non-enumerable, possession = read access.
 */
export function newPublicId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return b64url(bytes);
}

/**
 * Mint a fresh agent API key. Returned plaintext is shown to the operator
 * exactly once. We persist:
 *   - `prefix` (11 chars) — indexed lookup column on agent_keys
 *   - HMAC-SHA256(`secret`, pepper) — set by the auth layer, not here
 *
 * Format: `awh_<prefix>.<secret>`. The `awh_` tag makes leaked keys
 * grep-able in CI logs and chat scrollback. `.` (not `_`) separates the
 * two halves because base64url *includes* `_`, so an `_` separator made
 * the format ambiguous; `.` is in HTTP's token68 charset and never
 * appears in base64url output.
 */
export function newApiKey(): { plaintext: string; prefix: string; secret: string } {
  const prefixBytes = new Uint8Array(8);   // 11 b64url chars
  const secretBytes = new Uint8Array(24);  // 32 b64url chars
  crypto.getRandomValues(prefixBytes);
  crypto.getRandomValues(secretBytes);
  const prefix = b64url(prefixBytes);
  const secret = b64url(secretBytes);
  return { plaintext: `awh_${prefix}.${secret}`, prefix, secret };
}

/**
 * Inverse of `newApiKey`. Returns null on any malformation so callers can
 * uniformly 401 without leaking which part failed.
 */
export function parseApiKey(key: string): { prefix: string; secret: string } | null {
  if (!key.startsWith("awh_")) return null;
  const body = key.slice(4);
  const dot = body.indexOf(".");
  if (dot <= 0 || dot === body.length - 1) return null;
  return { prefix: body.slice(0, dot), secret: body.slice(dot + 1) };
}
