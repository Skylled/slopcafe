// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/**
 * Worker bindings, in one place so route modules don't need to import from
 * each other. Kept in sync with wrangler.toml.
 */
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  /** R2 bucket holding sanitized HTML bytes (one object per version). */
  DOCS: R2Bucket;
  /** D1 database: documents, versions, agents, agent_keys, oauth_clients. */
  META: D1Database;
  /**
   * KV backing for workers-oauth-provider (clients, grants, issued tokens).
   * Injected at runtime by the OAuthProvider wrap — see src/oauth.ts.
   */
  OAUTH_KV: KVNamespace;
  /**
   * OAuth helpers (createClient/deleteClient/parseAuthRequest/
   * completeAuthorization/...) injected into env by the OAuthProvider wrap.
   * Available in both apiHandler and defaultHandler contexts.
   */
  OAUTH_PROVIDER: OAuthHelpers;

  /**
   * Workers AI — used only for query/document embeddings in hybrid search
   * (`env.AI.run(EMBED_MODEL, …)` in src/vector-io.ts). 1024-dim Qwen3, see
   * docs/design/vector-search-design.md §2/§3. Best-effort: an embed failure degrades search
   * to keyword-only, never a hard error.
   */
  AI: Ai;
  /**
   * Vectorize semantic index (`agent-web-host-docs`, 1024-dim cosine). Holds N
   * chunk vectors per document, keyed `${documents.id}#${i}` (src/vector.ts).
   * A candidate RANKER, never the access gate — vector hits are re-joined through
   * D1 (`revoked_at is null` + filters) exactly like FTS hits. Synced
   * best-effort off `ctx.waitUntil` after the D1 batch commits (it is NOT
   * transactional with D1; see docs/design/vector-search-design.md §5/§6).
   */
  VECTORIZE: Vectorize;

  // Non-secret config from [vars].
  STORAGE_CAP_BYTES: string;
  /**
   * Browser-session signing epoch (a rotation counter, NOT a secret). Mixed
   * into the session cookie's signing-key derivation in src/session.ts; bumping
   * it invalidates every existing session at once ("log everyone out"). Optional
   * — defaults to "1" in code via `sessionEpoch(env)`.
   */
  SESSION_EPOCH?: string;
  /**
   * Birth visibility for newly published documents — `"private"` (default) or
   * `"public"`. A deploy-time toggle (not a secret): flip it + redeploy to
   * change the default posture for new writes. Read through
   * `defaultDocumentVisibility(env)` in src/access.ts, which clamps any other
   * value back to `"private"` so an operator typo can't 500 every publish
   * against the migration 0011 CHECK constraint. This is ONLY the birth
   * default — the operator can still flip any individual document afterward
   * (POST /admin/documents/:id/visibility); agents never set visibility.
   */
  DEFAULT_DOCUMENT_VISIBILITY?: string;
  /**
   * SINGLE-PUBLISHER WRITE ALLOWLIST — a comma-separated list of `agents.id`
   * values (UUIDs) permitted to WRITE. Empty/unset = every active agent key may
   * write, which is the historical whole-fleet behavior and stays the default so
   * setting up the var is never a prerequisite for a working deployment.
   *
   * When non-empty, an agent NOT on the list gets `403 read_only_agent` from
   * every write core (publish/update/edit/set-tags/set-status) through BOTH
   * doors — see `agentMayWrite` in src/auth.ts and the guard at the top of each
   * write core in src/core.ts. READS are untouched: a non-writer agent key still
   * reads, lists, searches and packs exactly as before. Operator-authored writes
   * (`POST`/`PUT /admin/documents…`, restore, the manage-page forms) are NEVER
   * restricted by this var — the operator is not an agent.
   *
   * A `[var]`, not a secret: it names ids that are already visible in
   * `GET /admin/agents`, and it is deploy-time config the operator wants in
   * `wrangler.toml` next to the other posture toggles.
   */
  WRITER_AGENT_IDS?: string;
  /**
   * Comma-separated list of exact origins allowed to call this API from a
   * browser on ANOTHER origin (e.g. a Flutter Web build of the operator app).
   * Unset or empty — the default — means CORS is entirely OFF: the wrapper in
   * src/cors.ts adds nothing at all, so the Worker behaves exactly as it did
   * before cross-origin support existed.
   *
   * Read through `corsAllowedOrigins(env)` in src/cors.ts, which is the SINGLE
   * reader (same discipline as `storageCapBytes` for `STORAGE_CAP_BYTES`) — it
   * normalizes each entry to a canonical http(s) origin and drops anything that
   * isn't one, with a log line. `*` is not a wildcard; it fails to parse and
   * leaves CORS off. Matching is EXACT, so `https://slopcafe.com` never admits
   * `https://slopcafe.com.evil.example`.
   *
   * Cross-origin callers are **bearer-only**: no `Access-Control-Allow-
   * Credentials` is ever emitted, so the operator's session cookies can neither
   * be sent nor read across origins. See the header of src/cors.ts for why that
   * is the load-bearing rule and not a nicety.
   */
  CORS_ALLOWED_ORIGINS?: string;

  // Secrets — set via `wrangler secret put`.
  /** Server pepper for HMAC-SHA256 over API key secrets. */
  HMAC_PEPPER?: string;
  /** Single operator token used to mint agents/keys and revoke documents. */
  OPERATOR_TOKEN?: string;
  /**
   * READER-TIER CREDENTIALS — a comma-separated list of per-person tokens, each
   * of which buys a READ-ONLY browser session (or a read-only Bearer) over the
   * whole corpus, private documents included. Empty/unset = the tier does not
   * exist and nothing changes (mainline behavior).
   *
   * PER-PERSON on purpose: one token per human, so a leak is revoked by deleting
   * that ONE entry from the list — every other reader's sessions survive. The
   * session cookie records a fingerprint of the token that minted it
   * (`deriveReaderId` in src/session.ts), so removing an entry invalidates
   * exactly that person's live sessions and no one else's.
   *
   * A reader is NOT an operator: it never passes `requireOperator`,
   * `authorizeOperatorForm`, or any agent-key gate, so no mutation, credential
   * or agent-management surface is reachable with one. See the reader-tier
   * section of docs/security-model.md.
   */
  READER_TOKENS?: string;
}
