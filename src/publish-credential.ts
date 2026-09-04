// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/**
 * Short-lived publish credentials for the MCP byte-exact curl path.
 *
 * This is agent-scoped credential plumbing, not an operator-admin endpoint.
 * The caller supplies an already-authenticated agent identity; the resulting
 * normal `awh_` key grants the same fleet authority for a bounded lifetime.
 */

import { recordAudit } from "./audit.js";
import { computeExpiresAt, hmacSha256Hex } from "./auth.js";
import type { Env } from "./env.js";
import { newApiKey, newUuid } from "./ids.js";
import type { WaitUntil } from "./vector-io.js";

/** Matches the OAuth access-token lifetime: 15 minutes. */
export const PUBLISH_CREDENTIAL_DEFAULT_TTL_SECONDS = 900;
/** A requested credential can never become a near-permanent agent key. */
export const PUBLISH_CREDENTIAL_MAX_TTL_SECONDS = 3600;
/** Sub-minute keys are not useful and only churn the key table. */
export const PUBLISH_CREDENTIAL_MIN_TTL_SECONDS = 60;

export type MintPublishCredentialOk = {
  ok: true;
  keyId: string;
  key: string;
  expiresAt: string;
};
export type MintPublishCredentialErr = { ok: false; code: "misconfigured" };

/**
 * Mint a short-lived key for an already-authenticated agent. The caller passes
 * a schema-validated TTL, but this boundary clamps it again so a future caller
 * cannot bypass the lifetime policy. Plaintext is returned exactly once and
 * never written to the audit ledger.
 */
export async function mintPublishCredential(
  env: Env,
  agentId: string,
  ttlSeconds: number,
  waitUntil?: WaitUntil,
): Promise<MintPublishCredentialOk | MintPublishCredentialErr> {
  if (!env.HMAC_PEPPER) return { ok: false, code: "misconfigured" };

  const ttl = Math.min(
    Math.max(Math.floor(ttlSeconds), PUBLISH_CREDENTIAL_MIN_TTL_SECONDS),
    PUBLISH_CREDENTIAL_MAX_TTL_SECONDS,
  );
  const expiresAt = computeExpiresAt(Date.now(), ttl);

  const keyId = newUuid();
  const key = newApiKey();
  const keyHash = await hmacSha256Hex(key.secret, env.HMAC_PEPPER);

  await env.META.prepare(
    "insert into agent_keys (id, agent_id, key_prefix, key_hash, expires_at) values (?, ?, ?, ?, ?)",
  )
    .bind(keyId, agentId, key.prefix, keyHash, expiresAt)
    .run();

  recordAudit(env, waitUntil, {
    kind: "agent_key_minted",
    principal_kind: "agent",
    agent_id: agentId,
    key_id: keyId,
    ephemeral: true,
  });

  return { ok: true, keyId, key: key.plaintext, expiresAt };
}
