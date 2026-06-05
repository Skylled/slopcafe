/**
 * src/contract.ts — the single, machine-readable source of truth for the API
 * contract (Phase 1 of api-contract-design.md).
 *
 * Everything an external consumer must agree with us on — the document/response
 * data shapes and the canonical error-code vocabulary — is declared here ONCE as
 * Zod schemas. The hand-written TypeScript types that used to live in core.ts are
 * now `z.infer<>` of these schemas (re-exported from core.ts so every existing
 * `import { DocumentListing } from "./core.js"` keeps working), so the code is
 * checked against the same contract a future OpenAPI document + generated clients
 * are built from (Phase 2). When a shape changes, it changes in one place.
 *
 * This module is a LEAF by design: its only runtime import is `zod`. The
 * `import type` lines below are erased at compile time (and by the Node
 * strip-types test runner), so contract.ts pulls in no D1/R2/WASM — it runs
 * standalone under `test/contract.test.mjs`, exactly like search.ts / edit.ts /
 * conditional.ts / vector.ts.
 *
 * Scope note (Phase 1): these schemas describe the INTERNAL core result shapes
 * (the `{ ok: true, ... }`-tagged Result types core functions return). The HTTP
 * wrappers already strip `ok` and map a few field names (e.g. revoke's
 * `ok`→`revoked`), so the on-the-wire JSON differs slightly from these internal
 * types — that wire/internal split is modelled in Phase 2 (the OpenAPI surface +
 * a shared response-mapper). See api-contract-design.md §6.
 */
import { z } from "zod";
// Type-only imports (fully erased — no runtime coupling). They exist purely to
// pin the mirrored scalar schemas below to their canonical definitions, so a
// change to access.ts's Visibility or metadata.ts's SlugReject that isn't
// reflected here fails `tsc` instead of silently drifting.
import type { Visibility } from "./access.js";
import type { SlugReject } from "./metadata.js";

// --- compile-time drift guards ----------------------------------------------
// `Assert<Equal<A, B>>` is `true` only when A and B are structurally identical.
// Used below to prove a mirrored Zod enum still matches the type it mirrors.
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

// ============================================================================
// Error vocabulary
// ============================================================================

/**
 * The complete set of machine-readable `error` codes any HTTP response can
 * carry. This is the canonical vocabulary — `jsonError` (src/index.ts) and
 * `operatorError` (src/session.ts) both take `code: ErrorCode`, so a typo or an
 * unlisted code is a compile error at the emission site. (A handful of codes are
 * also emitted via direct `Response.json({ error })` in serve.ts; the
 * source-scan check in test/contract.test.mjs guards those.)
 *
 * Keep alphabetical — it's the documented vocabulary and the order a generated
 * client's enum will follow.
 */
export const ErrorCodeSchema = z.enum([
  "bad_cursor",
  "bad_integrity_header",
  "bad_json",
  "bad_limit",
  "bad_query",
  "bad_request",
  "bad_slug",
  "bad_target",
  "client_exists",
  "csrf_failed",
  "empty_body",
  "gone",
  "integrity_mismatch",
  "internal",
  "invalid_slug",
  "invalid_visibility",
  "misconfigured",
  "not_found",
  "precondition_failed",
  "precondition_required",
  "slug_redirected",
  "slug_retired",
  "slug_taken",
  "source_unavailable",
  "storage_cap_exceeded",
  "too_large",
  "unauthorized",
  "unsupported_media_type",
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

/**
 * The base error envelope every JSON error shares: `{ error, message }`. Some
 * codes add context fields (e.g. `slug_taken` adds `slug`, `precondition_failed`
 * adds `current_version`/`expected`) — that per-code discriminated union is
 * modelled in Phase 2 (it's what a generated client narrows on). Phase 1 pins
 * the discriminant (`error`) and the shared `message`.
 */
export const ErrorEnvelopeSchema = z.object({
  error: ErrorCodeSchema,
  message: z.string(),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;

// ============================================================================
// Shared scalars
// ============================================================================

/** Which input pipeline produced a version's stored bytes. */
export const SourceFormatSchema = z.enum(["html", "markdown"]);
export type SourceFormat = z.infer<typeof SourceFormatSchema>;

/** Per-document public/private axis (migration 0011). Mirrors access.ts. */
export const VisibilitySchema = z.enum(["public", "private"]);
/** Compile-time guard: fails `tsc` if VisibilitySchema drifts from access.ts's Visibility. */
export type VisibilityMirrorsAccess = Assert<Equal<z.infer<typeof VisibilitySchema>, Visibility>>;

/** Why a slug input was rejected (the `invalid_slug` error's `reason`). Mirrors metadata.ts. */
export const SlugRejectSchema = z.enum([
  "too_long",
  "bad_charset",
  "must_start_alnum",
  "must_end_alnum",
  "empty",
]);
/** Compile-time guard: fails `tsc` if SlugRejectSchema drifts from metadata.ts's SlugReject. */
export type SlugRejectMirrorsMetadata = Assert<Equal<z.infer<typeof SlugRejectSchema>, SlugReject>>;

// The metadata tail (`title`/`description`/`tags`/`slug`) echoed on every write
// and read result. Title/description are per-version (nullable); tags/slug are
// document-level. Factored out so the shape stays identical across shapes.
const metadataEcho = {
  title: z.string().nullable(),
  description: z.string().nullable(),
  tags: z.array(z.string()),
  slug: z.string().nullable(),
};

// ============================================================================
// Data-model shapes (listing / search / version history / slug tombstones)
// ============================================================================

/** One listing row — the projection shared by list, search, and slug lookup. */
export const DocumentListingSchema = z.object({
  public_id: z.string(),
  current_ver: z.number().nullable(), // null on a revoked doc
  created_at: z.string(),
  created_by_id: z.string().nullable(),
  created_by_name: z.string().nullable(),
  // The creator's principal kind (migration 0013). "operator" when the operator
  // authored the document (created_by_id is then null — the operator has no
  // agent row); "agent" otherwise. Disambiguates a null created_by_id that
  // means "operator" from one that means "agent since deleted".
  created_by_kind: z.enum(["agent", "operator"]),
  current_size: z.number().nullable(), // null when revoked (bytes purged)
  revoked_at: z.string().nullable(),
  ...metadataEcho,
  visibility: VisibilitySchema,
});
export type DocumentListing = z.infer<typeof DocumentListingSchema>;

/**
 * A search hit — a DocumentListing plus attribution fields.
 *
 * `score`: higher = better. In `keyword` mode it's the negated BM25 value; in
 * `hybrid` mode it's the fused Reciprocal-Rank-Fusion score; in `semantic` mode
 * it's the cosine similarity. The scale differs by mode and is only meaningful
 * WITHIN one result set (vector-search-design.md §11).
 *
 * `matched_field`: which signal surfaced the hit. `title`/`description`/`body`
 * are the FTS columns (a hit matched by both FTS and semantic keeps its FTS
 * attribution — the more informative signal). `semantic` is a vector-only hit
 * (no FTS bracket to attribute).
 *
 * `snippet`: for an FTS-attributed hit, the matched column's `snippet()` output
 * with `[bracketed]` match terms. For a `semantic` hit, the matched chunk's
 * ~256-char preview — the passage whose vector matched — deliberately NOT
 * bracketed (the absence of brackets signals "concept match, not term match").
 */
export const SearchHitSchema = DocumentListingSchema.extend({
  score: z.number(),
  matched_field: z.enum(["title", "description", "body", "semantic"]),
  snippet: z.string(),
});
export type SearchHit = z.infer<typeof SearchHitSchema>;

/** One row of a document's version history (pure D1 metadata, no R2 fetch). */
export const VersionListingSchema = z.object({
  version_no: z.number(),
  created_at: z.string(),
  size_bytes: z.number(),
  source_size_bytes: z.number().nullable(), // null for pre-0008 versions
  sanitizer_v: z.string(),
  source_format: SourceFormatSchema,
  title: z.string().nullable(),
  is_current: z.boolean(),
  source_present: z.boolean(),
  // Per-version authorship (migration 0013) — the queryable replacement for the
  // old R2-customMetadata-only writer tag, so a document's full author list is
  // surfaceable. `author_kind` is "operator" or "agent"; `author_id` is the
  // writing agent's id (null for an operator-written version, OR an agent
  // version since deleted); `author_name` is that agent's display name (null for
  // operator). Pre-0013 versions read back as kind "agent" with a null id/name
  // (the true historical writer survives only in R2 customMetadata).
  author_kind: z.enum(["agent", "operator"]),
  author_id: z.string().nullable(),
  author_name: z.string().nullable(),
});
export type VersionListing = z.infer<typeof VersionListingSchema>;

/** Display info for a retired slug's redirect target (the live doc it points at). */
export const RedirectTargetSchema = z.object({
  public_id: z.string(),
  slug: z.string().nullable(),
  title: z.string().nullable(),
});
export type RedirectTarget = z.infer<typeof RedirectTargetSchema>;

/** A retired-slug tombstone row (migration 0009/0010). */
export const SlugTombstoneSchema = z.object({
  slug: z.string(),
  document_id: z.string().nullable(),
  retired_at: z.string(),
  reason: z.string(),
  redirect_to: z.string().nullable(),
});
export type SlugTombstone = z.infer<typeof SlugTombstoneSchema>;

// ============================================================================
// Core result shapes (the `{ ok: true, ... }` success returns)
// ============================================================================

/** Successful write (publish/update) — body + resolved metadata. */
export const WriteOkSchema = z.object({
  ok: z.literal(true),
  public_id: z.string(),
  url: z.string(),
  version: z.number(),
  size_bytes: z.number(),
  sanitizer_v: z.string(),
  modified: z.boolean(),
  stripped: z.array(z.string()),
  will_not_render: z.array(z.string()),
  ...metadataEcho,
});
export type WriteOk = z.infer<typeof WriteOkSchema>;

/** Successful edit — a WriteOk plus the find/replace count. */
export const EditOkSchema = WriteOkSchema.extend({ replacements: z.number() });
export type EditOk = z.infer<typeof EditOkSchema>;

/** Successful restore — a WriteOk plus the version restored FROM. */
export const RestoreOkSchema = WriteOkSchema.extend({ restored_from: z.number() });
export type RestoreOk = z.infer<typeof RestoreOkSchema>;

/** Buffered HTML read of one version. `bytes` is the sanitized H blob. */
export const ReadOkSchema = z.object({
  ok: z.literal(true),
  bytes: z.instanceof(Uint8Array),
  version_no: z.number(),
  sanitizer_v: z.string(),
  source_format: SourceFormatSchema,
  source_r2_key: z.string().nullable(), // null on legacy/un-backfilled rows
  ...metadataEcho,
});
export type ReadOk = z.infer<typeof ReadOkSchema>;

/** Markdown read — the sanitized HTML converted on the fly. */
export const ReadTextOkSchema = z.object({
  ok: z.literal(true),
  text: z.string(),
  version_no: z.number(),
  sanitizer_v: z.string(),
  converter_v: z.string(),
  ...metadataEcho,
});
export type ReadTextOk = z.infer<typeof ReadTextOkSchema>;

/** Source read — the retained, UNSANITIZED source S plus advisories re-derived from it. */
export const ReadSourceOkSchema = z.object({
  ok: z.literal(true),
  source: z.string(),
  source_format: SourceFormatSchema,
  version_no: z.number(),
  sanitizer_v: z.string(),
  stripped: z.array(z.string()),
  will_not_render: z.array(z.string()),
  ...metadataEcho,
});
export type ReadSourceOk = z.infer<typeof ReadSourceOkSchema>;

/** Version-history manifest. */
export const ListVersionsOkSchema = z.object({
  ok: z.literal(true),
  public_id: z.string(),
  current_ver: z.number(),
  versions: z.array(VersionListingSchema),
});
export type ListVersionsOk = z.infer<typeof ListVersionsOkSchema>;

/** Successful revoke (the core result; the HTTP wrapper renames `ok`→`revoked`). */
export const RevokeOkSchema = z.object({
  ok: z.literal(true),
  public_id: z.string(),
  r2_objects_purged: z.number(),
});
export type RevokeOk = z.infer<typeof RevokeOkSchema>;

// ============================================================================
// Wire response shapes (Phase 2) — what the HTTP/MCP handlers actually emit
// ============================================================================
// The core Result schemas above carry an internal `ok: true` tag (and revoke
// names its success flag `ok`); the handlers strip/rename that before the bytes
// reach the wire (see api-contract-design.md §6, the Phase-1 scope note above).
// These are those on-the-wire shapes — the single source the OpenAPI components
// in `src/openapi.ts` are generated from. Each is DERIVED from its Result schema
// where possible (`.omit({ ok: true })`), so a field added to a Result above
// flows here automatically and the wire/internal split stays a one-line edit.

/** POST /d (201) and PUT /d/:id (200) — WriteOk minus the internal `ok` tag. */
export const WriteResponseSchema = WriteOkSchema.omit({ ok: true });
export type WriteResponse = z.infer<typeof WriteResponseSchema>;

/** MCP `edit_document` envelope — EditOk minus `ok`. MCP-only (no HTTP PATCH). */
export const EditResponseSchema = EditOkSchema.omit({ ok: true });
export type EditResponse = z.infer<typeof EditResponseSchema>;

/** MCP restore envelope — RestoreOk minus `ok`. (The HTTP `POST /d/:id/restore`
 * is a browser form that returns HTML, not this JSON.) */
export const RestoreResponseSchema = RestoreOkSchema.omit({ ok: true });
export type RestoreResponse = z.infer<typeof RestoreResponseSchema>;

/** MCP `read_document` (format:"markdown") envelope — ReadTextOk minus `ok`.
 * (The HTTP `GET /d/:id/text` route returns raw `text/markdown`, not this JSON —
 * so this shape backs the MCP door only; see api-contract-design.md §7.) */
export const ReadTextResponseSchema = ReadTextOkSchema.omit({ ok: true });
export type ReadTextResponse = z.infer<typeof ReadTextResponseSchema>;

/** GET /d/:id/source (200) — ReadSourceOk minus `ok`, plus the explicit
 * `unsanitized: true` provenance marker the handler ADDS (serve.ts/serveSource +
 * MCP `read_document representation:"source"`). */
export const ReadSourceResponseSchema = ReadSourceOkSchema.omit({ ok: true }).extend({
  unsanitized: z.literal(true),
});
export type ReadSourceResponse = z.infer<typeof ReadSourceResponseSchema>;

/** MCP `read_document` (include_history) manifest — ListVersionsOk minus `ok`. */
export const ListVersionsResponseSchema = ListVersionsOkSchema.omit({ ok: true });
export type ListVersionsResponse = z.infer<typeof ListVersionsResponseSchema>;

/** DELETE /d/:id (200) — RevokeOk with the success flag renamed `ok`→`revoked`. */
export const RevokeResponseSchema = z.object({
  revoked: z.literal(true),
  public_id: z.string(),
  r2_objects_purged: z.number(),
});
export type RevokeResponse = z.infer<typeof RevokeResponseSchema>;

// --- list / search wrappers (reference the model shapes above) --------------

/** GET /admin/documents (200) and MCP `list_documents`. Cursor-paginated. */
export const ListDocumentsResponseSchema = z.object({
  documents: z.array(DocumentListingSchema),
  next_cursor: z.string().nullable(),
});
export type ListDocumentsResponse = z.infer<typeof ListDocumentsResponseSchema>;

/** GET /admin/documents/search (200) and MCP `search_documents` — NOT
 * paginated, so there is deliberately no `next_cursor` (see search.ts). */
export const SearchDocumentsResponseSchema = z.object({
  documents: z.array(SearchHitSchema),
});
export type SearchDocumentsResponse = z.infer<typeof SearchDocumentsResponseSchema>;

// --- inline handler shapes (were object literals in the route handlers) -----

/** GET /healthz (200) — bindings + migration smoke check. */
export const HealthzResponseSchema = z.object({
  ok: z.literal(true),
  service: z.string(),
  sanitizer_version: z.string(),
  storage_cap_bytes: z.number(),
  d1: z.object({
    documents: z.number().nullable(),
    agents: z.number().nullable(),
  }),
  r2: z.object({
    bucket_reachable: z.boolean(),
    sample_object_count: z.number(),
  }),
});
export type HealthzResponse = z.infer<typeof HealthzResponseSchema>;

/** One row of GET /admin/agents. */
const AgentSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  created_at: z.string(),
  active_keys: z.number(),
  total_keys: z.number(),
  live_docs: z.number(),
});

/** GET /admin/agents (200) — cursor-paginated. */
export const ListAgentsResponseSchema = z.object({
  agents: z.array(AgentSummarySchema),
  next_cursor: z.string().nullable(),
});
export type ListAgentsResponse = z.infer<typeof ListAgentsResponseSchema>;

/** One row of GET /admin/agents/:id/keys. */
const AgentKeySummarySchema = z.object({
  id: z.string(),
  key_prefix: z.string(),
  created_at: z.string(),
  revoked_at: z.string().nullable(),
});

/** GET /admin/agents/:id/keys (200) — cursor-paginated. */
export const ListAgentKeysResponseSchema = z.object({
  agent_id: z.string(),
  name: z.string(),
  keys: z.array(AgentKeySummarySchema),
  next_cursor: z.string().nullable(),
});
export type ListAgentKeysResponse = z.infer<typeof ListAgentKeysResponseSchema>;

/** POST /admin/agents (201) and POST /admin/agents/:id/keys (201). `key` is the
 * one-time plaintext secret — the server never returns it again. */
export const MintAgentKeyResponseSchema = z.object({
  agent_id: z.string(),
  key_id: z.string(),
  key: z.string(),
  note: z.string(),
});
export type MintAgentKeyResponse = z.infer<typeof MintAgentKeyResponseSchema>;

/** DELETE /admin/agents/:id (200) — cascading agent kill. */
export const RevokeAgentResponseSchema = z.object({
  revoked: z.literal(true),
  agent_id: z.string(),
  keys_revoked: z.number(),
  oauth_clients_deleted: z.number(),
});
export type RevokeAgentResponse = z.infer<typeof RevokeAgentResponseSchema>;

/** DELETE /admin/keys/:id (200) — per-key revoke. */
export const RevokeKeyResponseSchema = z.object({
  revoked: z.literal(true),
  key_id: z.string(),
  agent_id: z.string(),
  key_prefix: z.string(),
});
export type RevokeKeyResponse = z.infer<typeof RevokeKeyResponseSchema>;

/** POST /admin/documents/:id/visibility (200). */
export const SetDocumentVisibilityResponseSchema = z.object({
  public_id: z.string(),
  visibility: VisibilitySchema,
});
export type SetDocumentVisibilityResponse = z.infer<typeof SetDocumentVisibilityResponseSchema>;

/** POST /admin/documents/:id/slug (200). `retired` is the prior slug forwarded
 * into a tombstone (null on a first claim); `redirected` is true on a rename. */
export const SetDocumentSlugResponseSchema = z.object({
  public_id: z.string(),
  slug: z.string().nullable(),
  retired: z.string().nullable(),
  redirected: z.boolean(),
});
export type SetDocumentSlugResponse = z.infer<typeof SetDocumentSlugResponseSchema>;

/** POST /admin/documents/:id/tags (200) — full replacement, sanitized shape. */
export const SetDocumentTagsResponseSchema = z.object({
  public_id: z.string(),
  tags: z.array(z.string()),
});
export type SetDocumentTagsResponse = z.infer<typeof SetDocumentTagsResponseSchema>;

/** POST /admin/vectors/backfill (200) — one page of the Vectorize backfill /
 * reconciliation sweep (vector-search-design.md §8). `next_cursor` non-null →
 * more pages (re-invoke with `?cursor=`). `vectors ≪ embedded` signals a
 * transient sync failure (re-run). */
export const BackfillResponseSchema = z.object({
  mode: z.enum(["missing", "rebuild"]),
  scanned: z.number(),
  embedded: z.number(),
  vectors: z.number(),
  skipped: z.number(),
  next_cursor: z.string().nullable(),
});
export type BackfillResponse = z.infer<typeof BackfillResponseSchema>;

/** POST /admin/slugs/:slug/redirect (200) — retired slug now forwards. */
export const SetSlugRedirectResponseSchema = z.object({
  slug: z.string(),
  redirect_to: z.string(),
  target_slug: z.string().nullable(),
  target_title: z.string().nullable(),
});
export type SetSlugRedirectResponse = z.infer<typeof SetSlugRedirectResponseSchema>;

/** DELETE /admin/slugs/:slug/redirect (200) — redirect dropped (back to 410). */
export const ClearSlugRedirectResponseSchema = z.object({
  slug: z.string(),
  redirect_to: z.null(),
});
export type ClearSlugRedirectResponse = z.infer<typeof ClearSlugRedirectResponseSchema>;

/** DELETE /admin/slugs/:slug (200) — force-release escape hatch. */
export const ReleaseSlugTombstoneResponseSchema = z.object({
  released: z.literal(true),
  slug: z.string(),
});
export type ReleaseSlugTombstoneResponse = z.infer<typeof ReleaseSlugTombstoneResponseSchema>;

/** POST /admin/agents/:id/oauth-clients (201). `client_secret` is one-time. */
export const CreateOAuthClientResponseSchema = z.object({
  client_id: z.string(),
  client_secret: z.string(),
  mcp_url: z.string(),
  agent_id: z.string(),
  agent_name: z.string(),
  note: z.string(),
});
export type CreateOAuthClientResponse = z.infer<typeof CreateOAuthClientResponseSchema>;

/** POST /admin/oauth-clients (201) — unbound mint. `client_secret` one-time. */
export const CreateUnboundOAuthClientResponseSchema = z.object({
  client_id: z.string(),
  client_secret: z.string(),
  mcp_url: z.string(),
  note: z.string(),
});
export type CreateUnboundOAuthClientResponse = z.infer<typeof CreateUnboundOAuthClientResponseSchema>;

/** DELETE /admin/oauth-clients/:id (200) — bound vs unbound teardown. The two
 * variants differ by which trailing field is present (`agent_id` vs `unbound`),
 * so this is a plain union, not a single-discriminant one. */
export const DeleteOAuthClientResponseSchema = z.union([
  z.object({ revoked: z.literal(true), client_id: z.string(), agent_id: z.string() }),
  z.object({ revoked: z.literal(true), client_id: z.string(), unbound: z.literal(true) }),
]);
export type DeleteOAuthClientResponse = z.infer<typeof DeleteOAuthClientResponseSchema>;

// ============================================================================
// Error body — the discriminated union a consumer narrows on
// ============================================================================
// Every JSON error shares `{ error, message }`; some codes add context fields.
// Phase 1 pinned the discriminant + the shared `message` (ErrorEnvelopeSchema);
// this is the full per-code union an OpenAPI client switches on. Built as a
// `z.discriminatedUnion("error", …)` so codegen emits a tagged `oneOf` and the
// consumer narrows context by `error`. The context-free codes are generated
// from the enum (every code NOT listed with context below), so adding a code to
// ErrorCodeSchema automatically grows this union — it can't silently lag.

/** The codes that carry extra context fields beyond `{ error, message }`. */
const ERROR_CONTEXT = {
  slug_taken: z.object({ slug: z.string() }),
  slug_retired: z.object({ slug: z.string() }),
  precondition_failed: z.object({ current_version: z.number(), expected: z.number() }),
  invalid_slug: z.object({ reason: SlugRejectSchema }),
  too_large: z.object({ limit: z.number() }),
  storage_cap_exceeded: z.object({
    used: z.number(),
    cap: z.number(),
    this_write: z.number(),
  }),
  slug_redirected: z.object({
    slug: z.string(),
    redirect_to: RedirectTargetSchema,
    hint: z.string(),
  }),
  bad_target: z.object({ target: z.string() }),
  client_exists: z.object({ client_id: z.string(), hint: z.string() }),
  integrity_mismatch: z.object({
    expected_sha256: z.string(),
    actual_sha256: z.string(),
    received_bytes: z.number(),
  }),
} as const;

const errorMember = (code: ErrorCode, extra?: z.ZodObject) => {
  const base = z.object({ error: z.literal(code), message: z.string() });
  return extra ? base.extend(extra.shape) : base;
};

const errorMembers = ErrorCodeSchema.options.map((code) =>
  errorMember(code, (ERROR_CONTEXT as Record<string, z.ZodObject | undefined>)[code]),
);

/**
 * The full error envelope: `{ error, message, ...code-specific context }`,
 * discriminated on `error`. One member per ErrorCode (context-free codes are
 * just `{ error, message }`).
 */
export const ErrorBodySchema = z.discriminatedUnion(
  "error",
  errorMembers as [z.ZodObject, z.ZodObject, ...z.ZodObject[]],
);
export type ErrorBody = z.infer<typeof ErrorBodySchema>;
