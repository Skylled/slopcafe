/**
 * Worker bindings, in one place so route modules don't need to import from
 * each other. Kept in sync with wrangler.toml.
 */
export interface Env {
  /** R2 bucket holding sanitized HTML bytes (one object per version). */
  DOCS: R2Bucket;
  /** D1 database: documents, versions, agents, agent_keys. */
  META: D1Database;

  // Non-secret config from [vars].
  SANITIZER_VERSION: string;
  STORAGE_CAP_BYTES: string;

  // Secrets — set via `wrangler secret put`.
  /** Server pepper for HMAC-SHA256 over API key secrets. */
  HMAC_PEPPER?: string;
  /** Single operator token used to mint agents/keys and revoke documents. */
  OPERATOR_TOKEN?: string;
}
