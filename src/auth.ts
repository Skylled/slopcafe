// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/**
 * Authentication primitives: Bearer parsing, HMAC, and the two principals
 * the API knows about — agents (per-key) and the operator (single token).
 */

import type { Env } from "./env.js";
import { parseApiKey } from "./ids.js";

/** Extract the value from `Authorization: Bearer <token>`; null if absent. */
export function bearerToken(req: Request): string | null {
  const h = req.headers.get("authorization");
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m?.[1]?.trim() ?? null;
}

/**
 * Constant-time string equality with NO length fast-fail.
 *
 * The obvious `if (a.length !== b.length) return false` shortcut makes the
 * comparison time observably depend on whether the caller's guess matches the
 * secret's length — a length oracle on `OPERATOR_TOKEN` (the one
 * operator-CHOSEN secret this compares; the HMAC paths are fixed-length hex
 * and never had the leak). Instead the length difference is folded into the
 * accumulator and the loop always walks max(len(a), len(b)) characters —
 * `charCodeAt` past the end yields NaN, which the bitwise XOR coerces to 0,
 * so the shorter string reads as a stream of zeros.
 *
 * Residual (accepted): the loop count is still max of the two lengths, so a
 * sub-iteration timing difference exists in principle — but it's
 * nanoseconds-per-character under network jitter, vs. the removed branch
 * which was a clean binary signal. Fully hiding length means hashing both
 * sides first, which would force this primitive (and every caller, e.g. the
 * sync session/CSRF compares) async for negligible real-world gain.
 *
 * Exported so the session/CSRF layer (src/session.ts) compares signed cookie
 * signatures and CSRF nonces with the same primitive the agent-key and
 * operator-token paths use — no second, divergent comparator.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** HMAC-SHA256(message, pepper), returned as lowercase hex. */
export async function hmacSha256Hex(message: string, pepper: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(pepper),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type AgentAuth = { agentId: string; keyId: string };

/**
 * Compute the ISO-8601 `expires_at` stamp for a key minted `ttlSeconds` from
 * `nowMs`. Same `…Z` millisecond shape D1's `strftime` produces for the other
 * timestamp columns, so an ephemeral key's expiry sorts/compares uniformly
 * with `created_at` / `revoked_at`. Pure so it can be unit-tested without D1.
 */
export function computeExpiresAt(nowMs: number, ttlSeconds: number): string {
  return new Date(nowMs + ttlSeconds * 1000).toISOString();
}

/**
 * Is a key with this `expires_at` past its lifetime as of `nowMs`?
 *
 *   - null         → never expires (every operator-minted key; legacy rows)
 *   - future stamp → still valid
 *   - past/equal   → expired (treated exactly like revoked at auth time)
 *
 * Pure (no clock of its own) so the boundary is unit-testable; the caller
 * supplies `Date.now()`. Unparseable stamps fail closed (treated as expired)
 * rather than silently granting access.
 */
export function isKeyExpired(expiresAt: string | null, nowMs: number): boolean {
  if (expiresAt === null) return false;
  const t = Date.parse(expiresAt);
  if (Number.isNaN(t)) return true; // fail closed on a malformed stamp
  return t <= nowMs;
}

/**
 * Resolve a Bearer token to an agent. Returns null on any failure — caller
 * issues a single uniform 401 so we don't leak which check tripped.
 *
 * Lookup is by `key_prefix` (indexed), and the secret is compared via
 * constant-time HMAC equality. Revoked keys return null; so do EXPIRED keys
 * (the short-lived credentials minted for the byte-exact curl path — see
 * `mintEphemeralKey` in src/admin.ts and migration 0007). Expiry is checked
 * on the single looked-up row in JS rather than in SQL so the lookup stays a
 * plain `key_prefix` index hit and the rule lives next to its `isKeyExpired`
 * helper.
 *
 * Terminology note: an `agents` row = an agent-driven client (a credentialed
 * connector instance), not a model/mind. The OAuth door (see src/mcp.ts /
 * src/oauth.ts) resolves to the *same* table — one OAuth client is pinned
 * to exactly one agents row, so provenance stamping is uniform across doors.
 */
export async function authenticateAgent(req: Request, env: Env): Promise<AgentAuth | null> {
  const token = bearerToken(req);
  if (!token) return null;
  const parsed = parseApiKey(token);
  if (!parsed) return null;
  if (!env.HMAC_PEPPER) return null;

  const row = await env.META.prepare(
    "select id, agent_id, key_hash, revoked_at, expires_at from agent_keys where key_prefix = ?",
  )
    .bind(parsed.prefix)
    .first<{
      id: string;
      agent_id: string;
      key_hash: string;
      revoked_at: string | null;
      expires_at: string | null;
    }>();
  if (!row || row.revoked_at || isKeyExpired(row.expires_at, Date.now())) return null;

  const expected = await hmacSha256Hex(parsed.secret, env.HMAC_PEPPER);
  if (!timingSafeEqual(expected, row.key_hash)) return null;

  return { agentId: row.agent_id, keyId: row.id };
}

/** Constant-time check against `OPERATOR_TOKEN`. */
export function authenticateOperator(req: Request, env: Env): boolean {
  const token = bearerToken(req);
  if (!token || !env.OPERATOR_TOKEN) return false;
  return timingSafeEqual(token, env.OPERATOR_TOKEN);
}
