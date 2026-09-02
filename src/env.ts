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
   * Vectorize semantic index (`slopcafe-docs`, 1024-dim cosine). Holds N
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
  /**
   * `public_id` of the document rendered at `/` (the public landing page).
   *
   * Per-deployment state, so it lives here rather than in tracked source
   * (issue #55): a fork's D1 contains none of the origin deployment's
   * documents, and the id used to be a constant in src/serve.ts — which made
   * `/` a permanent 404 on every fork until someone edited and redeployed.
   *
   * Unset or empty — the default — means "no homepage configured yet" and
   * renders a placeholder page, the same empty-is-off shape as
   * CORS_ALLOWED_ORIGINS. Read through `homepagePublicId(env)` in src/serve.ts,
   * the SINGLE reader, which also rejects anything failing PUBLIC_ID_RE
   * (the value is interpolated into HTML unescaped) and degrades to the
   * placeholder.
   *
   * The document must be PUBLIC: `/` is an anonymous surface, so a private id
   * here renders the placeholder rather than leaking the document.
   */
  HOMEPAGE_PUBLIC_ID?: string;

  // Secrets — set via `wrangler secret put`.
  /** Server pepper for HMAC-SHA256 over API key secrets. */
  HMAC_PEPPER?: string;
  /** Single operator token used to mint agents/keys and revoke documents. */
  OPERATOR_TOKEN?: string;
}
