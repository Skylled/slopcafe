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
  current_size: z.number().nullable(), // null when revoked (bytes purged)
  revoked_at: z.string().nullable(),
  ...metadataEcho,
  visibility: VisibilitySchema,
});
export type DocumentListing = z.infer<typeof DocumentListingSchema>;

/** A search hit — a DocumentListing plus BM25 attribution fields. */
export const SearchHitSchema = DocumentListingSchema.extend({
  score: z.number(),
  matched_field: z.enum(["title", "description", "body"]),
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
