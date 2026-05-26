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

/** Constant-time string equality. Length-mismatch fast-fails. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
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
 * Resolve a Bearer token to an agent. Returns null on any failure — caller
 * issues a single uniform 401 so we don't leak which check tripped.
 *
 * Lookup is by `key_prefix` (indexed), and the secret is compared via
 * constant-time HMAC equality. Revoked keys return null.
 */
export async function authenticateAgent(req: Request, env: Env): Promise<AgentAuth | null> {
  const token = bearerToken(req);
  if (!token) return null;
  const parsed = parseApiKey(token);
  if (!parsed) return null;
  if (!env.HMAC_PEPPER) return null;

  const row = await env.META.prepare(
    "select id, agent_id, key_hash, revoked_at from agent_keys where key_prefix = ?",
  )
    .bind(parsed.prefix)
    .first<{ id: string; agent_id: string; key_hash: string; revoked_at: string | null }>();
  if (!row || row.revoked_at) return null;

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
