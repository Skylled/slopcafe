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

  // Secrets — set via `wrangler secret put`.
  /** Server pepper for HMAC-SHA256 over API key secrets. */
  HMAC_PEPPER?: string;
  /** Single operator token used to mint agents/keys and revoke documents. */
  OPERATOR_TOKEN?: string;
}
