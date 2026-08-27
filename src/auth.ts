// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/**
 * Authentication primitives: Bearer parsing, HMAC, and the three principals the
 * API knows about — agents (per-key), the operator (single token), and READERS
 * (per-person tokens from `READER_TOKENS`, a read-only human tier).
 *
 * It also owns the two comma-separated config lists that gate the fork's
 * single-publisher posture: `READER_TOKENS` (who may read as a human) and
 * `WRITER_AGENT_IDS` (which agents may write). Both parse through the same
 * `parseTokenList`, and `agentMayWrite` is the one predicate behind the
 * `read_only_agent` error.
 */

import type { Author } from "./access.js";
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

// ============================================================================
// Comma-separated config lists — the reader tier and the writer allowlist
// ============================================================================

/**
 * Parse a comma-separated config value into a de-duplicated list of non-empty,
 * trimmed entries. Shared by `READER_TOKENS` (a secret) and `WRITER_AGENT_IDS`
 * (a [var]) so the two settings can never disagree about what "empty" or
 * "trailing comma" means.
 *
 * Empty/unset/whitespace-only → `[]`, and `[]` is what BOTH features read as
 * "feature off": no reader tier, no write allowlist. That direction is
 * deliberate for the allowlist (a typo'd var must not lock the publisher out of
 * its own corpus) and harmless for the reader tier (a typo'd secret means nobody
 * can sign in as a reader, which fails closed).
 *
 * Pure — no env, no crypto — so the parsing rules are unit-testable on their own.
 */
export function parseTokenList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const v = part.trim();
    if (v.length > 0 && !out.includes(v)) out.push(v);
  }
  return out;
}

/**
 * Constant-time lookup of a candidate credential in a list of reader tokens.
 * Returns the MATCHED TOKEN (so the caller can derive a per-person identity from
 * it), or null.
 *
 * Two properties matter here and both are easy to lose:
 *
 *   1. Each comparison uses `timingSafeEqual` — the same hardened, no-length-
 *      fast-fail primitive the operator token gets. Reader tokens are
 *      operator-CHOSEN secrets exactly like `OPERATOR_TOKEN`, so they inherit
 *      the same length-oracle argument (see that function's docstring).
 *   2. NO EARLY EXIT. The loop walks the whole list and keeps the first match in
 *      a variable, so the time taken doesn't reveal WHICH reader matched (or how
 *      far down the list a near-miss got). With a handful of readers the cost is
 *      a few string compares.
 *
 * An empty `tokens` list always returns null — the feature-off state.
 */
export function matchTokenInList(candidate: string | null | undefined, tokens: readonly string[]): string | null {
  if (!candidate) return null;
  let matched: string | null = null;
  for (const t of tokens) {
    // Deliberately not short-circuiting: `timingSafeEqual` runs for every entry.
    if (timingSafeEqual(candidate, t) && matched === null) matched = t;
  }
  return matched;
}

/** The configured reader tokens (`READER_TOKENS`); `[]` = the tier is off. */
export function readerTokens(env: Env): string[] {
  return parseTokenList(env.READER_TOKENS);
}

/**
 * Resolve a Bearer/pasted credential to the reader token that matches it, or
 * null. `null` covers all of: no credential, the tier disabled, and a wrong
 * token — the caller must not distinguish them.
 */
export function matchReaderToken(candidate: string | null | undefined, env: Env): string | null {
  return matchTokenInList(candidate, readerTokens(env));
}

/**
 * The configured single-publisher write allowlist (`WRITER_AGENT_IDS`).
 * An EMPTY set means "no allowlist configured" → every agent may write, which is
 * the pre-feature behavior and the reason a deployment keeps working before the
 * var is ever set.
 */
export function writerAgentIds(env: Env): ReadonlySet<string> {
  return new Set(parseTokenList(env.WRITER_AGENT_IDS));
}

/**
 * MAY THIS AUTHOR WRITE? The single predicate behind `403 read_only_agent`.
 *
 *   - operator            → always true. `WRITER_AGENT_IDS` constrains the AGENT
 *                           fleet; the operator is a separate principal with its
 *                           own door (`POST`/`PUT /admin/documents…`, restore,
 *                           the manage-page forms) and its own credential.
 *   - allowlist empty     → true (feature off; whole-fleet trust as before).
 *   - agent on the list   → true.
 *   - agent NOT on it     → FALSE. Reads are unaffected; only the write cores
 *                           consult this.
 *
 * Pure (env + author in, boolean out) so it is unit-testable without D1, and
 * called from the shared write cores in src/core.ts rather than from any route
 * handler — a new door that routes through core inherits the rule for free, and
 * one that does NOT route through core is already violating the project's
 * "add new write surfaces in core" rule.
 */
export function agentMayWrite(env: Env, author: Author): boolean {
  if (author.kind === "operator") return true;
  const allow = writerAgentIds(env);
  if (allow.size === 0) return true;
  return allow.has(author.agentId);
}
