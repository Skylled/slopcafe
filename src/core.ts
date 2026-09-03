// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/**
 * Core write/read/list/revoke operations against D1 + R2, without any
 * Request/Response or auth coupling. The caller (HTTP handler in
 * src/index.ts or MCP tool in src/mcp.ts) is responsible for resolving an
 * agent identity; these functions trust the `agentId` they receive and
 * stamp it as the document creator / version author.
 *
 * Two callers, one path: sanitization runs exactly once, inside core,
 * regardless of which surface the bytes arrived through. This is the
 * extraction promised in plans/playful-stirring-deer.md §"Step 8".
 */

import { detectAdvisories } from "./advisories.js";
import { type Author, defaultDocumentVisibility, type Visibility } from "./access.js";
import { maxNestingDepth } from "./depth.js";
import { applyEdits, type EditSpec } from "./edit.js";
import type { Env } from "./env.js";
import { newPublicId, newUuid, PUBLIC_ID_RE } from "./ids.js";
import { type ListParams, paginate, type PublicationFilter } from "./pagination.js";
import {
  deriveTitleFromHtml,
  type DocumentMetadataInput,
  type ResolvedMetadata,
  sanitizeTagsInput,
  type SlugReject,
  validateDescriptionInput,
  validateSlugInput,
  isReservedSlug,
  validateTitleInput,
} from "./metadata.js";
import {
  converterVersion,
  htmlToMarkdown,
  markdownToHtml,
  maxDomDepth,
  sanitize,
  sanitizerVersion,
} from "./sanitizer.js";
import { type ExtractedLink, extractOutboundLinks } from "./pack.js";
import { sha256Hex } from "./integrity.js";
import { buildFtsMatchQuery } from "./search.js";
import { chunkEmbedInputs, reciprocalRankFusion } from "./vector.js";
import { SERVED_VER_SQL } from "./served-version.js";
import {
  deleteDocumentVector,
  embedQuery,
  presentDocIds,
  queryVectors,
  syncDocumentVector,
  type VectorCandidate,
  type WaitUntil,
} from "./vector-io.js";
// Response/data SHAPES now live in src/contract.ts as Zod schemas (the single
// source of truth — Phase 1 of docs/design/api-contract-design.md). We import the inferred
// types for local use in the function signatures below AND re-export them, so
// every existing `import { DocumentListing } from "./core.js"` keeps working.
// `import type` is erased, so this adds no runtime coupling to contract.ts.
import type {
  DocumentLinksOk,
  DocumentListing,
  DocumentStatus,
  EditOk,
  ListVersionsOk,
  OutboundLink,
  PackDocument,
  PackOmitted,
  PackResponse,
  ReadOk,
  ReadSourceOk,
  ReadTextOk,
  RedirectTarget,
  RestoreOk,
  RevokeOk,
  SearchHit,
  SlugTombstone,
  SourceFormat,
  VersionListing,
  WriteOk,
} from "./contract.js";

// Re-export so HTTP/MCP wrappers don't have to import from two places.
export type {
  DocumentLinksOk,
  DocumentListing,
  DocumentStatus,
  EditOk,
  ListVersionsOk,
  OutboundLink,
  PackDocument,
  PackOmitted,
  PackResponse,
  ReadOk,
  ReadSourceOk,
  ReadTextOk,
  RedirectTarget,
  RestoreOk,
  RevokeOk,
  SearchHit,
  SlugTombstone,
  SourceFormat,
  VersionListing,
  WriteOk,
};
export type { DocumentMetadataInput, ResolvedMetadata };
export type { EditSpec };

/** Per-document raw input cap. The per-fleet storage cap is enforced separately. */
export const MAX_INPUT_BYTES = 5 * 1024 * 1024; // 5 MiB

/**
 * Max node-nesting depth of the sanitized render H a write will accept. The
 * HTML→Markdown converter (FTS body at write, every markdown read) RECURSES,
 * and the deployed WASM build has a small (~1 MiB) stack, so a pathologically
 * deep document overflows it and hard-aborts the isolate (GitHub issue #41).
 * `sanitize()` is stack-safe (ammonia uses an explicit work-stack), so deep
 * input survives sanitization and would only blow up later, in `htmlToMarkdown`.
 * The write path measures depth (iteratively, stack-safe — `maxDomDepth`) and
 * REJECTS past this cap BEFORE the converter runs, so no depth-bomb reaches
 * storage (and no stored doc can crash a read). 512 is ~10× deeper than any
 * realistic document and ~20× below the converter's overflow threshold.
 */
export const MAX_DOM_DEPTH = 512;

/**
 * Which input format the caller sent. Stored on the versions row as
 * `source_format` so admin/list views can show provenance without inspecting
 * the bytes, AND so the edit path can re-render the retained source through
 * the matching pipeline (markdownToHtml for markdown, identity for html).
 *
 * Source retention (the (S, H) pair per version): the raw submitted bytes S
 * are now retained at the `.src` sibling of the sanitized H blob's key (both
 * recorded on the versions row — see putVersionBlobs for the key shape) —
 * convert-and-discard is NO LONGER the model. `source_format` is the tag that
 * tells a re-render which input pipeline produced this version, so it must stay
 * honest: an edit re-renders S through that pipeline and stores a fresh (S, H)
 * pair under the *same* source_format. The stored renderable H blob is still
 * always sanitized HTML; what changed is that S survives next to it.
 *
 * The trust boundary is identical for both: sanitize() runs on the
 * post-conversion HTML regardless of source format. S itself is by definition
 * the UNSANITIZED original and is only ever served behind an agent-key gate
 * (never the public render path).
 */
// SourceFormat — now defined in src/contract.ts (re-exported above).

// WriteOk — the shared "successful write" shape (publish/update). Defined in
// src/contract.ts (z.infer) and re-exported above. The `stripped` /
// `will_not_render` advisory arrays and the resolved title/description/tags/slug
// echo are documented on WriteOkSchema there.

/** Result codes the wrappers translate to HTTP statuses / model-readable text. */
export type PublishErr =
  | { ok: false; code: "empty_body" }
  | { ok: false; code: "too_large"; limit: number; size: number }
  | { ok: false; code: "too_deep"; limit: number; depth: number }
  | { ok: false; code: "storage_cap_exceeded"; used: number; cap: number; this_write: number }
  | { ok: false; code: "invalid_slug"; reason: SlugReject }
  | { ok: false; code: "slug_taken"; slug: string }
  // The slug was claimed by some document in the past and RETIRED (the doc was
  // revoked, or the slug was renamed/released). Slugs are not reusable — see
  // migration 0009 / slug_tombstones. Distinct from `slug_taken` (a *live*
  // collision) so the caller can tell "permanently spent" from "in use now."
  | { ok: false; code: "slug_retired"; slug: string };

export type UpdateErr =
  | PublishErr
  | { ok: false; code: "not_found" }
  | { ok: false; code: "version_conflict"; current_version: number; expected: number }
  // An AGENT tried to change the slug of a PUBLIC document (migration 0018,
  // GitHub issue #43). A public doc's slug is the address humans have already
  // shared and linked, and shedding it retires that name FOREVER (migration
  // 0009) — an irreversible, outward-facing change, which puts it on the
  // operator side of the same line `visibility` and revoke already sit on.
  // Content is untouched by this: an agent still rewrites the bytes of any
  // document it likes (single-tenant trust), it just can't move the doorplate
  // while the door is open. Operator writes (POST/PUT /admin/documents) and
  // setDocumentSlugCore (already operator-only) are unaffected.
  | { ok: false; code: "slug_locked" };

/**
 * Fallback fleet cap, used when `STORAGE_CAP_BYTES` is missing or unparseable.
 * Same value wrangler.toml(.example) ships, so a healthy deployment never
 * notices the fallback exists — it only matters for a typo'd [var].
 */
export const DEFAULT_STORAGE_CAP_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB

/**
 * The SINGLE reader of the `STORAGE_CAP_BYTES` [var] — normalizes it into a
 * usable byte count, FAILING CLOSED.
 *
 * `STORAGE_CAP_BYTES` is typed `string` on Env, which is a compile-time shape
 * guarantee and nothing more: an operator/forker editing wrangler.toml can
 * still land `"2 GiB"`, `""`, or delete the line entirely. The old inline
 * `Number(env.STORAGE_CAP_BYTES)` turned that into NaN, and every comparison
 * against NaN is false — so a typo silently DISABLED the fleet guardrail with
 * no log line, which is exactly the wrong direction to fail on a guardrail.
 *
 * Fail-closed here means "a cap is still enforced," not "all writes die": a
 * bad value falls back to `DEFAULT_STORAGE_CAP_BYTES` and screams in the logs.
 * A zero/negative value is treated as misconfiguration too (a deliberate
 * write-freeze is not a thing this [var] is for) rather than bricking publish.
 *
 * Everything that reads the cap goes through here — `checkStorageCap` below,
 * the operator console dashboard, and `/healthz` — so the three can never
 * disagree about what a bad value means.
 */
export function storageCapBytes(env: Env): number {
  const cap = Number(env.STORAGE_CAP_BYTES);
  if (!Number.isFinite(cap) || cap <= 0) {
    // Value only, never a secret — STORAGE_CAP_BYTES is a public [var].
    console.error("storage_cap.misconfigured", {
      value: env.STORAGE_CAP_BYTES,
      falling_back_to: DEFAULT_STORAGE_CAP_BYTES,
    });
    return DEFAULT_STORAGE_CAP_BYTES;
  }
  return Math.floor(cap);
}

/**
 * The timestamp expression every stamped column uses, as a SQL fragment.
 *
 * It MUST stay byte-identical to the `DEFAULT` on `documents.created_at` /
 * `versions.created_at` (migration 0001): every comparison in the system —
 * the cursor predicates, the `updated_since` window, the ORDER BYs — is a
 * lexicographic TEXT compare, which only tracks chronology while every producer
 * emits the same zero-padded UTC shape. One statement writing an unpadded or
 * offset-bearing stamp would sort into the wrong place with no error anywhere.
 * Hence one named constant rather than a format string copied into seven
 * statements.
 */
const NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

/**
 * The `updated_at` touch (migration 0017) — spliced into the UPDATE of every
 * mutator that changes a document: the version-append in updateDocumentCore
 * (which edit + restore delegate to), the four no-version-bump classification
 * mutators, and the revoke kill. Publish binds the column in its INSERT instead,
 * so a new document is born with `updated_at == created_at` (both resolve from
 * the same statement's `now`).
 *
 * WHY IT IS A FRAGMENT, NOT A TRIGGER: same rule as the documents_fts and
 * document_links syncs — the write path is the only place a document's derived
 * state is maintained, so all of it is visible to someone reading core.ts. A new
 * write surface must splice this in exactly as it must sync FTS and the link
 * graph; miss it and the doc silently stops appearing in change feeds.
 */
const TOUCH_UPDATED_AT = `updated_at = ${NOW_SQL}`;

/**
 * Global storage cap. Sums BOTH stored blobs per version — the rendered H
 * (`size_bytes`) and the retained source S (`source_size_bytes`) — across
 * every non-revoked version, regardless of which agent created the document.
 * v1 is single-operator, so the cap is a fleet-wide guardrail rather than a
 * per-agent quota. Source retention counts toward the cap (§6); the inner
 * `coalesce(v.source_size_bytes, 0)` keeps legacy/un-backfilled rows (NULL
 * source_size_bytes) a no-op zero so they don't break the SUM.
 *
 * Best-effort: the SUM runs outside the insert batch, so two concurrent
 * writes can both pass the check. v1 accepts the slight overrun — retention
 * changes the magnitude, not the concurrency story (the 2 GiB cap has
 * headroom for the roughly-doubled footprint).
 */
export async function checkStorageCap(
  env: Env,
  addBytes: number,
): Promise<{ ok: true } | { ok: false; used: number; cap: number }> {
  const cap = storageCapBytes(env);
  const used = await currentStorageUsedBytes(env);
  if (used + addBytes > cap) return { ok: false, used, cap };
  return { ok: true };
}

/**
 * Current fleet storage in use: the SUM of both stored blobs per version (the
 * rendered H `size_bytes` + the retained source S `source_size_bytes`) across
 * live documents. The SINGLE copy of this accounting — `checkStorageCap`
 * enforces it and the operator console dashboard reports it, both through here,
 * so "used" can never drift from what the cap actually checks.
 */
export async function currentStorageUsedBytes(env: Env): Promise<number> {
  const row = await env.META.prepare(
    `select coalesce(sum(v.size_bytes + coalesce(v.source_size_bytes, 0)), 0) as used
     from versions v
     join documents d on d.id = v.document_id
     where d.revoked_at is null`,
  ).first<{ used: number }>();
  return Number(row?.used ?? 0);
}

/**
 * Count of documents in the operator's REVIEW QUEUE — public AND
 * publication=pending (issue #57), composed exactly the way the console/API
 * filter pair is: `d.visibility = 'public'` plus the SAME `publicationClause`
 * the list surface and both search legs use, so this count can never drift
 * from what `?visibility=public&publication=pending` itself returns. The
 * single copy of the operator console dashboard's pending-promotion stat.
 */
export async function countPendingPromotionCore(env: Env): Promise<number> {
  const row = await env.META.prepare(
    `select count(*) as n from documents d where d.visibility = 'public' and ${publicationClause("pending")}`,
  ).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

/**
 * Run a source string through the (convert-if-needed → sanitize →
 * detect-advisories) sequence and report what the sanitizer would strip /
 * what won't render. Returns the post-conversion HTML and the sanitized HTML
 * alongside the advisory arrays so a caller can also measure `modified`.
 *
 * Extracted so it has exactly one definition reused by two callers: the write
 * path (`prepareForStorage`, write time) and the source-read path
 * (`readDocumentSourceCore`, read time, where we re-run the same pass over the
 * retained source S so a source-read can surface "the live render differs from
 * this source here" without duplicating the conversion sequence).
 */
function computeAdvisories(body: string, format: SourceFormat): {
  asHtml: string;
  cleanedHtml: string;
  stripped: string[];
  will_not_render: string[];
} {
  const asHtml = format === "markdown" ? markdownToHtml(body) : body;
  const cleanedHtml = sanitize(asHtml);
  const advisories = detectAdvisories(asHtml, cleanedHtml);
  return {
    asHtml,
    cleanedHtml,
    stripped: advisories.stripped,
    will_not_render: advisories.will_not_render,
  };
}

/**
 * Convert (if needed) → sanitize → measure. Used by both write paths so
 * the (conversion-then-trust-boundary) order is encoded in one place.
 *
 * For markdown input the conversion is `pulldown-cmark` + GFM extensions;
 * for html input the conversion is the identity. `sanitize()` always runs
 * on the resulting HTML, so neither door bypasses the allowlist.
 *
 * The `modified` flag and advisories compare against the POST-CONVERSION
 * HTML, not the raw input. For a Markdown caller that's the meaningful
 * question — "did the sanitizer touch the HTML my Markdown produced?" —
 * since the conversion itself is always a transformation by definition.
 *
 * Source retention: `sourceBytes` are the RAW submitted bytes BEFORE
 * conversion (Markdown text for md docs, the input HTML for html docs) and
 * are NOT sanitized — S is by definition the unsanitized original. They are
 * captured here, at the single convert-then-trust-boundary chokepoint, so S
 * is recorded in lockstep with H. `sourceFormat` is echoed so the write path
 * binds the same tag on the versions row that produced this S.
 */
function prepareForStorage(body: string, format: SourceFormat): {
  cleanedHtml: string;
  cleanedBytes: Uint8Array;
  sourceBytes: Uint8Array;
  sourceFormat: SourceFormat;
  sanitizerV: string;
  modified: boolean;
  stripped: string[];
  will_not_render: string[];
  /** Node-nesting depth of the sanitized H — the write path rejects past
   *  MAX_DOM_DEPTH before the recursive converter runs (issue #41). Measured
   *  here, the single convert-then-trust-boundary chokepoint, on the SAME bytes
   *  `htmlToMarkdown` would later recurse over. */
  depth: number;
} {
  const adv = computeAdvisories(body, format);
  const cleanedBytes = new TextEncoder().encode(adv.cleanedHtml);
  return {
    cleanedHtml: adv.cleanedHtml,
    cleanedBytes,
    sourceBytes: new TextEncoder().encode(body),
    sourceFormat: format,
    sanitizerV: sanitizerVersion(),
    modified: adv.asHtml !== adv.cleanedHtml,
    stripped: adv.stripped,
    will_not_render: adv.will_not_render,
    depth: maxDomDepth(adv.cleanedHtml),
  };
}

/** The output of `prepareForStorage` — both write paths thread this through. */
type Prep = ReturnType<typeof prepareForStorage>;

/**
 * Content-type for a retained source blob, keyed on the doc's source format.
 * Markdown sources are stored as `text/markdown`; html sources as `text/html`.
 * The render H blob is always `text/html` regardless (it's the sanitized HTML).
 */
function sourceContentType(format: SourceFormat): string {
  return format === "markdown" ? "text/markdown; charset=utf-8" : "text/html; charset=utf-8";
}

/**
 * Write BOTH blobs for one version: the sanitized render H at
 * `<docId>/v<n>-<nonce>` and the retained source S at its `.src` sibling. The
 * `.src` suffix is a dot-suffix sibling of the H key — version keys carry no
 * dot, so the suffix cannot collide.
 *
 * WHY THE NONCE — the key is PER-WRITE-ATTEMPT, not per-(docId, versionNo).
 * Both write cores PUT to R2 before the D1 batch and, if the batch throws,
 * delete the keys they just wrote. With a deterministic `<docId>/v<n>` key that
 * rollback is only safe for a RETRY (same writer, same bytes); it is actively
 * destructive for a CONCURRENT writer. Two updates that both read current_ver=5
 * both compute nextVer=6 and both address `D/v6`: `versions`' PRIMARY KEY
 * (document_id, version_no) lets exactly one batch commit, and the loser's
 * rollback then deletes the WINNER's committed bytes — leaving a live D1 row
 * whose R2 object is gone (404 on render, `source_unavailable` on edit/source,
 * still listed in search). The nonce makes each attempt own a private address,
 * so a loser can only ever delete its own bytes and the winner's blob is
 * untouchable. Nothing recomputes these keys — `versions.r2_key` /
 * `versions.source_r2_key` are opaque stored columns and every reader (render,
 * text/source reads, link backfill, revoke purge) reads them back from D1.
 * KEEP IT THAT WAY: re-deriving a key by formula anywhere would silently
 * reintroduce the shared address this nonce exists to remove. (Source-retention
 * §9's in-place re-heal is unaffected — it overwrites at the key it read off
 * the version row, which is stable once committed.)
 *
 * S is stored UNCONDITIONALLY (dedup-when-identical is a deferred optimization,
 * §6) and is NOT sanitized — it is by definition the unsanitized original. The
 * `representation: 'source'` customMetadata marker lets an R2 audit distinguish
 * S from H without parsing the bytes. Both puts complete before the D1 batch so
 * the existing orphan-on-D1-failure ordering holds; the callers' catch blocks
 * delete BOTH keys on a failed batch.
 */
async function putVersionBlobs(
  env: Env,
  docId: string,
  versionNo: number,
  prep: Prep,
  author: Author,
): Promise<{ r2Key: string; sourceR2Key: string }> {
  // 16 CSPRNG bytes, URL-safe base64 — the same minting `newPublicId` uses.
  // Opacity isn't the point here (the key never reaches a client); collision
  // resistance between concurrent attempts is.
  const r2Key = `${docId}/v${versionNo}-${newPublicId()}`;
  const sourceR2Key = `${r2Key}.src`;
  // `author_kind` is the principal discriminator (migration 0013); `agent_id`
  // is kept for agent authors so existing R2 audits still find a writer id. An
  // operator author carries no agent id — the queryable record is the D1
  // versions row (author_kind/author_agent_id); this customMetadata is a
  // best-effort echo, not the source of truth.
  const sharedMeta = {
    document_id: docId,
    version: String(versionNo),
    sanitizer_v: prep.sanitizerV,
    author_kind: author.kind,
    ...(author.kind === "agent" ? { agent_id: author.agentId } : {}),
    source_format: prep.sourceFormat,
  };

  // H blob — the sanitized render, unchanged from the prior inline puts.
  await env.DOCS.put(r2Key, prep.cleanedBytes, {
    httpMetadata: { contentType: "text/html; charset=utf-8" },
    customMetadata: sharedMeta,
  });

  // S blob — the retained, unsanitized source. Content-type follows the
  // source format; the representation marker flags it as source in an audit.
  await env.DOCS.put(sourceR2Key, prep.sourceBytes, {
    httpMetadata: { contentType: sourceContentType(prep.sourceFormat) },
    customMetadata: { ...sharedMeta, representation: "source" },
  });

  return { r2Key, sourceR2Key };
}

/**
 * Resolve the per-version metadata pair (title, description) into the values
 * that get written to the versions row. Tags are NOT here — they're document-
 * level since migration 0012; see `resolveTagsForWrite`. Encodes three rules:
 *
 *   1. Inheritance — `undefined` on update means "carry over from prior".
 *      On publish, prior is null, so `undefined` falls back to defaults
 *      (derive title; null description).
 *
 *   2. Explicit clear — empty string for title means "re-derive from new
 *      content"; empty string for description means "no description".
 *      Distinguishes "leave alone" (undefined) from "actively clear" (empty),
 *      which the inherit-on-omit contract needs.
 *
 *   3. Defensive validation — derived titles flow through validateTitleInput
 *      (NFC + control-strip + trim + length cap), agent-supplied strings
 *      through validate*. Boundary parsers (parseMetadataHeaders, MCP tool
 *      wrappers) already do this, but applying it here too means a single
 *      source of truth — the versions row never ends up with bytes a future
 *      validator would reject.
 */
function resolveMetadata(
  cleanedHtml: string,
  input: DocumentMetadataInput,
  prior: ResolvedMetadata | null,
): ResolvedMetadata {
  // ---- title --------------------------------------------------------------
  let title: string | null;
  if (input.title === undefined) {
    if (prior) {
      title = prior.title;
    } else {
      const derived = deriveTitleFromHtml(cleanedHtml);
      title = derived ? validateTitleInput(derived) || null : null;
    }
  } else if (input.title === "") {
    // Explicit "re-derive" — agent wants the default behaviour again.
    const derived = deriveTitleFromHtml(cleanedHtml);
    title = derived ? validateTitleInput(derived) || null : null;
  } else {
    const cleaned = validateTitleInput(input.title);
    title = cleaned.length > 0 ? cleaned : null;
  }

  // ---- description --------------------------------------------------------
  let description: string | null;
  if (input.description === undefined) {
    description = prior ? prior.description : null;
  } else if (input.description === "") {
    description = null;
  } else {
    const cleaned = validateDescriptionInput(input.description);
    description = cleaned.length > 0 ? cleaned : null;
  }

  return { title, description };
}

/**
 * Resolve agent tag input → the value written to `documents.tags` (migration
 * 0012). Tags are document-level classification, so resolution is simpler than
 * the per-version title/description inheritance:
 *   - `undefined` → leave the column ALONE (caller skips the UPDATE entirely).
 *   - `[]` / list → replace (sanitizeTagsInput; `[]` clears to NULL via
 *     serializeTags).
 * Returning `undefined` signals "no write" so a content-only update stays free
 * of an extra statement — and can't clobber a concurrent setDocumentTagsCore.
 */
function resolveTagsForWrite(input: string[] | undefined): string[] | undefined {
  return input === undefined ? undefined : sanitizeTagsInput(input);
}

/**
 * Serialize tags for D1 storage. `null` when the list is empty so the column
 * matches the "no value set" shape of title/description. Reads decode this
 * back via `parseStoredTags`.
 */
function serializeTags(tags: string[]): string | null {
  return tags.length === 0 ? null : JSON.stringify(tags);
}

/**
 * Parse the JSON-encoded tags column back into a string[]. Defensive against
 * legacy rows (NULL → []) and malformed JSON (→ []). The contract from the
 * write path is "valid JSON array of valid tags or NULL," but we don't want
 * a stray bad row to break list endpoints.
 */
export function parseStoredTags(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return sanitizeTagsInput(parsed);
  } catch {
    return [];
  }
}

/**
 * Order-sensitive tag-list equality, for the no-op gate in updateDocumentCore.
 * Order counts because it is what gets STORED: re-ordering a document's tags
 * rewrites `documents.tags`, so it is a real change, not a permutation of one.
 * Both sides are already through `sanitizeTagsInput` by the time this runs.
 */
function sameTagList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((tag, i) => tag === b[i]);
}

/**
 * Sanitize, cap-check, write to R2, stamp D1. Creates a fresh document at
 * version 1. The caller must have already resolved `agentId` from whichever
 * door (bearer or OAuth) the request came in through.
 *
 * `origin` is the URL prefix used to mint `url` (e.g. "https://host"). We
 * accept it as a parameter so core never needs to touch a Request.
 *
 * `format` selects the input pipeline. `"html"` is the legacy path; for
 * `"markdown"` we parse with pulldown-cmark (GFM) before running the
 * sanitizer. Either way the stored bytes are sanitized HTML — only the
 * `versions.source_format` column records what the agent originally sent.
 */
/**
 * Resolve agent slug input against the current state of the document.
 *
 * Three shapes the caller can produce:
 *   - `undefined`     → keep `priorSlug` unchanged (no-op)
 *   - `""` (empty)    → release (slug becomes NULL — the doc has no slug)
 *   - non-empty text  → validate; if equal to `priorSlug` it's a no-op,
 *                       otherwise check the partial unique index for a
 *                       collision and stage the claim.
 *
 * Returns an "action" the caller applies in its D1 batch — separating
 * the decision from the SQL keeps publish and update branches readable
 * and centralizes the validation/uniqueness path.
 *
 * `selfId` is set on update so a no-op rewrite (same slug as before) and
 * the uniqueness check both know to ignore the current document's own row.
 * On publish there is no row yet, so `selfId` is null.
 */
type SlugAction =
  | { kind: "noop"; slug: string | null }
  // `retire` is the prior slug to tombstone (null on a first-time claim, where
  // there's nothing to retire; non-null on a rename, where the old slug must
  // be permanently reserved per migration 0009).
  | { kind: "set"; slug: string; retire: string | null }
  // An explicit `""` release. `retire` is the slug being released — also
  // tombstoned (a released slug is just as spent as a renamed one; "release"
  // un-publishes it from this doc, it does NOT free it for reuse).
  | { kind: "clear"; retire: string };
async function resolveSlug(
  env: Env,
  input: string | undefined,
  priorSlug: string | null,
  selfId: string | null,
  /**
   * Set ONLY by the platform-documentation seeder (`seedPlatformDocsCore`),
   * which is the one writer allowed to claim a slug under
   * `RESERVED_SLUG_PREFIX`. Defaults to false, so every ordinary door — HTTP,
   * MCP, operator, edit, restore — is covered by the check below without
   * having to know the check exists.
   *
   * A flag rather than an absence of a check: the exemption is visible in one
   * place instead of being implied by which call site was used.
   */
  allowReservedSlug = false,
): Promise<{ ok: true; action: SlugAction } | Extract<PublishErr, { code: "invalid_slug" | "slug_taken" | "slug_retired" }>> {
  // Field absent → carry through whatever's already there.
  if (input === undefined) return { ok: true, action: { kind: "noop", slug: priorSlug } };

  // Empty value → release. Cheap and unambiguous; no uniqueness check needed
  // since NULL slugs aren't covered by the partial unique index. The released
  // slug is tombstoned by the caller (priorSlug is non-null on this branch).
  if (input.trim().length === 0) {
    // If the doc already has no slug, this is a no-op — avoid the UPDATE.
    if (priorSlug === null) return { ok: true, action: { kind: "noop", slug: null } };
    return { ok: true, action: { kind: "clear", retire: priorSlug } };
  }

  const v = validateSlugInput(input);
  if (!v.ok) return { ok: false, code: "invalid_slug", reason: v.reason };
  const slug = v.slug;

  // Reserved namespace (issue #4). Checked HERE, after charset validation and
  // before the uniqueness queries, because it is a property of the NAME rather
  // than of the corpus: it costs no DB round trip and it must answer the same
  // way whether or not a seeded doc happens to exist yet on this instance.
  // Reported as `invalid_slug` with its own reason rather than a new ErrorCode
  // — it is a rule about which slugs are well-formed for this caller, and
  // reusing the code keeps `formatSlugReject` the one copy of the wording.
  if (!allowReservedSlug && isReservedSlug(slug)) {
    return { ok: false, code: "invalid_slug", reason: "reserved_prefix" };
  }

  // Same slug as the existing one — skip the uniqueness query AND the UPDATE.
  if (slug === priorSlug) return { ok: true, action: { kind: "noop", slug } };

  // Uniqueness pre-check, across BOTH the live set and the retired set
  // (migration 0009). The partial UNIQUE INDEX on documents(slug) WHERE
  // slug IS NOT NULL enforces live-vs-live at write time too, but a pre-check
  // gives us a clean error code instead of a thrown constraint violation (D1
  // doesn't surface those structurally). Best-effort: a race can still slip a
  // second claim through between this SELECT and the write, in which case the
  // UPDATE/INSERT will throw and the top-level try/catch surfaces it as an
  // internal error. Acceptable for v1 (same posture 0005 already documented).
  const conflictQ = selfId
    ? env.META.prepare("select id from documents where slug = ? and id != ?").bind(slug, selfId)
    : env.META.prepare("select id from documents where slug = ?").bind(slug);
  const conflict = await conflictQ.first<{ id: string }>();
  if (conflict) return { ok: false, code: "slug_taken", slug };

  // Retired-slug check. A slug that any document ever shed is permanently
  // reserved — reclaiming it would resurrect the exact silent-repurposing bug
  // 0009 closes. Distinct `slug_retired` code so the caller can explain
  // "permanently spent" rather than "in use right now."
  const retired = await env.META
    .prepare("select slug from slug_tombstones where slug = ?")
    .bind(slug)
    .first<{ slug: string }>();
  if (retired) return { ok: false, code: "slug_retired", slug };

  return { ok: true, action: { kind: "set", slug, retire: priorSlug } };
}

/**
 * Build the statement that retires a slug into `slug_tombstones` (migration
 * 0009). Shared by every transition that strips a slug off a live document —
 * revoke, rename, and explicit release — so the reservation shape is identical
 * across all three call sites.
 *
 * `INSERT OR IGNORE`, NOT a plain INSERT, on purpose: the slug being retired
 * was live on `documents.slug` (covered by the partial unique index) and a live
 * slug is disjoint from the tombstone set, so a PK collision here is impossible
 * under the invariant. OR IGNORE makes that guarantee fail-safe instead of
 * fail-loud — most importantly it means the revoke batch (the operator kill
 * switch, which must ALWAYS win) can never roll back on a tombstone write even
 * if the invariant were somehow violated. The slug stays reserved either way.
 *
 * `redirectTo` (migration 0010) is set ONLY on a rename: the renamed-away slug
 * forwards to the document's own `public_id` (same-document, so it can't
 * surprise anyone — the auto-redirect case). Revoke and explicit release pass
 * null (a plain 410 tombstone); the operator sets a cross-document redirect
 * separately via setSlugRedirectCore.
 */
function tombstoneSlug(
  env: Env,
  slug: string,
  documentId: string,
  reason: "revoked" | "renamed" | "released",
  redirectTo: string | null = null,
): D1PreparedStatement {
  return env.META
    .prepare(
      "insert or ignore into slug_tombstones (slug, document_id, reason, redirect_to) values (?, ?, ?, ?)",
    )
    .bind(slug, documentId, reason, redirectTo);
}

// -- the document link graph (migration 0016, GitHub issue #40) ---------------

/**
 * Per-document cap on stored link rows — matches the 200-member cap on pack
 * expansion (loadContextPackCore) and the 200-row bound on every list surface.
 * extractOutboundLinks dedupes, so only a pathological link farm hits this;
 * the excess is silently dropped (graph completeness is best-effort curation,
 * not a contract).
 */
const MAX_DOCUMENT_LINKS = 200;

/**
 * D1 caps bound parameters per statement; 4 binds per link row → chunk the
 * multi-row INSERT well under the limit.
 */
const LINK_INSERT_CHUNK = 20;

/**
 * Build the `document_links` sync statements for one document's new current
 * version: DELETE-then-INSERT, the same idempotent shape as the FTS row sync
 * (covers refresh AND the pre-0016 doc with no rows yet). The caller splices
 * these into the SAME `META.batch()` as the version/FTS writes so the link
 * graph can never diverge from the bytes it was extracted from.
 *
 * Extraction runs over the sanitized render H (`cleanedHtml`) — the link
 * walk an agent's pack expansion would see — via the same extractOutboundLinks
 * used by loadContextPackCore. Targets are stored RAW (late binding): a slug
 * link may point at a name nobody has claimed yet; resolution happens at read
 * time (documentLinksCore). Self-links are excluded — a document "referencing
 * itself" is navigation chrome, not graph structure. `origin` is the request
 * origin (the same value the write cores already take for URL echoes); its
 * host scopes which ABSOLUTE hrefs count as on-platform.
 */
function documentLinkStatements(
  env: Env,
  docId: string,
  cleanedHtml: string,
  origin: string,
  self: { publicId: string; slug: string | null },
): D1PreparedStatement[] {
  return linkSyncStatements(env, docId, extractDocumentLinks(cleanedHtml, origin, self));
}

/** The extraction half: walk the sanitized H, drop self-links, cap. Split out
 * so backfillLinksCore (src/links-core.ts) can count what it stored — exported
 * for exactly that cross-module use; the write-time caller above stays here. */
export function extractDocumentLinks(
  cleanedHtml: string,
  origin: string,
  self: { publicId: string; slug: string | null },
): ExtractedLink[] {
  let originHost: string | undefined;
  try {
    originHost = new URL(origin).host;
  } catch {
    originHost = undefined;
  }
  return extractOutboundLinks(cleanedHtml, originHost)
    .filter(
      (l) =>
        !(l.kind === "public_id" && l.value === self.publicId) &&
        !(l.kind === "slug" && self.slug !== null && l.value === self.slug),
    )
    .slice(0, MAX_DOCUMENT_LINKS);
}

/** The statement half: DELETE + chunked multi-row INSERTs for one doc's rows.
 * Exported so backfillLinksCore (src/links-core.ts) can splice the same
 * statements from re-extracted links; the write-time caller stays here. */
export function linkSyncStatements(
  env: Env,
  docId: string,
  links: ExtractedLink[],
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [
    env.META.prepare("delete from document_links where src_doc_id = ?").bind(docId),
  ];
  for (let i = 0; i < links.length; i += LINK_INSERT_CHUNK) {
    const chunk = links.slice(i, i + LINK_INSERT_CHUNK);
    const values = chunk.map(() => "(?, ?, ?, ?)").join(", ");
    const binds = chunk.flatMap((l, j) => [docId, i + j, l.kind, l.value]);
    statements.push(
      env.META
        .prepare(
          `insert into document_links (src_doc_id, position, target_kind, target_value) values ${values}`,
        )
        .bind(...binds),
    );
  }
  return statements;
}

export async function publishDocumentCore(
  env: Env,
  body: string,
  author: Author,
  origin: string,
  format: SourceFormat,
  opts: DocumentMetadataInput = {},
  visibilityOverride?: Visibility,
  waitUntil?: WaitUntil,
  /**
   * Platform-documentation seeder only (src/seed-docs.ts) — permits a slug in
   * the reserved `slopcafe-docs-` namespace. See resolveSlug. Trailing and
   * defaulted so every other caller is covered by the check without knowing
   * it exists.
   */
  allowReservedSlug = false,
): Promise<WriteOk | PublishErr> {
  if (body.length === 0) return { ok: false, code: "empty_body" };

  // Reject oversize *input* up front — matches the existing HTTP path,
  // which 413s on raw req.arrayBuffer() bytes before decoding. The MCP
  // path has no Request to pre-check, so the cap is enforced here.
  // The cap applies to the raw input bytes (whether HTML or Markdown);
  // a Markdown document that expands during conversion is still bounded
  // by what the agent sent.
  const inputBytes = new TextEncoder().encode(body);
  if (inputBytes.byteLength > MAX_INPUT_BYTES) {
    return { ok: false, code: "too_large", limit: MAX_INPUT_BYTES, size: inputBytes.byteLength };
  }

  // Cheap O(n) pre-screen (issue #42): reject a depth-bomb BEFORE the ~O(n²)
  // sanitize parse (html5ever tree-build + Rc drop) ever touches it. Convert
  // markdown first — pulldown-cmark is O(n) even on deep nesting — then scan the
  // converted HTML's open-tag depth. A genuine bomb is refused here ~1000×
  // cheaper than the tree-build; the precise `prep.depth` check below stays the
  // authoritative guard against the converter's stack overflow (issue #41).
  const preDepth = maxNestingDepth(format === "markdown" ? markdownToHtml(body) : body);
  if (preDepth > MAX_DOM_DEPTH) {
    return { ok: false, code: "too_deep", limit: MAX_DOM_DEPTH, depth: preDepth };
  }

  // Convert (if needed) + sanitize so the cap check reflects what would
  // actually be stored. The sanitize step is the trust boundary for both
  // input formats; pulldown-cmark does not filter dangerous HTML on its
  // own (see sanitizer/src/lib.rs markdown_to_html docs).
  const prep = prepareForStorage(body, format);

  // Authoritative depth guard (issue #41): a doc nested past MAX_DOM_DEPTH would
  // overflow the WASM stack in the FTS-body htmlToMarkdown below (and on every
  // later markdown read). Measured precisely on the sanitized H — the bytes the
  // converter walks; the #42 pre-screen above has already refused the bombs, so
  // this now always runs on shallow input (cheap).
  if (prep.depth > MAX_DOM_DEPTH) {
    return { ok: false, code: "too_deep", limit: MAX_DOM_DEPTH, depth: prep.depth };
  }

  // Cap accounts for BOTH stored blobs now (H render + S source) — source
  // retention counts toward the fleet cap (§6). The reported this_write is
  // the combined footprint the agent is asking to store.
  const writeBytes = prep.cleanedBytes.byteLength + prep.sourceBytes.byteLength;
  const capCheck = await checkStorageCap(env, writeBytes);
  if (!capCheck.ok) {
    return {
      ok: false,
      code: "storage_cap_exceeded",
      used: capCheck.used,
      cap: capCheck.cap,
      this_write: writeBytes,
    };
  }

  // No prior version on publish — resolveMetadata derives title from the
  // cleaned HTML and falls back to a null description.
  const meta = resolveMetadata(prep.cleanedHtml, opts, null);
  // Tags are document-level (migration 0012). Publish has no "leave alone"
  // case — an omitted field means the new document is born with no tags.
  const tags = resolveTagsForWrite(opts.tags) ?? [];

  // Slug uniqueness check happens BEFORE the R2 write so a slug collision
  // doesn't leave orphan bytes. publish has no prior, no self — so we pass
  // null for both. The `action` we get back is either noop(null), set(slug),
  // or clear (impossible on publish since prior is null but we accept it).
  const slugResult = await resolveSlug(env, opts.slug, null, null, allowReservedSlug);
  if (!slugResult.ok) return slugResult;
  const slugForInsert = slugResult.action.kind === "set" ? slugResult.action.slug : null;

  const docId = newUuid();
  const publicId = newPublicId();
  const versionNo = 1;

  // Birth visibility from the deploy-time toggle (default "private"). Bound
  // EXPLICITLY below so the migration-0011 column DEFAULT 'public' only ever
  // covers legacy rows — a new document is private-by-default, not born-live.
  // Clamped in defaultDocumentVisibility, so a bad [var] can't violate the
  // CHECK constraint. Agents never choose this; only the operator flips it
  // afterward (setDocumentVisibilityCore) — OR, when the operator AUTHORS a doc
  // via POST /admin/documents, picks the birth value atomically here through
  // `visibilityOverride` (pre-validated to the two legal values by the handler).
  // The override is operator-only by CALL-SITE discipline: the agent write paths
  // (POST /d, MCP publish) never pass it, so they stay default-bound.
  const visibility = visibilityOverride ?? defaultDocumentVisibility(env);

  // R2 first (both blobs: H render + S source). If the D1 batch fails we
  // attempt to delete BOTH blobs so we don't accumulate orphans. The keys are
  // unique per WRITE ATTEMPT (see putVersionBlobs), so that rollback can only
  // ever delete bytes this call wrote — never a concurrent writer's.
  const { r2Key, sourceR2Key } = await putVersionBlobs(env, docId, versionNo, prep, author);

  // Resolve the author into its storage columns once (migration 0013): the
  // creator-kind on `documents`, and the agent FK that is the writer's id for an
  // agent author or NULL for the operator. created_by stays the agents FK it
  // always was — NULL when the operator created the doc.
  const createdByAgentId = author.kind === "agent" ? author.agentId : null;

  // Body text for FTS — htmlToMarkdown is the same conversion the read path
  // runs at request time (readDocumentTextCore). Doing it once here at write
  // time lets us index plain text without re-walking the HTML on every
  // search. Single-digit ms; shares the WASM module already loaded.
  const ftsBody = htmlToMarkdown(prep.cleanedHtml);

  // SHA-256 of the retained source S (migration 0015). Hashes the SAME bytes
  // written to the `.src` blob — so it equals an agent's `sha256sum file` for a
  // well-formed-UTF-8 byte-exact publish, the basis for the cheap "is my local
  // copy current?" check (issue #35). Surfaced as `source_sha256` on the write
  // response and `current_source_sha256` on listing rows.
  const sourceSha256 = await sha256Hex(prep.sourceBytes);

  try {
    await env.META.batch([
      // `updated_at` is bound EXPLICITLY (migration 0017), never left to the
      // column's sentinel DEFAULT — same discipline as `visibility` in 0011,
      // where the DEFAULT exists only to backfill pre-migration rows. SQLite
      // resolves `now` once per statement, so this lands identical to the
      // `created_at` DEFAULT firing in the same INSERT: a newly published doc
      // reads as "changed when it was created," to the millisecond.
      // `published_ver` (migration 0018) is bound at BIRTH, not left NULL. A
      // document can be born public two ways — an operator `visibilityOverride`
      // on POST /admin/documents, or a deployment running
      // DEFAULT_DOCUMENT_VISIBILITY = "public" — and neither ever passes through
      // setDocumentVisibilityCore's coalesce, so a NULL here would never be
      // filled. That matters because the render rule falls back to `current_ver`
      // when `published_ver IS NULL`: an unpinned public document publishes every
      // agent write instantly, which is precisely the exfiltration path 0018
      // exists to close (issue #43). The invariant this restores is
      // "visibility = 'public' implies published_ver IS NOT NULL", established in
      // all three places a doc can become public: here, the visibility flip, and
      // the 0018 backfill. A doc born private gets NULL — nothing is published.
      env.META.prepare(
        `insert into documents (id, public_id, created_by, created_by_kind, slug, visibility, tags, published_ver, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ${NOW_SQL})`,
      ).bind(
        docId,
        publicId,
        createdByAgentId,
        author.kind,
        slugForInsert,
        visibility,
        serializeTags(tags),
        visibility === "public" ? versionNo : null,
      ),
      env.META.prepare(
        `insert into versions (document_id, version_no, r2_key, size_bytes, sanitizer_v, source_format, source_r2_key, source_size_bytes, source_sha256, title, description, author_kind, author_agent_id)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        docId,
        versionNo,
        r2Key,
        prep.cleanedBytes.byteLength,
        prep.sanitizerV,
        format,
        sourceR2Key,
        prep.sourceBytes.byteLength,
        sourceSha256,
        meta.title,
        meta.description,
        author.kind,
        createdByAgentId,
      ),
      env.META.prepare("update documents set current_ver = ? where id = ?").bind(
        versionNo,
        docId,
      ),
      // (No `updated_at` touch here — the INSERT above already stamped it in
      // this same batch, and re-stamping would only risk the two disagreeing.)
      // Same batch as the document/version writes so the FTS index can't
      // diverge from the metadata it indexes. Tags are NOT indexed (migration
      // 0012 dropped the FTS tags column); the ?tags= filter matches the real
      // documents.tags JSON column instead, never FTS.
      env.META.prepare(
        `insert into documents_fts (document_id, title, description, body)
         values (?, ?, ?, ?)`,
      ).bind(docId, meta.title, meta.description, ftsBody),
      // Link-graph rows (migration 0016) — same batch, same rationale as FTS:
      // the graph tracks exactly the bytes this version stored.
      ...documentLinkStatements(env, docId, prep.cleanedHtml, origin, {
        publicId,
        slug: slugForInsert,
      }),
    ]);
  } catch (err) {
    // Delete BOTH blobs — H and the retained source S — so a failed batch
    // doesn't leak the unsanitized source object alongside the render.
    await env.DOCS.delete([r2Key, sourceR2Key]).catch(() => {
      /* best effort; surfaced via logs if it matters */
    });
    throw err;
  }

  // Vector sync rides the request lifetime, AFTER the D1 batch committed (§6).
  // Best-effort + eventually-consistent: Vectorize is NOT transactional with D1
  // (async mutations, visibility lag), so it can't join the batch above — a drop
  // degrades to "BM25 still finds it" and the backfill heals it. Embeds the same
  // (title, description, ftsBody) just written, no second R2 read. Skipped
  // silently when no waitUntil is supplied (unit tests / un-plumbed caller).
  if (waitUntil) {
    waitUntil(syncDocumentVector(env, docId, meta.title, meta.description, ftsBody));
  }

  return {
    ok: true,
    public_id: publicId,
    url: `${origin}/d/${publicId}`,
    version: versionNo,
    // Publish is never collapsed — see the no-op gate in updateDocumentCore.
    // A POST creates a NEW document; two documents holding identical bytes are
    // legitimate, and there is no prior version here to be identical TO.
    unchanged: false,
    size_bytes: prep.cleanedBytes.byteLength,
    sanitizer_v: prep.sanitizerV,
    source_sha256: sourceSha256,
    modified: prep.modified,
    stripped: prep.stripped,
    will_not_render: prep.will_not_render,
    title: meta.title,
    description: meta.description,
    tags,
    slug: slugForInsert,
  };
}

/**
 * Append a new version to an existing document. `expectedVersion`:
 *   - number   → fail with `version_conflict` if the current version differs.
 *   - null     → clobber (skip the version check, last-write-wins).
 *
 * Cross-principal writes are intentional per the single-tenant trust model
 * documented in updateDocument's wrapper — an agent and the operator can both
 * write any document. The caller's `author` is stamped onto the NEW version
 * (versions.author_kind/author_agent_id since migration 0013, plus the R2
 * customMetadata echo); `documents.created_by`/`created_by_kind` are untouched —
 * they retain the ORIGINAL creator, so an operator updating an agent-created
 * doc yields creator=agent, v2 author=operator (the author list we want).
 */
export async function updateDocumentCore(
  env: Env,
  publicId: string,
  body: string,
  expectedVersion: number | null,
  author: Author,
  origin: string,
  format: SourceFormat,
  opts: DocumentMetadataInput = {},
  waitUntil?: WaitUntil,
  /** Platform-documentation seeder only — see publishDocumentCore. */
  allowReservedSlug = false,
): Promise<WriteOk | UpdateErr> {
  if (!PUBLIC_ID_RE.test(publicId)) return { ok: false, code: "not_found" };
  if (body.length === 0) return { ok: false, code: "empty_body" };

  // Look up document + current version + revoked state + prior metadata in
  // one go. Prior title/description (per-version) is what omitted fields
  // inherit from on update; prior tags is the document's CURRENT tags, used
  // only to echo unchanged tags on the response. `slug`, `tags` and
  // `visibility` all live on `documents` (not `versions`) — identity-adjacent /
  // document-level classification — so we pull them from `d` rather than `v`.
  // `visibility` is read for ONE reason: the agent slug lock below (issue #43).
  // It does NOT gate the write — any active key still writes any document.
  //
  // The three `prior_source_*` columns feed the no-op gate below. They ride this
  // existing join on `current_ver`, so the gate costs zero extra round trips.
  const row = await env.META.prepare(
    `select d.id, d.current_ver, d.revoked_at, d.visibility, d.slug as prior_slug,
       d.tags as prior_tags,
       v.title as prior_title,
       v.description as prior_description,
       v.source_sha256 as prior_source_sha256,
       v.sanitizer_v as prior_sanitizer_v,
       v.source_format as prior_source_format
     from documents d
     left join versions v
       on v.document_id = d.id and v.version_no = d.current_ver
     where d.public_id = ?`,
  )
    .bind(publicId)
    .first<{
      id: string;
      current_ver: number | null;
      revoked_at: string | null;
      visibility: Visibility;
      prior_slug: string | null;
      prior_title: string | null;
      prior_description: string | null;
      prior_tags: string | null;
      prior_source_sha256: string | null;
      prior_sanitizer_v: string | null;
      prior_source_format: string | null;
    }>();
  if (!row || row.revoked_at || row.current_ver === null) {
    return { ok: false, code: "not_found" };
  }

  if (expectedVersion !== null && expectedVersion !== row.current_ver) {
    return {
      ok: false,
      code: "version_conflict",
      current_version: row.current_ver,
      expected: expectedVersion,
    };
  }

  const inputBytes = new TextEncoder().encode(body);
  if (inputBytes.byteLength > MAX_INPUT_BYTES) {
    return { ok: false, code: "too_large", limit: MAX_INPUT_BYTES, size: inputBytes.byteLength };
  }

  // Cheap O(n) depth-bomb pre-screen BEFORE the ~O(n²) sanitize (issue #42) —
  // same screen as publish; an edit/restore reaches here too (both delegate
  // their write to this core), so a deep version can't be re-stored on update.
  const preDepth = maxNestingDepth(format === "markdown" ? markdownToHtml(body) : body);
  if (preDepth > MAX_DOM_DEPTH) {
    return { ok: false, code: "too_deep", limit: MAX_DOM_DEPTH, depth: preDepth };
  }

  const prep = prepareForStorage(body, format);

  // Authoritative depth guard on the sanitized H (issue #41); the #42 pre-screen
  // above already refused the bombs, so this now runs on shallow input.
  if (prep.depth > MAX_DOM_DEPTH) {
    return { ok: false, code: "too_deep", limit: MAX_DOM_DEPTH, depth: prep.depth };
  }

  // Cap accounts for BOTH stored blobs (H render + S source) — §6.
  const writeBytes = prep.cleanedBytes.byteLength + prep.sourceBytes.byteLength;
  const capCheck = await checkStorageCap(env, writeBytes);
  if (!capCheck.ok) {
    return {
      ok: false,
      code: "storage_cap_exceeded",
      used: capCheck.used,
      cap: capCheck.cap,
      this_write: writeBytes,
    };
  }

  // Resolve title/description with inheritance from the prior version.
  // `undefined` fields carry over; `""` clears (and re-derives in the title
  // case).
  const prior: ResolvedMetadata = {
    title: row.prior_title,
    description: row.prior_description,
  };
  const meta = resolveMetadata(prep.cleanedHtml, opts, prior);

  // Tags are document-level (migration 0012), resolved separately: `undefined`
  // leaves documents.tags untouched (no statement emitted below); a supplied
  // list replaces it (`[]` clears). `resolvedTags` is what the response echoes
  // — the new value when supplied, else the document's unchanged current tags.
  // The else-branch echo is best-effort: it reflects `prior_tags` from the
  // opening SELECT, so a concurrent operator `setDocumentTagsCore` committing
  // between that read and this batch can make the echoed tags lag the stored
  // column (which is left correct, untouched). Same single-read posture the
  // slug/title/description echoes already accept.
  const tagsUpdate = resolveTagsForWrite(opts.tags);
  const resolvedTags = tagsUpdate ?? parseStoredTags(row.prior_tags);

  // Resolve slug separately — it's per-document, not per-version, and its
  // claim path needs DB access (uniqueness check). BEFORE the R2 write so
  // a slug collision doesn't leave orphan bytes. The "noop" action keeps
  // the prior slug intact (the common case for content-only updates) and
  // avoids touching documents.slug.
  const slugResult = await resolveSlug(env, opts.slug, row.prior_slug, row.id, allowReservedSlug);
  if (!slugResult.ok) return slugResult;
  const slugAction = slugResult.action;

  // SLUG LOCK (issue #43): an AGENT may not rename or release the slug of a
  // PUBLIC document. This is the one place it can be enforced unbypassably —
  // every principal-driven slug transition on an EXISTING document lands here
  // (PUT /d/:id, MCP update_document, MCP edit_document and restore all delegate
  // their write to this core), so a route-handler check would leave four doors
  // open. Publish is out of scope by construction: it can only create a NEW
  // document, which no one has linked to yet.
  //
  // Keyed on the resolved ACTION, not the raw input, because the action is the
  // single authority on "did the name actually change": re-sending a document's
  // existing slug on every update is what every publishing script does (see
  // the repo's publishing scripts), and that must stay a clean no-op rather than becoming
  // a hard failure the moment the doc goes public. A `clear` is locked too — an
  // explicit release retires the name just as permanently as a rename does.
  //
  // Ordering note: `invalid_slug` / `slug_taken` / `slug_retired` can fire ahead
  // of this, since resolveSlug runs first. That's fine — none of them writes
  // anything, and a malformed slug is worth reporting as malformed regardless of
  // who sent it.
  if (author.kind === "agent" && row.visibility === "public" && slugAction.kind !== "noop") {
    return { ok: false, code: "slug_locked" };
  }

  // What slug ends up on the response — same whether we changed it or not.
  const resolvedSlug =
    slugAction.kind === "set" ? slugAction.slug : slugAction.kind === "clear" ? null : slugAction.slug;

  // SHA-256 of the retained source S (migration 0015) — see publishDocumentCore
  // for the rationale (the cheap currency check, #35). Computed HERE, ahead of
  // the write, because the no-op gate below keys on it; it is also what the
  // versions row stores when the write does go ahead.
  const sourceSha256 = await sha256Hex(prep.sourceBytes);

  // ---- NO-OP GATE ---------------------------------------------------------
  // Collapse a write that would store exactly what the document already holds.
  //
  // The occasion was a mis-programmed agent re-pushing an identical body every
  // 30 minutes for a thousand versions, but the real defect is that `PUT` — a
  // verb HTTP defines as idempotent — was not: a client that timed out on a
  // write which had actually committed and then retried minted a duplicate
  // version, as does any at-least-once delivery path. The gate makes the retry
  // free instead of destructive.
  //
  // Deliberately ALL-OR-NOTHING: source, title, description, tags AND slug must
  // every one be identical, so `unchanged: true` means literally nothing was
  // written — no version row, no R2 blobs, no FTS row, no link rows, no vector
  // re-embed, and NO `updated_at` touch (a no-op is not a change, and
  // `updated_at` is the change feed). Any single difference falls through to a
  // normal full write. A classification-only fast path (apply new tags without
  // minting a version, the way setDocumentTagsCore does) is a separate decision:
  // folding it in here would make `unchanged` a lie.
  //
  // Identity is keyed on the SOURCE S, never the render H. S is what /source,
  // edit_document and restore operate on, so two sources that merely sanitize to
  // the same H are different documents in this model. The error direction is the
  // safe one — a missed collapse writes a redundant version (exactly today's
  // behavior), while a false collapse would silently swallow a real edit.
  //
  // `sanitizer_v` and `source_format` are part of the key because the premise is
  // "same S + same format + same pipeline ⇒ same H". That makes the
  // `sanitizer_version()` stamp load-bearing for CORRECTNESS now, not just for
  // reporting: a byte-affecting change anywhere in the write pipeline — the
  // allowlist OR `markdown_to_html`'s pulldown-cmark ingress — must bump it, or
  // an identical re-push that ought to re-render silently won't. The rule is
  // spelled out on `sanitizer_version()` in sanitizer/src/lib.rs.
  //
  // A version predating migration 0015 has `prior_source_sha256` NULL, so the
  // gate cannot fire and the write proceeds normally — the same presence-flag
  // posture as the 0008 source columns. It self-arms after one write; no
  // backfill needed.
  //
  // Ordering is load-bearing three ways. It sits AFTER the `version_conflict`
  // check, so a client writing from a stale base is still told so even when the
  // resulting bytes would have matched (the conflict is about the base revision,
  // not the outcome). It sits AFTER the slug lock, so an agent renaming a public
  // document still gets `slug_locked` rather than a silent success. And it
  // compares against `current_ver` ONLY, never `published_ver` — current is the
  // working copy, and collapsing against the published pointer would swallow an
  // agent's newest bytes on a document whose promotion is still pending.
  const contentIdentical =
    row.prior_source_sha256 !== null &&
    row.prior_source_sha256 === sourceSha256 &&
    row.prior_sanitizer_v === prep.sanitizerV &&
    row.prior_source_format === format;
  const metadataIdentical =
    meta.title === row.prior_title &&
    meta.description === row.prior_description &&
    slugAction.kind === "noop" &&
    (tagsUpdate === undefined || sameTagList(tagsUpdate, parseStoredTags(row.prior_tags)));
  if (contentIdentical && metadataIdentical) {
    // Logged (the id and the author kind — never the body) so a runaway client
    // stays VISIBLE in `wrangler tail`. The gate caps the damage of a broken
    // write loop; it must not also hide it, because an accumulating version
    // count is how the last one was noticed.
    console.log(
      `no-op update collapsed: doc=${publicId} v=${row.current_ver} author=${author.kind}`,
    );
    return {
      ok: true,
      public_id: publicId,
      url: `${origin}/d/${publicId}`,
      // The version that was ALREADY there — nothing was appended.
      version: row.current_ver,
      unchanged: true,
      // Identical source through an identical pipeline, so these describe the
      // stored version as accurately as they describe the submission.
      size_bytes: prep.cleanedBytes.byteLength,
      sanitizer_v: prep.sanitizerV,
      source_sha256: sourceSha256,
      modified: prep.modified,
      stripped: prep.stripped,
      will_not_render: prep.will_not_render,
      title: meta.title,
      description: meta.description,
      tags: resolvedTags,
      slug: resolvedSlug,
    };
  }

  const nextVer = row.current_ver + 1;

  // Both blobs (H render + S source), same helper as publish. `nextVer` comes
  // from a plain SELECT, so two concurrent updates CAN both compute the same
  // number — the attempt-nonce in the key (see putVersionBlobs) is what keeps
  // the loser's rollback below from deleting the winner's committed bytes.
  const { r2Key, sourceR2Key } = await putVersionBlobs(env, row.id, nextVer, prep, author);
  // The agent FK for this version's writer — the agent's id, or NULL for the
  // operator (migration 0013). created_by on `documents` is left alone above.
  const authorAgentId = author.kind === "agent" ? author.agentId : null;

  // Same write-time markdown derivation as publishDocumentCore — feeds the
  // FTS body column so search results follow the doc's current version.
  const ftsBody = htmlToMarkdown(prep.cleanedHtml);

  try {
    // Build the batch dynamically — only include the slug UPDATE when the
    // agent actually changed something. Keeps the no-op path (the vast
    // majority of updates) free of an extra round-trip statement.
    const statements: D1PreparedStatement[] = [
      env.META.prepare(
        `insert into versions (document_id, version_no, r2_key, size_bytes, sanitizer_v, source_format, source_r2_key, source_size_bytes, source_sha256, title, description, author_kind, author_agent_id)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        row.id,
        nextVer,
        r2Key,
        prep.cleanedBytes.byteLength,
        prep.sanitizerV,
        format,
        sourceR2Key,
        prep.sourceBytes.byteLength,
        sourceSha256,
        meta.title,
        meta.description,
        author.kind,
        authorAgentId,
      ),
      // The `updated_at` touch (migration 0017) rides the current_ver UPDATE —
      // the one statement EVERY content write reaches, including the edit and
      // restore paths that delegate their write here. The slug/tags statements
      // appended below are in this same batch and so need no touch of their own.
      env.META.prepare(
        `update documents set current_ver = ?, ${TOUCH_UPDATED_AT} where id = ?`,
      ).bind(nextVer, row.id),
      // Sync the FTS row in lockstep. DELETE-then-INSERT (rather than UPDATE)
      // covers two cases with one shape: the normal case where publish inserted
      // an FTS row we're refreshing, AND the legacy case where the document
      // pre-dates the search migration and has no FTS row yet. UPDATE would
      // silently zero-affect on a missing row; DELETE+INSERT is idempotent.
      // FTS5 has no ON CONFLICT / UPSERT, so two statements is the way.
      env.META.prepare("delete from documents_fts where document_id = ?").bind(row.id),
      env.META.prepare(
        `insert into documents_fts (document_id, title, description, body)
         values (?, ?, ?, ?)`,
      ).bind(row.id, meta.title, meta.description, ftsBody),
      // Link-graph rows (migration 0016) — DELETE-then-INSERT in the same batch,
      // exactly like the FTS row above. Self-exclusion uses the slug as it will
      // be AFTER this batch (resolvedSlug), since that's the name the new
      // version's self-links would address.
      ...documentLinkStatements(env, row.id, prep.cleanedHtml, origin, {
        publicId,
        slug: resolvedSlug,
      }),
    ];
    if (slugAction.kind === "set") {
      statements.push(
        env.META.prepare("update documents set slug = ? where id = ?").bind(slugAction.slug, row.id),
      );
      // Rename: the old slug is permanently reserved (migration 0009) AND
      // auto-forwards to this document's own public_id (migration 0010) — a
      // same-document redirect, so /s/<old> keeps working (loudly) at the new
      // name. A first-time claim has retire === null and tombstones nothing.
      if (slugAction.retire !== null) {
        statements.push(tombstoneSlug(env, slugAction.retire, row.id, "renamed", publicId));
      }
    } else if (slugAction.kind === "clear") {
      statements.push(
        env.META.prepare("update documents set slug = null where id = ?").bind(row.id),
      );
      // Explicit release un-publishes the slug from this doc but does NOT free
      // it for reuse — it's tombstoned like any other shed slug.
      statements.push(tombstoneSlug(env, slugAction.retire, row.id, "released"));
    }
    // Document-level tags (migration 0012) — a SEPARATE statement, emitted only
    // when the agent supplied a tags field. Never folded into the `current_ver`
    // UPDATE above: folding would rewrite tags on every content-only update and
    // could clobber a concurrent setDocumentTagsCore retag. Omitted (undefined)
    // → no statement → documents.tags untouched.
    if (tagsUpdate !== undefined) {
      statements.push(
        env.META.prepare("update documents set tags = ? where id = ?").bind(
          serializeTags(tagsUpdate),
          row.id,
        ),
      );
    }
    await env.META.batch(statements);
  } catch (err) {
    // Delete BOTH blobs — H and the retained source S — on a failed batch.
    // Safe to do unconditionally: these keys are attempt-unique, so a batch
    // that lost the (document_id, version_no) race deletes only its own bytes.
    await env.DOCS.delete([r2Key, sourceR2Key]).catch(() => {
      /* best effort; D1 is the source of truth */
    });
    throw err;
  }

  // Re-embed AFTER the batch committed (§6) — same best-effort, eventually-
  // consistent posture as publish: a re-sync drop degrades to BM25 and the next
  // update or the backfill heals it. This is the self-healing write the §6
  // "write-once docs don't self-heal" caveat refers to. Skipped when no
  // waitUntil is supplied (unit tests omit it; every live write/edit/restore
  // path threads it).
  if (waitUntil) {
    waitUntil(syncDocumentVector(env, row.id, meta.title, meta.description, ftsBody));
  }

  return {
    ok: true,
    public_id: publicId,
    url: `${origin}/d/${publicId}`,
    version: nextVer,
    // A real write reached here — the no-op gate above owns the true case.
    unchanged: false,
    size_bytes: prep.cleanedBytes.byteLength,
    sanitizer_v: prep.sanitizerV,
    source_sha256: sourceSha256,
    modified: prep.modified,
    stripped: prep.stripped,
    will_not_render: prep.will_not_render,
    title: meta.title,
    description: meta.description,
    tags: resolvedTags,
    slug: resolvedSlug,
  };
}

/**
 * Successful edit. Same shape as a normal write, plus `replacements`: the
 * number of occurrences the find/replace substituted (≥1 — a zero-match edit
 * errors out before any write). It exists so the caller can tell "my patch
 * landed" apart from "the sanitizer touched the bytes": `replacements` proves
 * the substitution happened, while `modified` only says the sanitizer changed
 * the post-edit HTML — which can be `true` from incidental entity/whitespace
 * normalization even when the edit itself was clean. Don't read `modified`
 * alone as "my edit changed something."
 */
// EditOk — a WriteOk plus `replacements`. Defined in src/contract.ts.

/**
 * Edit failures. A superset of UpdateErr (the edit delegates the write to
 * updateDocumentCore, so every update failure can surface here) plus the
 * find/replace-specific codes from applyEdits. `edit_index` is the zero-based
 * position of the offending edit in the request array.
 *
 * `source_unavailable` surfaces when the doc has no retained source to match
 * against (a legacy/un-backfilled row — `source_r2_key IS NULL`, or its `.src`
 * object is missing). The edit hard-fails on it rather than falling back to
 * editing the sanitized H (§7 no-legacy-branch): editing H as if it were the
 * source would corrupt a Markdown doc and silently flip its format. Loud and
 * fixable (re-backfill the doc) beats silent corruption.
 */
export type EditErr =
  | UpdateErr
  | { ok: false; code: "no_edits" }
  | { ok: false; code: "empty_old_string"; edit_index: number }
  | { ok: false; code: "noop_edit"; edit_index: number }
  | { ok: false; code: "edit_no_match"; edit_index: number; old_string: string }
  | { ok: false; code: "edit_not_unique"; edit_index: number; old_string: string; count: number }
  | { ok: false; code: "source_unavailable" };

/**
 * Server-side find-and-replace: load the current version's RETAINED SOURCE S,
 * apply the string edits to it, then append a new version through the exact
 * same path as a full update. Lets a caller change one region of a document by
 * sending a small diff instead of re-transmitting the whole body.
 *
 * Why match against the SOURCE (not the sanitized H): under source retention
 * (Case A) the source is kept per version, so the edit matches what the agent
 * actually authored — Markdown for a Markdown doc, the original HTML for an
 * HTML doc — and the re-render keeps the doc in its own language. This is the
 * load-bearing invariant: the representation `read_document` hands back for
 * editing (`representation:"source"`) and the representation `edit_document`
 * matches against MUST be the same one. So the match is run against exactly
 * what `readDocumentSourceCore` returns. An `old_string` copied from a
 * *rendered* read (H/M) instead of a source read simply gets a loud
 * `edit_no_match` when S≠H — a self-correctable, non-silent failure. See
 * src/edit.ts for the substitution rules.
 *
 * The write itself is DELEGATED to updateDocumentCore — same convert →
 * sanitize → cap-check → R2 (H+S) → D1 → FTS-sync version-append sequence, no
 * duplication. CRITICAL: it is delegated with the doc's OWN `source_format`
 * (threaded from the source-read result), NOT a hardcoded "html". A Markdown
 * doc's edited Markdown source is re-rendered through markdownToHtml and
 * re-sanitized, and the new version stays `source_format: "markdown"` — so the
 * reader theme survives by construction. Threading the wrong format here would
 * feed Markdown to the HTML identity path (or vice versa) and corrupt SILENTLY
 * — there is no test that catches it. Be exact.
 *
 * If the doc has no retained source (`source_unavailable` — a legacy/
 * un-backfilled row), this surfaces that error and does NOT fall back to
 * editing H (§7 no-legacy-branch): editing the sanitized HTML as if it were
 * the source would corrupt a Markdown doc and silently flip its format.
 *
 * Concurrency: an explicit `expectedVersion` behaves exactly like
 * update_document (version_conflict on mismatch, checked twice — a fast-fail
 * here before we do the substitution work, then authoritatively inside
 * updateDocumentCore against its own read). An OMITTED (null) `expectedVersion`
 * does NOT clobber: it defaults to the version we just read the source of.
 *
 * That divergence from update_document is deliberate. For update_document the
 * clobbering bytes ARE the caller's whole intended body, so last-write-wins is
 * an honest default. For an edit, the SERVER picked the base revision (the
 * source read above) and then writes the ENTIRE re-rendered body forward — so
 * any version committed between that read and the write would be reverted
 * wholesale while the response cheerfully reported `replacements: 1`. Guarding
 * against the version actually edited turns that silent revert into a
 * `version_conflict` the caller already knows how to handle: re-read the
 * source, re-apply, retry. Same read-then-write discipline Claude Code's own
 * Edit tool uses.
 */
export async function editDocumentCore(
  env: Env,
  publicId: string,
  edits: EditSpec[],
  expectedVersion: number | null,
  author: Author,
  origin: string,
  replaceAll: boolean,
  opts: DocumentMetadataInput = {},
  waitUntil?: WaitUntil,
): Promise<EditOk | EditErr> {
  if (!PUBLIC_ID_RE.test(publicId)) return { ok: false, code: "not_found" };
  if (edits.length === 0) return { ok: false, code: "no_edits" };

  // Load the retained SOURCE — this is what the edits match against, and its
  // source_format is what we thread through the re-render. source_unavailable
  // (un-backfilled doc) is surfaced loud, never silently fixed up by editing H.
  const current = await readDocumentSourceCore(env, publicId);
  if (!current.ok) {
    if (current.code === "source_unavailable") return current;
    return { ok: false, code: "not_found" };
  }

  // Fast-fail optimistic concurrency. Pass-through to updateDocumentCore below
  // is the authoritative check; this just avoids doing the substitution work
  // when the caller is provably editing a version they didn't expect.
  if (expectedVersion !== null && expectedVersion !== current.version_no) {
    return {
      ok: false,
      code: "version_conflict",
      current_version: current.version_no,
      expected: expectedVersion,
    };
  }

  // Match/replace against the source string, not the rendered HTML.
  const applied = applyEdits(current.source, edits, replaceAll);
  if (!applied.ok) return applied;

  // Delegate the write with the doc's OWN source_format (NOT hardcoded "html")
  // so the re-render runs the matching pipeline and the new version keeps its
  // language. An omitted expectedVersion falls back to the version we actually
  // edited (`current.version_no`) rather than null/clobber — see the
  // Concurrency note above: an edit writes the whole body forward from a base
  // revision the SERVER chose, so an unguarded write would silently revert
  // anything committed since the source read.
  const result = await updateDocumentCore(
    env,
    publicId,
    applied.html,
    expectedVersion ?? current.version_no,
    author,
    origin,
    current.source_format,
    opts,
    waitUntil,
  );
  if (!result.ok) return result;
  return { ...result, replacements: applied.replacements };
}

// RestoreOk — a WriteOk plus `restored_from`. Defined in src/contract.ts.
export type RestoreErr =
  | { ok: false; code: "not_found" }
  | { ok: false; code: "version_not_found" }
  | { ok: false; code: "source_unavailable" }
  | UpdateErr;

/**
 * Build the metadata-restore opts that reconstruct a historical version's
 * title/description faithfully through updateDocumentCore's inheritance rules:
 * a stored value is passed verbatim to override; a NULL (the version had none /
 * a derived title) becomes `""`, which CLEARS description and RE-DERIVES title
 * from the restored content's first <h1> — i.e. exactly what that version
 * displayed. Tags and slug are deliberately absent (undefined): both are
 * document-level (migrations 0012 / 0005), so a restore keeps the doc's CURRENT
 * tags and slug, never reverts them — content rolls back, classification doesn't.
 */
function restoreMetaFrom(
  title: string | null,
  description: string | null,
): DocumentMetadataInput {
  return { title: title ?? "", description: description ?? "" };
}

/**
 * Restore a historical version by re-publishing its content as a NEW version
 * (NOT by rewinding `documents.current_ver`). This is mandatory, not stylistic:
 * updateDocumentCore computes `nextVer = current_ver + 1`, so pointing
 * current_ver backward would make the next ordinary update collide on the
 * `(document_id, version_no)` primary key. Writing the old content forward keeps
 * version_no monotonic and routes through the one sanitize→cap→R2→D1→FTS path.
 *
 * Restores the target version's BODY and its title/description (restoreMetaFrom);
 * the document's current slug AND tags are left untouched (both are document-
 * level — identity/classification, not content). Restores from the retained
 * SOURCE S, so a Markdown version re-renders as Markdown and keeps its reader
 * theme by construction.
 *
 * A version with NO retained source (`source_unavailable` — a pre-0008 /
 * un-backfilled row) HARD-FAILS — there is deliberately no fall-back-to-H legacy
 * branch, identical to `editDocumentCore`'s contract. At SOLO scale the handful
 * of pre-retention versions are revoke-and-republished, not carried by a lossy
 * compatibility path (operator's pre-launch no-legacy-code stance). Operator-
 * gated at the call site (no agent restore in v1).
 */
export async function restoreVersionCore(
  env: Env,
  publicId: string,
  versionNo: number,
  author: Author,
  origin: string,
  waitUntil?: WaitUntil,
): Promise<RestoreOk | RestoreErr> {
  if (!PUBLIC_ID_RE.test(publicId)) return { ok: false, code: "not_found" };

  // not_found / version_not_found / source_unavailable all propagate — a
  // sourceless (pre-0008) version cannot be restored, by design.
  const src = await readDocumentSourceCore(env, publicId, versionNo);
  if (!src.ok) return src;

  const result = await updateDocumentCore(
    env,
    publicId,
    src.source,
    null,
    author,
    origin,
    src.source_format,
    restoreMetaFrom(src.title, src.description),
    waitUntil,
  );
  if (!result.ok) return result;
  return { ...result, restored_from: versionNo };
}

// ReadOk — buffered sanitized-HTML read of one version (`bytes` = the H blob,
// `source_r2_key` is the loud null presence-flag for legacy rows). Defined in
// src/contract.ts.
export type ReadErr = { ok: false; code: "not_found" | "version_not_found" };

/**
 * Fetch a version's sanitized HTML, buffered into memory.
 *
 * `versionNo === null` (the default) reads the live current version — the
 * COALESCE picks `d.current_ver`. An explicit `versionNo` reads that historical
 * version's retained bytes straight from its own R2 key (every version's bytes
 * survive in R2 until revoke purges them — the operator/agent version-history
 * surfaces ride on exactly this). A version that doesn't exist on a LIVE doc is
 * the distinct `version_not_found`, not `not_found`.
 *
 * The browser path (`serveRaw` in src/serve.ts) streams R2 directly to
 * avoid buffering — different consumer, different needs. The MCP tool
 * needs the bytes in-process to return as text content, so we buffer here.
 *
 * Metadata (title/description per-version; tags document-level) is read
 * alongside the R2 key in the same query — same join cost, no extra round
 * trip. Callers that only want the bytes can ignore the metadata fields.
 */
export async function readDocumentCore(
  env: Env,
  publicId: string,
  versionNo: number | null = null,
): Promise<ReadOk | ReadErr> {
  if (!PUBLIC_ID_RE.test(publicId)) return { ok: false, code: "not_found" };

  // LEFT JOIN (not inner) so a row still comes back when the doc exists but the
  // requested version doesn't — letting us return version_not_found instead of
  // a misleading not_found. The version columns are then nullable in the typing.
  // `tags` reads from `d` (document-level since migration 0012): a version-
  // pinned read returns the document's CURRENT tags, not that version's —
  // title/description stay per-version. Mirrors how `slug` already behaves.
  const row = await env.META.prepare(
    `select d.revoked_at, d.slug, d.tags, d.status, d.superseded_by, v.r2_key, v.version_no, v.sanitizer_v,
       v.source_format, v.source_r2_key,
       v.title, v.description
     from documents d
     left join versions v on v.document_id = d.id and v.version_no = coalesce(?, d.current_ver)
     where d.public_id = ?`,
  )
    .bind(versionNo, publicId)
    .first<{
      revoked_at: string | null;
      slug: string | null;
      r2_key: string | null;
      version_no: number | null;
      sanitizer_v: string | null;
      source_format: SourceFormat | null;
      source_r2_key: string | null;
      title: string | null;
      description: string | null;
      tags: string | null;
      status: DocumentStatus;
      superseded_by: string | null;
    }>();
  if (!row || row.revoked_at) return { ok: false, code: "not_found" };
  // Live doc, but no version matched the COALESCE target. With an explicit
  // versionNo that's a genuine "no such version"; with the default it would mean
  // current_ver dangles (not reachable for a live doc, but map it to not_found).
  if (row.r2_key === null) {
    return { ok: false, code: versionNo === null ? "not_found" : "version_not_found" };
  }

  const obj = await env.DOCS.get(row.r2_key);
  if (!obj) return { ok: false, code: "not_found" }; // D1 says it should exist; treat as gone.

  const buf = await obj.arrayBuffer();
  // r2_key non-null ⇒ a version row matched, so the NOT NULL version columns
  // (version_no/sanitizer_v/source_format) are guaranteed present.
  return {
    ok: true,
    bytes: new Uint8Array(buf),
    version_no: row.version_no!,
    sanitizer_v: row.sanitizer_v!,
    source_format: row.source_format!,
    source_r2_key: row.source_r2_key,
    title: row.title,
    description: row.description,
    tags: parseStoredTags(row.tags),
    slug: row.slug,
    // Lifecycle classification (migration 0014) — document-level like
    // tags/slug, so a version-pinned read returns the doc's CURRENT status.
    status: row.status,
    superseded_by: row.superseded_by,
  };
}

// ReadTextOk — Markdown read derived on the fly from the sanitized HTML.
// Defined in src/contract.ts.

/**
 * Fetch the current version's sanitized HTML and convert it to Markdown.
 *
 * The conversion runs at read time (no per-version cache in v1 — see
 * docs/design/action-plan-v1.md follow-ups for the cost analysis). The input to
 * `htmlToMarkdown` is always the sanitized bytes from R2, never raw
 * agent input, so the text view reflects exactly what would render and
 * nothing the sanitizer stripped can leak through.
 *
 * `sanitizer_v` and `converter_v` are both stamped on the response so a
 * caller seeing surprising output can tell which knob changed.
 */
export async function readDocumentTextCore(
  env: Env,
  publicId: string,
  versionNo: number | null = null,
): Promise<ReadTextOk | ReadErr> {
  const html = await readDocumentCore(env, publicId, versionNo);
  if (!html.ok) return html;

  const htmlStr = new TextDecoder().decode(html.bytes);
  const text = htmlToMarkdown(htmlStr);
  return {
    ok: true,
    text,
    version_no: html.version_no,
    sanitizer_v: html.sanitizer_v,
    converter_v: converterVersion(),
    title: html.title,
    description: html.description,
    tags: html.tags,
    slug: html.slug,
    status: html.status,
    superseded_by: html.superseded_by,
  };
}

/**
 * Source-read result — the RETAINED source S in its authored language
 * (Markdown for md docs, original HTML for html docs), plus the advisory
 * arrays re-derived from S at read time. NOT a rendered/sanitized view: S is
 * the unsanitized original. The caller (MCP read_document representation:
 * "source" / HTTP GET /d/:id/source) attaches the `unsanitized: true`
 * provenance marker and the agent-key gate — this core function is
 * gating-agnostic. See readDocumentSourceCore.
 */
// ReadSourceOk — the retained, UNSANITIZED source S plus advisories re-derived
// from it at read time. Defined in src/contract.ts.

/**
 * Source-read failures. `not_found` for a missing/revoked/invalid public_id,
 * exactly like the other read cores. `source_unavailable` is DISTINCT: the
 * document exists and is live, but its current version has no retained source
 * (`source_r2_key IS NULL` — a legacy/un-backfilled row, or the R2 object is
 * gone). It is a LOUD signal that the §7 backfill missed this doc, NOT a
 * not_found, so an operator can spot un-backfilled docs and edit_document can
 * hard-fail instead of silently falling back to the sanitized H (§7 forbids a
 * legacy fallback branch).
 */
export type ReadSourceErr =
  | { ok: false; code: "not_found" }
  | { ok: false; code: "version_not_found" }
  | { ok: false; code: "source_unavailable" };

/**
 * Fetch the current version's RETAINED SOURCE S and re-run the advisory pass
 * over it. Mirrors the readDocumentCore / readDocumentTextCore split rather
 * than overloading readDocumentCore (which the html read branch and the edit
 * path depend on returning the sanitized H).
 *
 * GATING-AGNOSTIC by design: this function discloses no authority — in the
 * single-tenant whole-fleet trust model any active agent key already reads and
 * overwrites every document, so source-read exposes only the pre-sanitization
 * bytes of a doc the caller can already fully read and control. The callers
 * (MCP / HTTP) apply the agent-key gate. A future reviewer must NOT "harden"
 * this to operator-only out of caution — it is security theater that breaks
 * the ONLY consumer the feature exists for (read-source → edit → republish)
 * for zero real security. (Same guardrail discipline as CLAUDE.md's "don't fix
 * the session signing key to the pepper" note.)
 *
 * The advisory arrays are re-derived from S here (not read from D1) via the
 * shared computeAdvisories helper, so "the live render differs from this
 * source here" is surfaced at read time without duplicating the conversion
 * sequence.
 */
export async function readDocumentSourceCore(
  env: Env,
  publicId: string,
  versionNo: number | null = null,
): Promise<ReadSourceOk | ReadSourceErr> {
  if (!PUBLIC_ID_RE.test(publicId)) return { ok: false, code: "not_found" };

  // versionNo === null → current version (default). Explicit versionNo reads
  // that historical version's retained source. LEFT JOIN so "doc exists but
  // version doesn't" is distinguishable (version_not_found) from "doc missing".
  const row = await env.META.prepare(
    `select d.revoked_at, d.slug, d.tags, d.status, d.superseded_by, v.version_no, v.sanitizer_v,
       v.source_format, v.source_r2_key, v.source_sha256,
       v.title, v.description
     from documents d
     left join versions v on v.document_id = d.id and v.version_no = coalesce(?, d.current_ver)
     where d.public_id = ?`,
  )
    .bind(versionNo, publicId)
    .first<{
      revoked_at: string | null;
      slug: string | null;
      version_no: number | null;
      sanitizer_v: string | null;
      source_format: SourceFormat | null;
      source_r2_key: string | null;
      source_sha256: string | null;
      title: string | null;
      description: string | null;
      tags: string | null;
      status: DocumentStatus;
      superseded_by: string | null;
    }>();
  if (!row || row.revoked_at) return { ok: false, code: "not_found" };
  // Live doc, requested version absent (version_no is NOT NULL in schema, so a
  // null here is the LEFT JOIN miss). Default versionNo → not_found fallback.
  if (row.version_no === null) {
    return { ok: false, code: versionNo === null ? "not_found" : "version_not_found" };
  }

  // NULL source_r2_key = un-backfilled/legacy. Hard-fail LOUD (distinct from
  // not_found) — never fall back to the sanitized H (§7 no-legacy-branch).
  if (row.source_r2_key === null) return { ok: false, code: "source_unavailable" };

  const obj = await env.DOCS.get(row.source_r2_key);
  // D1 says a source blob should exist but R2 doesn't have it — surface the
  // same loud source_unavailable rather than a misleading not_found, so the
  // operator can spot the gap and re-backfill.
  if (!obj) return { ok: false, code: "source_unavailable" };

  const source = await obj.text();
  // version_no/sanitizer_v/source_format are NOT NULL in schema; the guards
  // above (version_no non-null, source_r2_key non-null) guarantee they're set.
  const adv = computeAdvisories(source, row.source_format!);
  return {
    ok: true,
    source,
    source_format: row.source_format!,
    version_no: row.version_no!,
    sanitizer_v: row.sanitizer_v!,
    // The stored hash of these exact source bytes (migration 0015) — null on a
    // pre-0015 version (un-backfilled). Lets a source-read response double as
    // the currency token an agent caches for the cheap list-based check (#35).
    source_sha256: row.source_sha256,
    stripped: adv.stripped,
    will_not_render: adv.will_not_render,
    title: row.title,
    description: row.description,
    tags: parseStoredTags(row.tags),
    slug: row.slug,
    status: row.status,
    superseded_by: row.superseded_by,
  };
}

/**
 * One row of a document's version history. Pure D1 metadata — no R2 fetch — so
 * listing a doc's full history is cheap regardless of how many versions exist.
 * Newest-first ordering is the caller's expectation (see listVersionsCore).
 */
// VersionListing / ListVersionsOk — one version-history row and the manifest
// wrapping them. Defined in src/contract.ts.
export type ListVersionsErr = { ok: false; code: "not_found" };

/**
 * Cap on the version-history manifest, so a heavily-edited document can't grow
 * an unbounded response (the `versions` row count climbs by one per write with
 * no ceiling). 200 matches `pagination.MAX_LIMIT` — the same bound the
 * cursor-paginated list surfaces enforce. The newest N are returned; an older
 * version is still readable directly by its version number.
 */
const VERSION_HISTORY_LIMIT = 200;

/**
 * List a live document's version history, newest first. D1-only (no R2): the
 * `versions` table is the authoritative manifest of every retained version.
 * Capped at the `VERSION_HISTORY_LIMIT` most recent versions so the response
 * stays bounded no matter how many edits a document has accrued (matching the
 * bounded-response discipline of the cursor-paginated list surfaces; an older
 * version beyond the cap is still readable directly by its version number).
 *
 * Returns `not_found` for a missing/revoked document — a revoked doc's R2 bytes
 * are purged (the kill switch), so it has no recoverable history to surface.
 * Operator-only history surfaces (the manage page, the /d/:id/v/:n routes) and
 * the agent-facing `read_document include_history` flag all share this.
 *
 * Each row carries TWO independent "which one is this?" flags: `is_current` (the
 * version a write would build on, and the one every credentialed surface reads)
 * and `is_published` (the version a PUBLIC document's byte path actually renders
 * — migration 0018, issue #43). They coincide on a document nobody has staged
 * work on; where they diverge is precisely the state the manage page's Publish
 * button exists to resolve. `source_sha256` rides along for the same reason it's
 * on the listing row: it lets a caller tell whether a local copy still matches a
 * given version without re-reading its source.
 */
export async function listVersionsCore(
  env: Env,
  publicId: string,
): Promise<ListVersionsOk | ListVersionsErr> {
  if (!PUBLIC_ID_RE.test(publicId)) return { ok: false, code: "not_found" };

  const doc = await env.META.prepare(
    "select id, current_ver, published_ver, revoked_at from documents where public_id = ?",
  )
    .bind(publicId)
    .first<{
      id: string;
      current_ver: number | null;
      published_ver: number | null;
      revoked_at: string | null;
    }>();
  if (!doc || doc.revoked_at || doc.current_ver === null) {
    return { ok: false, code: "not_found" };
  }

  // author_kind/author_agent_id are per-version since migration 0013 (the
  // queryable replacement for the old R2-customMetadata-only writer tag); the
  // agents LEFT JOIN resolves a display name for agent authors (NULL for an
  // operator author, whose kind tells the story — mirrors created_by_name on
  // the document listing).
  const rows = await env.META.prepare(
    `select v.version_no, v.created_at, v.size_bytes, v.source_size_bytes, v.sanitizer_v,
       v.source_format, v.title, v.source_r2_key, v.source_sha256, v.author_kind,
       v.author_agent_id, a.name as author_name
     from versions v
     left join agents a on a.id = v.author_agent_id
     where v.document_id = ?
     order by v.version_no desc
     limit ?`,
  )
    .bind(doc.id, VERSION_HISTORY_LIMIT)
    .all<{
      version_no: number;
      created_at: string;
      size_bytes: number;
      source_size_bytes: number | null;
      sanitizer_v: string;
      source_format: SourceFormat;
      title: string | null;
      source_r2_key: string | null;
      source_sha256: string | null;
      author_kind: "agent" | "operator";
      author_agent_id: string | null;
      author_name: string | null;
    }>();

  const versions: VersionListing[] = (rows.results ?? []).map((r) => ({
    version_no: r.version_no,
    created_at: r.created_at,
    size_bytes: r.size_bytes,
    source_size_bytes: r.source_size_bytes,
    // NULL for a pre-0015 / un-backfilled version — the same loud presence-flag
    // posture as source_r2_key above, never a fabricated hash.
    source_sha256: r.source_sha256,
    sanitizer_v: r.sanitizer_v,
    source_format: r.source_format,
    title: r.title,
    is_current: r.version_no === doc.current_ver,
    // `published_ver` is NULL when nothing has been promoted, and `version_no`
    // is always a number, so an unpublished document simply reports every row
    // as false — no row is ever accidentally flagged by a null-vs-null match.
    is_published: r.version_no === doc.published_ver,
    source_present: r.source_r2_key !== null,
    author_kind: r.author_kind,
    author_id: r.author_agent_id,
    author_name: r.author_name,
  }));

  return { ok: true, public_id: publicId, current_ver: doc.current_ver, versions };
}

// DocumentListing — the listing-row projection (same columns as
// GET /admin/documents). Defined in src/contract.ts. NOTE: `visibility` rides
// through the MCP list/search responses as an UNDOCUMENTED field — never named
// in any agent-facing contract (decision: agents see "published is published").


/**
 * The columns we project for every listing-row read — shared by
 * listDocumentsCore (paginated, filtered), findDocumentBySlugCore (single-row
 * lookup), searchDocumentsCore's two legs (below), documentLinksCore's
 * backlinks and listOrphanDocumentsCore (src/links-core.ts, #53), and
 * findDocumentByPublicIdCore (src/pack-core.ts, #53) — hence exported.
 * Centralizing the SELECT keeps the surface in lockstep: any new column added
 * to DocumentListing flows to every one of those paths in one edit.
 *
 * `updated_at` + `current_version_at` are the migration-0017 modification-time
 * pair. The second is FREE — `v` is the current-version row this projection
 * already joins for title/description/size — and the two answer different
 * questions: `updated_at` moves on any change (including a retag, which never
 * bumps a version), `current_version_at` moves only when bytes are written. A
 * row where they sit MEANINGFULLY apart was last touched by classification, not
 * content (they're stamped by two statements of the same batch, so a pure
 * content write can leave a millisecond between them — read the gap, not an
 * exact inequality).
 *
 * `published_ver` + `published_source_sha256` are the migration-0018 published/
 * current split (issue #43). `v` is still the CURRENT version — every field
 * derived from it (title, description, size, current_source_sha256) keeps
 * describing what a credentialed read returns — and the second `pv` join is the
 * PUBLISHED version, the one a public document's byte path actually renders.
 * Both are NULL when nothing has been promoted. Reading `published_ver` against
 * `current_ver` is how a caller sees "there is staged work here"; the hash pair
 * is how it sees whether a local copy matches the live page or the draft.
 *
 * `current_author_kind`/`current_author_id`/`current_author_name` (issue #58)
 * are the CURRENT VERSION's writer — `v.author_kind`/`v.author_agent_id`
 * (migration 0013), already sitting on the same `v` join this projection uses
 * for title/description/size, plus a second agents join (`va`, distinct from
 * `a` which resolves the DOCUMENT's birth-time `created_by`) for the writing
 * agent's display name. Free: no new join condition on `d`, no extra round
 * trip. Null together with the rest of `v.*` on a revoked doc (the `v` join
 * misses); `current_author_id`/`current_author_name` are additionally null for
 * an operator-written version (`va` join has nothing to resolve) or a
 * pre-0013 legacy version (`author_agent_id` was never backfilled).
 */
// Exported (not just internal to core.ts): pack-core.ts / links-core.ts /
// search-core.ts all project the same DocumentListing shape and must build it
// from this ONE column list + join clause — a second copy anywhere is a
// silent drift risk (add a DocumentListing column here once; every consumer
// follows).
export const LISTING_SELECT_COLUMNS = `d.id, d.public_id, d.current_ver, d.published_ver, d.created_at, d.updated_at, d.revoked_at, d.slug, d.visibility, d.tags,
       d.status, d.superseded_by,
       a.name as created_by_name, d.created_by as created_by_id, d.created_by_kind,
       v.size_bytes as current_size, v.source_sha256 as current_source_sha256,
       v.created_at as current_version_at,
       v.author_kind as current_author_kind, v.author_agent_id as current_author_id,
       va.name as current_author_name,
       pv.source_sha256 as published_source_sha256,
       v.title, v.description`;
export const LISTING_JOINS = `from documents d
     left join agents a on a.id = d.created_by
     left join versions v on v.document_id = d.id and v.version_no = d.current_ver
     left join agents va on va.id = v.author_agent_id
     left join versions pv on pv.document_id = d.id and pv.version_no = d.published_ver`;

/**
 * Build the LIKE-pattern for an AND-style tag filter against the JSON-encoded
 * `documents.tags` column (document-level since migration 0012). This filter
 * has never used FTS — it matches the real tags column — so the FTS tags-column
 * removal in 0012 leaves it unaffected beyond retargeting `v.tags` → `d.tags`.
 *
 * Storage shape (see `serializeTags`): `JSON.stringify(tags)` — for tags
 * `["foo","bar_x"]` that's the literal string `["foo","bar_x"]` with no spaces
 * and no JSON-escape characters (tag charset is `[A-Za-z0-9_-]`, so nothing
 * inside a tag needs escaping). The double-quotes around each tag are the
 * delimiter we anchor on, so `%"foo"%` matches when the tag list contains
 * "foo" and never matches a substring of a longer tag.
 *
 * The `_` LIKE wildcard collides with the tag charset (`_` IS legal inside
 * a tag — e.g. `my_tag`), so we escape underscores with `\_` and tell SQLite
 * about it via `ESCAPE '\'`. The `\` character itself isn't in the tag
 * charset, so it never appears in stored bytes — no double-escape needed.
 * The `%` wildcard doesn't collide with the charset, so it stays a literal
 * wildcard at the ends.
 */
function tagLikePattern(tag: string): string {
  return `%"${tag.replace(/_/g, "\\_")}"%`;
}

/**
 * The `publication` filter's WHERE fragment (migration 0018), in ONE place —
 * the list surface and both search legs share it so the three can't drift on a
 * predicate whose whole subtlety is NULL handling. Takes no caller input (the
 * parser has already narrowed it to one of two literals) and binds nothing, so
 * it interpolates safely.
 *
 *   pending — `published_ver IS NOT current_ver`: the document holds bytes its
 *     publication pointer doesn't name. On a PUBLIC doc that's the operator's
 *     review queue; on a private one it also means "never published", which is
 *     the resting state of a private draft — hence `visibility=public` as the
 *     composing filter rather than a `visibility` term baked in here (the two
 *     knobs stay orthogonal, and "private docs with staged versions" stays
 *     expressible).
 *   current — `published_ver IS current_ver` (and non-null): a promote would be
 *     a no-op. The non-null term is what keeps "has no versions at all" — a
 *     shape the write path never produces, but the column allows — out of a set
 *     that claims something is published.
 *
 * `IS` / `IS NOT` (null-safe), never `=` / `<>`: `published_ver` is genuinely
 * nullable, and `NULL <> 3` evaluates to NULL — the plain comparison would drop
 * every never-published document out of `pending` without erroring.
 *
 * The `revoked_at is null` guard is the deliberate exception to this surface's
 * "filters narrow, revoked rows still appear" rule: revoke nulls BOTH pointers,
 * so a dead row would otherwise satisfy `current` (NULL IS NULL) and report a
 * publication state it doesn't have. The search legs already carry that guard;
 * repeating it here keeps the fragment correct standalone. Documented in
 * PUBLICATION_FILTERS (pagination.ts) and docs/http-api.md.
 *
 * Exported so `countPendingPromotionCore` (the operator console dashboard's
 * pending-promotion stat, issue #57) can compose it with `visibility = 'public'`
 * without hand-copying the NULL-safe SQL — stays the ONE copy either way.
 */
export function publicationClause(filter: PublicationFilter): string {
  return filter === "pending"
    ? "(d.revoked_at is null and d.published_ver is not d.current_ver)"
    : "(d.revoked_at is null and d.published_ver is not null and d.published_ver is d.current_ver)";
}

/**
 * List documents (including revoked), newest first. Cursor-paginated — see
 * src/pagination.ts for the contract; callers omit `cursor` on the first
 * page and pass back `next_cursor` from the prior response to walk forward.
 *
 * Single-tenant trust model: any caller (operator or any agent) sees the
 * full fleet. If per-agent filtering becomes a need, add a `createdBy?`
 * arg here and an additional `WHERE created_by = ?` clause.
 *
 * The versions LEFT JOIN pulls title/description/size from the current
 * version row; tags/slug/visibility come from the document row itself
 * (document-level). Older code used a correlated subselect for size; the
 * JOIN form scales better as more per-version fields get surfaced.
 *
 * ORDERING is (<time column> DESC, id DESC), where the column is chosen by
 * `params.order` (migration 0017): `created` → `d.created_at` (newest published
 * first, the default), `updated` → `d.updated_at` (most recently TOUCHED first —
 * the change feed, where a retag or a revoke moves a row to the top even though
 * no version was written). The `id` tiebreaker matters on either column when two
 * rows share a stamp (D1's strftime stamps to ms; collisions are rare but real
 * under bursty writes, and a retag sweep touching several docs in one pass is
 * exactly such a burst) — without it cursors could skip a row at a page boundary.
 *
 * FILTERS:
 *   - `params.tags` — AND semantics. One `tags LIKE ? ESCAPE '\'` predicate
 *     per requested tag (see tagLikePattern for the encoding). Tags are
 *     pre-sanitized by `parseHttpListParams` / `parseMcpListArgs` to the
 *     stored shape so a `?tag=Foo!` query filters by `["Foo"]` — same
 *     silent-strip semantics as the write path.
 *   - `params.slug` — exact match against `documents.slug` (unique across
 *     live docs, so returns 0 or 1 rows when combined with no other filter).
 *   - `params.updatedSince` — `d.updated_at >= ?`, the change-feed window
 *     (migration 0017). Independent of `order`: windowing without re-sorting is
 *     legitimate ("what changed this week, oldest-published first"), and the two
 *     knobs compose. The parser has already normalized the bound to the stored
 *     timestamp shape, so this is a plain lexicographic compare.
 *   - `params.visibility` — `d.visibility = ?` (migration 0011). Narrows the
 *     same rows the caller already sees; the value has ridden every listing row
 *     since 0011, so this saves a client-side pass and nothing else.
 *   - `params.publication` — the `published_ver` vs `current_ver` relationship
 *     (migration 0018), via publicationClause. `visibility=public` +
 *     `publication=pending` is the operator's REVIEW QUEUE — the documents whose
 *     readers are seeing older bytes than the fleet has written — answered in
 *     one request instead of a full-corpus walk with a client-side compare.
 *
 * Filters compose with the cursor predicate: the WHERE clause is always
 * built as `<cursor>? AND <tags>? AND <slug>? AND …`, so paginating through a
 * filtered list walks the filtered subset in the same (time, id) order as the
 * unfiltered list. Revoked docs are still included — slug is cleared on revoke
 * (see revokeDocumentCore), so a `slug=` filter naturally only matches live docs
 * anyway, and a revoked row surfacing in an `order=updated` walk is the POINT:
 * it's how a consumer learns the document died. The ONE exception is
 * `publication`, which excludes revoked rows in both directions (revoke nulls
 * both pointers, so a dead row has no publication state to report) — a consumer
 * that wants deaths in its feed leaves that filter off.
 */
export async function listDocumentsCore(
  env: Env,
  params: ListParams,
): Promise<{ documents: DocumentListing[]; next_cursor: string | null }> {
  // `d.id` is needed for the cursor tiebreaker but isn't part of the public
  // DocumentListing shape — we strip it in the projection below.
  type Row = Omit<DocumentListing, "tags"> & { id: string; tags: string | null };

  // The ONE place `order` becomes SQL (migration 0017). The cursor predicate,
  // the ORDER BY, and the `ts` we mint into the next cursor all read this single
  // local, so the three can never disagree about which column the walk is on.
  // Interpolated, not bound — it's a column name, and `params.order` is a
  // two-value union the parser already validated (a bound parameter can't be an
  // identifier anyway).
  const orderColumn = params.order === "updated" ? "d.updated_at" : "d.created_at";

  // Build the WHERE clause + bind list dynamically. Every predicate is
  // optional, so we accumulate clauses + bind args and join with AND at
  // the end. The cursor predicate, when present, comes first so its three
  // binds line up positionally with the existing `?, ?, ?` triple.
  const clauses: string[] = [];
  const binds: unknown[] = [];

  if (params.cursor) {
    // Same (ts, id) boolean rewrite as ever, applied to whichever column this
    // walk is ordered by. The parser guarantees the cursor was minted under this
    // same ordering (`bad_cursor` otherwise), so `ts` is always a value of
    // `orderColumn` and never a timestamp from the other axis.
    clauses.push(`(${orderColumn} < ? or (${orderColumn} = ? and d.id < ?))`);
    binds.push(params.cursor.ts, params.cursor.ts, params.cursor.id);
  }
  if (params.updatedSince !== null) {
    // Inclusive `>=` (migration 0017), deliberately: a caller resuming a change
    // feed passes back the newest `updated_at` it saw, and `>` would drop any
    // row sharing that exact millisecond — the same collision the id tiebreaker
    // exists for. Re-delivering the boundary row is the recoverable failure
    // (dedupe on public_id); skipping one silently is not. Uses the
    // (updated_at, id) index from migration 0017.
    clauses.push("d.updated_at >= ?");
    binds.push(params.updatedSince);
  }
  for (const tag of params.tags) {
    // One LIKE per tag = AND semantics over the document-level `d.tags` JSON
    // column (migration 0012). SQLite plans this as a sequential scan over the
    // `documents` set — fine for v1's scale; a tag index would mean
    // restructuring storage (json_each + a normalized tags table, say). Deferred.
    clauses.push("d.tags like ? escape '\\'");
    binds.push(tagLikePattern(tag));
  }
  if (params.slug !== null) {
    // Slug uses the partial UNIQUE INDEX on documents(slug) WHERE slug IS NOT NULL.
    // Equality match — the planner uses the index for a single row hit.
    clauses.push("d.slug = ?");
    binds.push(params.slug);
  }
  if (params.status !== null) {
    // Lifecycle filter (migration 0014). No filter (the default) includes
    // deprecated docs — they're still findable, just carried/marked in the row.
    clauses.push("d.status = ?");
    binds.push(params.status);
  }
  if (params.visibility !== null) {
    // Anonymous-readability filter (migration 0011). A plain column equality —
    // it narrows the same fleet-wide row set every credentialed caller already
    // sees (the row has always carried `visibility`), so it discloses nothing.
    clauses.push("d.visibility = ?");
    binds.push(params.visibility);
  }
  if (params.publication !== null) {
    // Publication-pointer filter (migration 0018). `visibility=public` +
    // `publication=pending` IS the operator's review queue in one call —
    // see publicationClause for the NULL semantics and the revoked exclusion.
    clauses.push(publicationClause(params.publication));
  }
  const whereSql = clauses.length > 0 ? `where ${clauses.join(" and ")}` : "";

  // Peek one past the limit so we know whether next_cursor should be set.
  const peek = params.limit + 1;
  binds.push(peek);

  const sql = `select ${LISTING_SELECT_COLUMNS}
     ${LISTING_JOINS}
     ${whereSql}
     order by ${orderColumn} desc, d.id desc
     limit ?`;
  const result = await env.META.prepare(sql).bind(...binds).all<Row>();
  const { items, next_cursor } = paginate(
    result.results ?? [],
    params.limit,
    ({ id: _id, tags, ...rest }): DocumentListing => ({ ...rest, tags: parseStoredTags(tags) }),
    // Stamp the ordering onto the cursor we hand back (migration 0017) so the
    // next page is validated against the axis this page was ordered by, and
    // read the `ts` from the matching column — a cursor carrying an updated_at
    // value labelled `created` would be the exact silent skip the label prevents.
    (row) => ({
      ts: params.order === "updated" ? row.updated_at : row.created_at,
      id: row.id,
      order: params.order,
    }),
  );
  return { documents: items, next_cursor };
}

/**
 * Look up a single document by its slug. Returns the same DocumentListing
 * shape as a row from listDocumentsCore so callers can render both with one
 * projection.
 *
 * Why a dedicated function rather than just calling listDocumentsCore with a
 * slug filter: ergonomic. A slug lookup is "the doc, or not_found" — wrapping
 * that in a `{ documents: [...], next_cursor: null }` envelope and asking the
 * caller to peel out `documents[0]` is friction we'd rather absorb here.
 *
 * Revoked docs are excluded — `revokeDocumentCore` clears `documents.slug` to
 * NULL on revoke, so a revoked document has no live slug to match. (Its slug is
 * now retired into `slug_tombstones`, migration 0009 — a separate table this
 * live-only lookup never touches.) The `revoked_at IS NULL` clause is belt-and-
 * suspenders for the same reason. A retired slug surfacing as 410 Gone is the
 * caller's job (it consults findSlugTombstoneCore on this lookup's miss), not
 * this function's.
 *
 * Caller validates the slug input shape upstream (validateSlugInput in
 * src/metadata.ts); this function trusts what it receives and just runs the
 * SELECT. An invalid-shape slug that bypasses validation would simply fail
 * to match — no security implication, but the agent-facing error message is
 * better when the upstream parser catches it first.
 */
export type FindBySlugErr = { ok: false; code: "not_found" };
export async function findDocumentBySlugCore(
  env: Env,
  slug: string,
): Promise<{ ok: true; document: DocumentListing } | FindBySlugErr> {
  type Row = Omit<DocumentListing, "tags"> & { id: string; tags: string | null };
  const row = await env.META.prepare(
    `select ${LISTING_SELECT_COLUMNS}
     ${LISTING_JOINS}
     where d.slug = ? and d.revoked_at is null
     limit 1`,
  )
    .bind(slug)
    .first<Row>();
  if (!row) return { ok: false, code: "not_found" };
  const { id: _id, tags, ...rest } = row;
  return { ok: true, document: { ...rest, tags: parseStoredTags(tags) } };
}

/**
 * Resolve a slug to its live document's public_id, or null if no live
 * document carries it. Backs the MCP read_document tool's slug-input path
 * so a slug→body read is a single call (vs. list_documents then read).
 *
 * The slug is validated upstream (validateSlugInput in the handler); this
 * is the bare DB hit. It mirrors findDocumentBySlugCore's revoked-exclusion
 * — a revoked doc's slug is retired (migration 0009), so this resolves to
 * nothing and the caller distinguishes "retired → 410" from "never existed →
 * 404" via findSlugTombstoneCore. We return the public_id (not the body) so the
 * handler can reuse the unchanged readDocumentCore / readDocumentTextCore path
 * and echo the resolved capability id back to the caller.
 */
export async function resolvePublicIdBySlug(
  env: Env,
  slug: string,
): Promise<string | null> {
  const row = await env.META.prepare(
    "select public_id from documents where slug = ? and revoked_at is null limit 1",
  )
    .bind(slug)
    .first<{ public_id: string }>();
  return row?.public_id ?? null;
}

/**
 * Look up a retired slug in `slug_tombstones` (migration 0009). Returns the
 * tombstone row, or null if the slug was never claimed by any document.
 *
 * The serve / read surfaces call this ONLY after a live lookup
 * (findDocumentBySlugCore / resolvePublicIdBySlug) misses, to tell the two
 * miss-reasons apart: a retired slug → 410 Gone (it once existed and is
 * permanently spent), a never-claimed slug → opaque 404. The slug is validated
 * upstream; this is the bare DB hit.
 *
 * `redirect_to` (migration 0010) is the optional forwarding target — the target
 * document's `public_id`. NULL → a plain 410 tombstone; non-NULL → the caller
 * resolves it (resolveRedirectTarget) and forwards loudly (interstitial /
 * `409 slug_redirected` / `follow_redirects`).
 */
// SlugTombstone — a retired-slug tombstone row. Defined in src/contract.ts.
export async function findSlugTombstoneCore(
  env: Env,
  slug: string,
): Promise<SlugTombstone | null> {
  const row = await env.META.prepare(
    "select slug, document_id, retired_at, reason, redirect_to from slug_tombstones where slug = ? limit 1",
  )
    .bind(slug)
    .first<SlugTombstone>();
  return row ?? null;
}

/**
 * Display info for a redirect target — the LIVE document a retired slug's
 * `redirect_to` points at. `null` if the public_id is malformed, unknown, or
 * revoked (a dangling redirect, which the serve path falls back to 410 on).
 *
 * Returns the target's current `slug` (so the forward can land on the pretty
 * `/s/<slug>` URL, or `/d/<public_id>` when the target has no slug) and `title`
 * (for the browser interstitial's "this now points to <title>" copy).
 */
// RedirectTarget — a retired slug's live redirect target. Defined in src/contract.ts.
export async function resolveRedirectTarget(
  env: Env,
  publicId: string,
): Promise<RedirectTarget | null> {
  if (!PUBLIC_ID_RE.test(publicId)) return null;
  // `title` joins the SERVED version (issue #43), not `current_ver`. This is
  // the one non-byte query that reaches an ANONYMOUS reader: serveRetiredSlug
  // renders this title into the redirect interstitial. Left on `current_ver` it
  // would disclose the title of an unpublished version of a public document —
  // a small channel, but the same channel pinning the shell's <title> closed,
  // and one an agent controls on every write.
  const row = await env.META.prepare(
    `select d.public_id, d.slug, v.title
       from documents d
       left join versions v on v.document_id = d.id and v.version_no = ${SERVED_VER_SQL}
      where d.public_id = ? and d.revoked_at is null
      limit 1`,
  )
    .bind(publicId)
    .first<{ public_id: string; slug: string | null; title: string | null }>();
  return row ? { public_id: row.public_id, slug: row.slug, title: row.title } : null;
}

export type SlugRedirectErr =
  // The slug is not retired — there is no tombstone to attach a redirect to.
  // (A live slug serves its own document; to repoint it, revoke or rename
  // first. A never-claimed slug isn't a redirect target either.)
  | { ok: false; code: "tombstone_not_found" }
  // The target public_id is malformed, unknown, or revoked. A redirect may only
  // point at a LIVE document — a dangling target would just 410 anyway.
  | { ok: false; code: "bad_target"; target: string };

/**
 * Operator action: point a retired slug at a (live) target document by its
 * `public_id` (migration 0010). The cross-document redirect — the deliberate,
 * loud "this name moved" case (branding/consolidation). Validates the slug is
 * actually retired and the target is live before writing. Overwrites any prior
 * redirect (including a rename auto-redirect). The slug is validated upstream.
 */
export async function setSlugRedirectCore(
  env: Env,
  slug: string,
  targetPublicId: string,
): Promise<{ ok: true; target: RedirectTarget } | SlugRedirectErr> {
  const tomb = await findSlugTombstoneCore(env, slug);
  if (!tomb) return { ok: false, code: "tombstone_not_found" };
  const target = await resolveRedirectTarget(env, targetPublicId);
  if (!target) return { ok: false, code: "bad_target", target: targetPublicId };
  await env.META
    .prepare("update slug_tombstones set redirect_to = ? where slug = ?")
    .bind(target.public_id, slug)
    .run();
  return { ok: true, target };
}

/**
 * Operator action: drop a retired slug's redirect, reverting it to a plain
 * 410-Gone tombstone. No-op-safe on an already-null redirect.
 */
export async function clearSlugRedirectCore(
  env: Env,
  slug: string,
): Promise<{ ok: true } | { ok: false; code: "tombstone_not_found" }> {
  const tomb = await findSlugTombstoneCore(env, slug);
  if (!tomb) return { ok: false, code: "tombstone_not_found" };
  await env.META
    .prepare("update slug_tombstones set redirect_to = null where slug = ?")
    .bind(slug)
    .run();
  return { ok: true };
}

/**
 * Operator escape hatch: force-release a retired slug by deleting its tombstone
 * row entirely, returning the name to the pool so a future publish can claim it.
 * For the genuine "I revoked by mistake" / "I really do want to repurpose this
 * name" case. The ONLY path that un-retires a slug — everything else treats
 * retirement as permanent.
 */
export async function releaseSlugTombstoneCore(
  env: Env,
  slug: string,
): Promise<{ ok: true } | { ok: false; code: "tombstone_not_found" }> {
  const tomb = await findSlugTombstoneCore(env, slug);
  if (!tomb) return { ok: false, code: "tombstone_not_found" };
  await env.META.prepare("delete from slug_tombstones where slug = ?").bind(slug).run();
  return { ok: true };
}

/**
 * Hit row from searchDocumentsCore — the same DocumentListing shape every
 * list surface returns, plus three search-specific fields:
 *
 *   - `score`: positive float, bigger = better match. The raw FTS5 bm25()
 *     function returns NEGATIVE values (lower = better, so ORDER BY rank
 *     puts the best first); we negate before surfacing so callers can use
 *     the natural "higher is better" reading.
 *   - `matched_field`: which column the agent should treat as the
 *     "reason" for this hit. Useful for an agent deciding whether the hit
 *     is metadata-substantive (title/description) vs only a body mention.
 *     **Per-column attribution rather than strength.** D1's FTS5 bm25()
 *     does not produce reliable per-column subscores via the weights-
 *     isolation trick (passing `(1,0,0)` gives the same value as `(0,0,1)`
 *     for the same row — verified locally), so we instead detect which
 *     columns matched via their per-column `snippet()` output (the matched-
 *     token bracketing is unambiguous) and pick a winner by priority:
 *     title > description > body. The priority mirrors BM25 weights and
 *     reflects "metadata hits are stronger relevance signals than body
 *     mentions." (Tags are no longer FTS-indexed since migration 0012.)
 *   - `snippet`: a short excerpt of the matched column with `[bracketed]`
 *     match tokens, drawn from whichever column won the matched_field
 *     priority. For a body match this is the FTS5 snippet builtin's
 *     output; for a title match it's the title with the matched term
 *     bracketed.
 */
// SearchHit — a DocumentListing plus `score` / `matched_field` / `snippet`.
// Defined in src/contract.ts. (Per-column attribution rationale above.)

/**
 * Tunable BM25 column weights. Title >> description >> body.
 *
 * THE RULE: FTS5's `bm25()` takes one weight per column OF THE TABLE, in CREATE
 * order, INCLUDING `UNINDEXED` columns — an UNINDEXED column consumes a weight
 * slot even though it can never match. This is the SAME convention `snippet()`
 * column indices use; the two do NOT differ. So the migration-0012 schema
 * (`document_id UNINDEXED, title, description, body`) needs FOUR weights, with
 * `document_id` taking a wasted leading 0.0.
 *
 * Getting it wrong is silent: emitting three weights shifts every weight one
 * column left (20 → document_id, 5 → title, 1 → description) and leaves the
 * last column on bm25's 1.0 default — which is what shipped until it was
 * measured against SQLite directly. The declared 20/5/1 ran as 5/1/1, with
 * description and body scoring IDENTICALLY (an exact tie, arbitrary order),
 * and — because the keyword leg's rank list feeds RRF — degraded hybrid
 * ordering too. Nothing errors; the results just come back mis-ranked.
 *
 * Keep this object in CREATE order with one entry per column, and keep the
 * emitting `bm25(...)` call below listing every one of them.
 */
const BM25_WEIGHTS = { document_id: 0.0, title: 20.0, description: 5.0, body: 1.0 };

export type SearchErr = { ok: false; code: "bad_query" };
/** Which retrieval legs run (docs/design/vector-search-design.md §10). Default `hybrid`. */
export type SearchMode = "hybrid" | "keyword" | "semantic";

/**
 * Search over live documents — HYBRID by default (docs/design/vector-search-design.md §10).
 *
 * Three modes over a RAW query string (we tokenize for FTS internally now, so
 * the semantic leg can embed the un-tokenized query):
 *  - `keyword`  → FTS5/BM25 only (today's exact behavior; the deterministic
 *    exact-match escape hatch).
 *  - `semantic` → Vectorize only — the query is embedded, the chunk hits are
 *    collapsed to one candidate per doc, then re-joined through D1.
 *  - `hybrid`   → both legs, fused by Reciprocal Rank Fusion (`reciprocalRankFusion`
 *    in src/vector.ts). RRF fuses on RANK, so BM25 (unbounded, negated) and
 *    cosine (`[-1,1]`) never need to be put on the same scale.
 *
 * GRACEFUL DEGRADATION: the query embed is best-effort — on any AI failure
 * `embedQuery` returns null and hybrid/semantic fall back to the keyword leg;
 * search never hard-fails because the AI binding hiccuped. `bad_query` is
 * returned ONLY when no leg can carry the search: keyword mode with no usable
 * tokens, or hybrid/semantic when the embed failed AND there are no tokens.
 *
 * ACCESS: this surface is agent-key/operator-gated, NOT the anonymous browser
 * surface, so visibility does not gate search (every authenticated caller sees
 * the whole fleet); only `revoked_at` does. Vectorize is a candidate RANKER, not
 * the access gate — semantic hits are authoritatively re-joined through D1
 * (`d.revoked_at is null` + the tag/slug filters) exactly like FTS hits, so a
 * stale/revoked vector can never surface (§5/§10).
 *
 * FILTERS: `tags` / `slug` / `status` / `updatedSince` all apply here exactly as
 * they do on the list surface — both legs enforce them in their D1 clause, so a
 * filter is never a post-hoc trim of an already-ranked page. `params.order` is
 * the one list knob search IGNORES: these results are ordered by relevance, and
 * re-sorting them by time would discard the ranking that is the entire point of
 * the surface. (An agent that wants "recent, ranked" filters with
 * `updated_since` and keeps the relevance order.)
 *
 * Pagination stays disabled (BM25 / RRF score is not a stable cursor key); v1
 * caps at `limit` and returns no `next_cursor`.
 */
export async function searchDocumentsCore(
  env: Env,
  rawQuery: string,
  params: ListParams,
  mode: SearchMode = "hybrid",
): Promise<{ ok: true; documents: SearchHit[] } | SearchErr> {
  // FTS needs the tokenized form; it can be null (only punctuation / 1-char
  // words). That's `bad_query` ONLY when no semantic leg can carry the search.
  const match = buildFtsMatchQuery(rawQuery);

  if (mode === "keyword") {
    if (!match) return { ok: false, code: "bad_query" };
    return { ok: true, documents: await ftsSearch(env, match, params) };
  }

  // semantic + hybrid both need the query vector. Best-effort embed (null on any
  // AI failure → fall back to keyword rather than hard-fail, §10).
  const qvec = await embedQuery(env, rawQuery);

  if (mode === "semantic") {
    if (!qvec) {
      if (!match) return { ok: false, code: "bad_query" };
      return { ok: true, documents: await ftsSearch(env, match, params) };
    }
    const vec = await semanticSearch(env, qvec, params);
    return { ok: true, documents: vec.slice(0, params.limit) };
  }

  // hybrid (default): run both legs, fuse on rank.
  const ftsHits = match ? await ftsSearch(env, match, params) : [];
  if (!qvec) {
    if (!match) return { ok: false, code: "bad_query" };
    return { ok: true, documents: ftsHits }; // AI down → keyword-only, gracefully
  }
  const vecHits = await semanticSearch(env, qvec, params);

  if (ftsHits.length === 0 && vecHits.length === 0) {
    // Nothing matched either leg. If we also had no FTS tokens the query was
    // unusable (bad_query); otherwise it's a legitimate empty result set.
    return match ? { ok: true, documents: [] } : { ok: false, code: "bad_query" };
  }

  const ftsByPid = new Map(ftsHits.map((h) => [h.public_id, h]));
  const vecByPid = new Map(vecHits.map((h) => [h.public_id, h]));
  // Fuse the two RANK lists (best-first public_id arrays). RRF needs no score
  // normalization — see reciprocalRankFusion. Chunking is already invisible:
  // the vector list was collapsed to one entry per doc before this point.
  const fused = reciprocalRankFusion([
    ftsHits.map((h) => h.public_id),
    vecHits.map((h) => h.public_id),
  ]);

  const documents: SearchHit[] = fused.slice(0, params.limit).map(({ id: pid, score }) => {
    // A hit matched by BOTH legs keeps its FTS attribution + bracketed snippet —
    // strictly more informative than the preview (§11). A semantic-only hit gets
    // matched_field "semantic" and the preview snippet. Either way `score` is the
    // FUSED RRF score (higher = better), not the leg's native bm25/cosine.
    const ftsHit = ftsByPid.get(pid);
    if (ftsHit) return { ...ftsHit, score };
    return { ...vecByPid.get(pid)!, score };
  });
  return { ok: true, documents };
}

/**
 * The keyword leg: FTS5/BM25 over `documents_fts` (migrations/0006). `match` is a
 * SANITIZED FTS5 MATCH expression (from `buildFtsMatchQuery`). Tag/slug filters
 * compose with the MATCH; revoked docs are excluded via the JOIN's
 * `d.revoked_at is null` AND the DELETE in revokeDocumentCore's batch (belt and
 * suspenders). `matched_field` is per-column `snippet()` bracketing (title >
 * description > body priority — see the SearchHit doc comment); tags are not
 * FTS-indexed (migration 0012). Returns hits in BM25 rank order (best first).
 */
async function ftsSearch(env: Env, match: string, params: ListParams): Promise<SearchHit[]> {
  // Per-row shape with the overall BM25 score and three per-column snippet
  // outputs. The snippets are how we detect which columns matched: FTS5's
  // snippet() wraps matched tokens with the start/end delimiters we pass,
  // so the presence of '[' in a column's snippet means that column had a
  // hit. (See SearchHit doc comment for why we don't use per-column bm25.)
  // Score and snippets are search-internals — destructured off before the
  // row hits the SearchHit response shape.
  type Row = Omit<DocumentListing, "tags"> & {
    id: string;
    tags: string | null;
    score: number;
    title_snippet: string | null;
    description_snippet: string | null;
    body_snippet: string | null;
  };

  const clauses: string[] = ["documents_fts match ?", "d.revoked_at is null"];
  const binds: unknown[] = [match];

  for (const tag of params.tags) {
    clauses.push("d.tags like ? escape '\\'");
    binds.push(tagLikePattern(tag));
  }
  if (params.slug !== null) {
    clauses.push("d.slug = ?");
    binds.push(params.slug);
  }
  if (params.status !== null) {
    clauses.push("d.status = ?");
    binds.push(params.status);
  }
  if (params.visibility !== null) {
    clauses.push("d.visibility = ?");
    binds.push(params.visibility);
  }
  if (params.publication !== null) {
    // Same publication filter the list surface takes (migration 0018): it
    // narrows WHICH rows can rank, like every other filter here, and never
    // reorders them.
    clauses.push(publicationClause(params.publication));
  }
  if (params.updatedSince !== null) {
    // The change-feed window (migration 0017) filters search too — same
    // inclusive `>=` and same pre-normalized bound as the list surface. It
    // narrows WHICH rows can rank; it never reorders them.
    clauses.push("d.updated_at >= ?");
    binds.push(params.updatedSince);
  }

  // Snippet builtin: 6-arg form is (table, column_idx, start, end, ellipsis,
  // token_count). Columns are 0-indexed counting the UNINDEXED column, in
  // CREATE order — after migration 0012: document_id=0, title=1, description=2,
  // body=3 (the old tags column at index 3 is gone, so body moved 4→3). bm25()
  // uses the SAME convention: one weight per column of the table, UNINDEXED
  // included, so the weight list below is four long and leads with a wasted 0.0
  // for document_id (see BM25_WEIGHTS — dropping that slot silently shifts
  // every weight one column left). One snippet() per indexed column gives us
  // both the bracketed match context AND the per-column "did this match" signal
  // — a column whose snippet contains '[' had a hit. FTS5 caches the match
  // state across these snippet() calls per row.
  const sql = `select ${LISTING_SELECT_COLUMNS},
       -bm25(documents_fts, ${BM25_WEIGHTS.document_id}, ${BM25_WEIGHTS.title}, ${BM25_WEIGHTS.description}, ${BM25_WEIGHTS.body}) as score,
       snippet(documents_fts, 1, '[', ']', '…', 16) as title_snippet,
       snippet(documents_fts, 2, '[', ']', '…', 16) as description_snippet,
       snippet(documents_fts, 3, '[', ']', '…', 16) as body_snippet
     ${LISTING_JOINS}
     join documents_fts on documents_fts.document_id = d.id
     where ${clauses.join(" and ")}
     order by score desc
     limit ?`;
  binds.push(params.limit);

  const result = await env.META.prepare(sql).bind(...binds).all<Row>();
  return (result.results ?? []).map((row) => {
    // Detect which columns matched by looking for FTS5's bracket delimiters
    // in each per-column snippet. The snippet builtin only wraps matched
    // tokens with the start/end strings we passed — a column with no match
    // gets its value back verbatim, no brackets. This is unambiguous and
    // works around D1's FTS5 not honoring weight-isolation for per-column
    // bm25 attribution (see the SearchHit doc comment).
    //
    // Priority on multi-column matches: title > description > body.
    // Mirrors the BM25 weight ordering — a hit in curated metadata is a
    // stronger relevance signal than a body mention. Deterministic, so
    // identical queries on identical content always pick the same field.
    const matched = {
      title: (row.title_snippet ?? "").includes("["),
      description: (row.description_snippet ?? "").includes("["),
      body: (row.body_snippet ?? "").includes("["),
    };
    const matched_field: SearchHit["matched_field"] = matched.title
      ? "title"
      : matched.description
        ? "description"
        : "body"; // every row has at least one match (it's a search hit);
                  // if no column lit up via the bracket signal something
                  // upstream broke and we default to body, which is the
                  // most informative snippet to surface anyway.

    // Snippet to surface: just the matched column's bracketed output.
    // All three columns get snippet()'d so we can pick any one without an
    // extra round trip.
    const snippetByField = {
      title: row.title_snippet ?? "",
      description: row.description_snippet ?? "",
      body: row.body_snippet ?? "",
    } as const;
    const snippet = snippetByField[matched_field];

    // Strip the search-internal columns from the row before it becomes a
    // SearchHit. The destructured locals are unused (signalled with `_`)
    // but the spread of `rest` is what guarantees the response shape.
    const parsedTags = parseStoredTags(row.tags);
    const {
      id: _id,
      tags: _tags,
      score: _score,
      title_snippet: _tsn,
      description_snippet: _dsn,
      body_snippet: _bsn,
      ...rest
    } = row;
    return {
      ...rest,
      tags: parsedTags,
      score: row.score,
      matched_field,
      snippet,
    };
  });
}

/**
 * The semantic leg: embed-side already done (`qvec`). Query Vectorize, collapse
 * the chunk hits to one candidate per document (best cosine, carrying the
 * winning chunk's preview — `queryVectors`/`collapseChunksToDocs`), then RE-JOIN
 * those doc ids through D1. The re-join is where revoked + the tag/slug filters
 * are authoritatively enforced for semantic hits (Vectorize is a ranker, never
 * the gate): a candidate that's revoked or filtered out simply isn't
 * materialized. Returns hits in cosine-rank order so the caller's RRF sees the
 * vector ranking. A Vectorize hiccup degrades to "no semantic hits" (the caller
 * keeps the FTS leg), never a hard error.
 */
async function semanticSearch(
  env: Env,
  qvec: number[],
  params: ListParams,
): Promise<SearchHit[]> {
  let candidates: VectorCandidate[];
  try {
    candidates = await queryVectors(env, qvec);
  } catch (err) {
    console.error("vector.query.failed", String(err));
    return [];
  }
  if (candidates.length === 0) return [];

  type Row = Omit<DocumentListing, "tags"> & { id: string; tags: string | null };
  const ids = candidates.map((c) => c.id);
  const placeholders = ids.map(() => "?").join(", ");
  const clauses: string[] = [`d.id in (${placeholders})`, "d.revoked_at is null"];
  const binds: unknown[] = [...ids];
  for (const tag of params.tags) {
    clauses.push("d.tags like ? escape '\\'");
    binds.push(tagLikePattern(tag));
  }
  if (params.slug !== null) {
    clauses.push("d.slug = ?");
    binds.push(params.slug);
  }
  if (params.status !== null) {
    clauses.push("d.status = ?");
    binds.push(params.status);
  }
  if (params.visibility !== null) {
    clauses.push("d.visibility = ?");
    binds.push(params.visibility);
  }
  if (params.publication !== null) {
    clauses.push(publicationClause(params.publication));
  }
  if (params.updatedSince !== null) {
    // Enforced in the D1 re-join, not against Vectorize metadata — same rule as
    // revoked/tags/slug: the vector index is a ranker, D1 is the authority.
    clauses.push("d.updated_at >= ?");
    binds.push(params.updatedSince);
  }
  const sql = `select ${LISTING_SELECT_COLUMNS}
     ${LISTING_JOINS}
     where ${clauses.join(" and ")}`;
  const result = await env.META.prepare(sql).bind(...binds).all<Row>();

  // Map internal id → listing row, then walk the candidate order (cosine desc)
  // so the returned rank list matches the vector ranking RRF expects. A
  // candidate with no row (revoked / filtered out) is silently dropped.
  const rowById = new Map<string, Row>();
  for (const row of result.results ?? []) rowById.set(row.id, row);

  const hits: SearchHit[] = [];
  for (const cand of candidates) {
    const row = rowById.get(cand.id);
    if (!row) continue;
    const { id: _id, tags, ...rest } = row;
    // Snippet = the winning chunk's preview (the passage whose vector actually
    // matched), deliberately NOT bracketed (the lack of brackets itself signals
    // "concept match, not term match" — §11). Falls back to a description/title
    // excerpt only when the chunk carried no preview (a legacy vector written
    // before previews, until the next sync/backfill heals it).
    const snippet = cand.preview ?? semanticFallbackSnippet(rest.description, rest.title);
    hits.push({
      ...rest,
      tags: parseStoredTags(tags),
      score: cand.score, // cosine; overwritten by the fused score in hybrid mode
      matched_field: "semantic",
      snippet,
    });
  }
  return hits;
}

/** Snippet for a semantic hit whose winning chunk carried no preview metadata. */
function semanticFallbackSnippet(description: string | null, title: string | null): string {
  const text = (description ?? title ?? "").trim();
  return text.length > 256 ? text.slice(0, 256) : text;
}

/** Backfill modes (docs/design/vector-search-design.md §8). */
export type BackfillMode = "missing" | "rebuild";
export type BackfillResult = {
  ok: true;
  mode: BackfillMode;
  /** Live docs examined on this page. */
  scanned: number;
  /** Docs (re)synced on this page (best-effort; see `vectors`). */
  embedded: number;
  /** Total chunk vectors actually upserted across this page — a sync that hit a
   *  transient Vectorize/AI failure contributes 0 here while still counting in
   *  `embedded`, so `vectors` ≪ `embedded` is the operator's "something failed,
   *  re-run" signal. */
  vectors: number;
  /** Docs left untouched because their `#0` chunk was already present (missing mode). */
  skipped: number;
  /** Opaque resume cursor, or null when this was the last page. */
  next_cursor: string | null;
};

/**
 * Vectorize backfill / reconciliation (docs/design/vector-search-design.md §8). Operator-
 * invoked (`POST /admin/vectors/backfill`), MANUAL in v1 (no cron). Two jobs,
 * one endpoint:
 *  - `mode: "missing"` (default) — INCREMENTAL. Pages through live docs and
 *    embeds only those whose `#0` chunk is absent from the index (`presentDocIds`
 *    keys on `getByIds`). Heals docs a transient publish-time sync dropped — the
 *    dominant write-once failure (§6) — and a steady-state run embeds ~nothing.
 *    Presence-only: it does NOT catch STALE vectors (a content change whose
 *    re-sync silently failed still has a present `#0`); that needs `rebuild`.
 *  - `mode: "rebuild"` — re-embed EVERY live doc. Use after a model/chunk-size
 *    change, or to repair suspected staleness.
 *
 * Idempotent (upsert-by-id + the §6 fixed-range delete) and resumable via the
 * returned cursor. The embed input is the doc's title/description + the FTS body
 * column (the same `htmlToMarkdown(cleanedHtml)` derivation the write path
 * stored) — NO second R2 read or re-parse. A doc with no embeddable content
 * (empty body + metadata → zero chunks) has no `#0` to find, so `missing`
 * re-attempts it each run; `syncDocumentVector` produces zero chunks and does
 * nothing (cheap, idempotent).
 */
export async function backfillVectorsCore(
  env: Env,
  mode: BackfillMode,
  params: ListParams,
): Promise<BackfillResult> {
  type Row = {
    id: string;
    created_at: string;
    title: string | null;
    description: string | null;
    body: string | null;
  };

  const clauses: string[] = ["d.revoked_at is null"];
  const binds: unknown[] = [];
  if (params.cursor) {
    clauses.push("(d.created_at < ? or (d.created_at = ? and d.id < ?))");
    binds.push(params.cursor.ts, params.cursor.ts, params.cursor.id);
  }
  const peek = params.limit + 1;
  binds.push(peek);

  // Body comes from the FTS row (the write-time markdown derivation) so backfill
  // needs no R2 fetch. A legacy doc with no FTS row yields body = null → "" →
  // metadata-only chunking, exactly what a content-less doc would embed anyway.
  const sql = `select d.id, d.created_at, v.title, v.description, f.body
     from documents d
     left join versions v on v.document_id = d.id and v.version_no = d.current_ver
     left join documents_fts f on f.document_id = d.id
     where ${clauses.join(" and ")}
     order by d.created_at desc, d.id desc
     limit ?`;
  const result = await env.META.prepare(sql).bind(...binds).all<Row>();
  const { items, next_cursor } = paginate(
    result.results ?? [],
    params.limit,
    (r) => r,
    (r) => ({ ts: r.created_at, id: r.id }),
  );

  let embedded = 0;
  let vectors = 0;
  let skipped = 0;

  if (mode === "rebuild") {
    // Full sweep: re-embed (or, for a now-zero-chunk doc, clear stale vectors via
    // syncDocumentVector's zero-chunk delete) every live doc.
    for (const row of items) {
      vectors += await syncDocumentVector(env, row.id, row.title, row.description, row.body ?? "");
      embedded++;
    }
    return { ok: true, mode, scanned: items.length, embedded, vectors, skipped, next_cursor };
  }

  // `missing` mode. Pre-compute chunks (pure, cheap) so a ZERO-CHUNK doc (empty
  // body + metadata — e.g. a legacy doc with no FTS row) is treated as SYNCED and
  // skipped, not retried every run: it has no `#0` for the presence probe to ever
  // find, so keying on `#0` alone would re-embed it forever (§8). Only docs with
  // embeddable content reach the getByIds probe.
  const candidates: typeof items = [];
  for (const row of items) {
    if (chunkEmbedInputs(row.title, row.description, row.body ?? "").length === 0) {
      skipped++;
      continue;
    }
    candidates.push(row);
  }
  const present = await presentDocIds(env, candidates.map((r) => r.id));
  for (const row of candidates) {
    if (present.has(row.id)) {
      skipped++;
      continue;
    }
    vectors += await syncDocumentVector(env, row.id, row.title, row.description, row.body ?? "");
    embedded++;
  }
  return { ok: true, mode, scanned: items.length, embedded, vectors, skipped, next_cursor };
}

// RevokeOk — defined in src/contract.ts (re-exported above).
export type RevokeErr = { ok: false; code: "not_found" };

/**
 * R2's `delete(keys[])` accepts at most 1000 keys per call. The purge below is
 * up to 2× the version count (H + its `.src` sibling), so a heavily-edited doc
 * blows past it — `edit_document` appends a version per call and nothing prunes.
 */
const R2_DELETE_BATCH = 1000;

/**
 * Delete R2 keys in ≤`R2_DELETE_BATCH` chunks. Sequential on purpose: a purge is
 * a rare operator action, and serializing keeps one oversized document from
 * firing hundreds of concurrent subrequests.
 */
async function deleteR2Keys(env: Env, keys: string[]): Promise<void> {
  for (let i = 0; i < keys.length; i += R2_DELETE_BATCH) {
    await env.DOCS.delete(keys.slice(i, i + R2_DELETE_BATCH));
  }
}

/**
 * Operator kill switch for a single document. Marks `revoked_at` first so
 * the doc is unreachable instantly, then purges every version's R2 objects —
 * BOTH the rendered H blob AND the retained source S sibling.
 * Revoked-doc source is purged WITH H, not retained as an audit trail: leaving
 * unsanitized source resident after the operator pressed kill would be a §8
 * data-at-rest / exfil gap. Keeps `versions` rows as an audit trail; the bytes
 * (H and S alike) are the irrecoverable part — which is also what makes the
 * purge re-derivable: the surviving rows still carry every key.
 *
 * IDEMPOTENT ON THE PURGE PATH. An already-revoked document is NOT a 404 here —
 * it re-runs the R2 purge and returns ok. The kill (the D1 batch) lands first
 * and never repeats; the purge is the part that can fail, and before this it
 * failed UNRECOVERABLY: one transient R2 error (or a >500-version doc hitting
 * R2's 1000-key delete limit) left every unsanitized `.src` blob resident
 * forever, because the second revoke attempt 404'd on `revoked_at` and no other
 * API path purges those keys. Now a failed purge throws (loud — the operator
 * sees a 500) AND is retryable by simply re-issuing the revoke. Re-revoking is
 * safe because the D1 batch is skipped: `revoked_at` keeps its original
 * timestamp and the slug tombstone is not re-written.
 *
 * Also CLEARS the slug (sets documents.slug = NULL) as part of the same UPDATE,
 * so the live-slug queries stop resolving it. That is NOT a release: migration
 * 0009 reverses 0005's "available again on revoke" contract, and the same batch
 * RETIRES the slug into `slug_tombstones` so it can never be reclaimed (/s/<it>
 * answers 410 Gone from then on). The `public_id` survives on the row as an
 * audit/lookup key; the slug is treated like the R2 bytes — gone instantly on
 * revoke, just permanently spent rather than recyclable.
 */
export async function revokeDocumentCore(
  env: Env,
  publicId: string,
  waitUntil?: WaitUntil,
): Promise<RevokeOk | RevokeErr> {
  if (!PUBLIC_ID_RE.test(publicId)) return { ok: false, code: "not_found" };

  const row = await env.META.prepare(
    "select id, revoked_at, slug from documents where public_id = ?",
  )
    .bind(publicId)
    .first<{ id: string; revoked_at: string | null; slug: string | null }>();
  if (!row) return { ok: false, code: "not_found" };
  // Already dead: skip the kill, keep the original revoked_at, re-run the purge.
  const alreadyRevoked = row.revoked_at !== null;

  // Both keys come from D1, never from a formula: `r2_key` / `source_r2_key` are
  // opaque stored columns and the live keys carry a per-write-attempt nonce
  // (see putVersionBlobs), so `${r2Key}.src` is a coincidence of how they're
  // MINTED, not a contract this purge may rely on. `source_r2_key` is NULL on
  // pre-0008 rows — those versions genuinely have no `.src` blob to purge.
  const versions = await env.META.prepare(
    "select r2_key, source_r2_key from versions where document_id = ? order by version_no",
  )
    .bind(row.id)
    .all<{ r2_key: string; source_r2_key: string | null }>();
  const versionRows = versions.results ?? [];
  const r2Keys = versionRows.map((v) => v.r2_key);

  // Mark revoked + clear the live slug + RETIRE it into slug_tombstones + drop
  // the FTS row BEFORE purging R2 so the doc is unreachable instantly (including
  // via search) even if the bucket call hangs or fails. Batched so the writes
  // succeed together — a half-completed revoke that left the FTS row alive would
  // surface a tombstone in search results until the next reindex. Skipped
  // entirely on a re-revoke (the purge-retry path): the kill already landed, and
  // re-running this would stamp a fresh revoked_at over the real one.
  //
  // The slug is cleared from `documents.slug` (so the live-slug queries stop
  // resolving it) AND tombstoned (so it can never be reclaimed) — migration
  // 0009 reverses 0005's "released for reuse on revoke." A slugless doc skips
  // the tombstone INSERT. tombstoneSlug uses INSERT OR IGNORE so this kill
  // switch can never roll back on the tombstone write.
  if (!alreadyRevoked) {
    const statements: D1PreparedStatement[] = [
      // `updated_at` is touched here too (migration 0017): a revoke is the
      // largest change a document can undergo, and a change-feed consumer that
      // never saw it would keep serving a mirror of bytes that no longer exist.
      // Both stamps come from the same statement's `now`, so a revoked row reads
      // `updated_at == revoked_at`. The re-revoke path skips this whole batch, so
      // a retried purge can't stamp a second, fictitious "change."
      env.META.prepare(
        // `published_ver` is nulled alongside `current_ver` (migration 0018).
        // Not strictly required — every read path gates on `revoked_at` before
        // it joins — but leaving it standing means a revoked public document
        // keeps a live-looking pointer at a version whose R2 bytes this very
        // function is about to purge, and the served-version expression would
        // happily resolve it. Nulling both keeps "the kill switch leaves nothing
        // resolvable" true at the data layer instead of resting on every
        // present and future caller remembering to check revoke first.
        `update documents
         set revoked_at = ${NOW_SQL},
             current_ver = null,
             published_ver = null,
             slug = null,
             ${TOUCH_UPDATED_AT}
         where id = ?`,
      ).bind(row.id),
      env.META.prepare("delete from documents_fts where document_id = ?").bind(row.id),
      // The revoked doc's OUTBOUND link rows go with it (migration 0016) —
      // revoke tombstones the documents row rather than deleting it, so the ON
      // DELETE CASCADE never fires; this is the live cleanup. INBOUND rows in
      // other docs' link sets are raw target names and stay put — they now
      // resolve to "revoked"/"missing" at read time, which is the broken-link
      // signal documentLinksCore exists to surface.
      env.META.prepare("delete from document_links where src_doc_id = ?").bind(row.id),
    ];
    if (row.slug !== null) {
      statements.push(tombstoneSlug(env, row.slug, row.id, "revoked"));
    }
    await env.META.batch(statements);
  }

  // Purge each H key AND its retained `.src` source blob so no unsanitized
  // source survives the kill. Chunked under R2's 1000-key delete limit, which a
  // long-edited document exceeds on its own (2 keys per version). Failures
  // propagate — a silent swallow here is what a §8 kill-switch guarantee cannot
  // afford — and the operator's remedy is to re-issue the revoke, which lands
  // back on the idempotent path above and re-purges. The reported
  // r2_objects_purged stays the H count (one per version) to keep the RevokeOk
  // shape stable; the .src siblings are deleted alongside but not counted.
  const purge = versionRows.flatMap((v) =>
    v.source_r2_key === null ? [v.r2_key] : [v.r2_key, v.source_r2_key]
  );
  if (purge.length > 0) {
    await deleteR2Keys(env, purge);
  }

  // Reclaim the doc's chunk vectors AFTER the batch flipped revoked_at (§7).
  // The vector delete is NOT the kill switch — revoked_at (set above, BEFORE
  // this) is, and the read-path D1 re-join enforces `revoked_at is null` again,
  // so a revoked doc whose vectors haven't purged yet still can't surface.
  // Belt-and-suspenders, best-effort. Skipped when no waitUntil is supplied.
  if (waitUntil) {
    waitUntil(deleteDocumentVector(env, row.id));
  }

  return { ok: true, public_id: publicId, r2_objects_purged: r2Keys.length };
}

export type SetVisibilityOk = { ok: true; public_id: string; visibility: Visibility };
export type SetVisibilityErr =
  | { ok: false; code: "not_found" }
  | { ok: false; code: "invalid_visibility" };

/**
 * Operator-only: set a live document's visibility (migration 0011). Reversible,
 * no version bump, no tombstone — visibility is identity-adjacent (a property of
 * the document, like slug), not of any version's bytes. Validates the value
 * against the legal set before writing (the DB CHECK is the backstop; this
 * gives a clean `invalid_visibility` rather than a thrown constraint error).
 *
 * Targets LIVE docs only (`revoked_at IS NULL`): a revoked doc serves no bytes,
 * so flipping its visibility is meaningless → `not_found`. A no-op set
 * (public→public) still matches the row and returns ok (SQLite counts a matched
 * UPDATE row as a change), so the operator endpoint is idempotent.
 *
 * Going PUBLIC also settles what the open door leads to (migration 0018, issue
 * #43): `published_ver` is filled in the SAME statement, so a document can never
 * sit public with nothing published. See the coalesce below for which version
 * wins.
 *
 * Authority lives at the caller (requireOperator in admin.ts), NOT in
 * `can_access` — visibility-change is operator-only and deliberately kept out
 * of the read decision (see src/access.ts).
 */
export async function setDocumentVisibilityCore(
  env: Env,
  publicId: string,
  visibility: string,
): Promise<SetVisibilityOk | SetVisibilityErr> {
  if (!PUBLIC_ID_RE.test(publicId)) return { ok: false, code: "not_found" };
  if (visibility !== "public" && visibility !== "private") {
    return { ok: false, code: "invalid_visibility" };
  }
  // `coalesce(published_ver, current_ver)` on the way public, in this one
  // statement so the two columns can't disagree even for an instant:
  //   - already promoted → the operator's staged choice SURVIVES (staging a
  //     version while the doc is still private is the whole point of being able
  //     to promote a private doc at all — see promoteVersionCore).
  //   - never promoted → publish what is CURRENT, which is exactly the pre-0018
  //     behavior (going public showed the latest bytes) and keeps the flip a
  //     one-step action rather than a two-step trap.
  // Going PRIVATE deliberately leaves `published_ver` ALONE: a private doc
  // renders current_ver regardless, so clearing it would only lose the choice on
  // a private↔public round trip.
  const result = await env.META.prepare(
    visibility === "public"
      ? `update documents set visibility = ?, published_ver = coalesce(published_ver, current_ver), ${TOUCH_UPDATED_AT} where public_id = ? and revoked_at is null`
      : `update documents set visibility = ?, ${TOUCH_UPDATED_AT} where public_id = ? and revoked_at is null`,
  )
    .bind(visibility, publicId)
    .run();
  if ((result.meta?.changes ?? 0) === 0) return { ok: false, code: "not_found" };
  return { ok: true, public_id: publicId, visibility };
}

export type PromoteOk = { ok: true; public_id: string; published_ver: number };
export type PromoteErr =
  | { ok: false; code: "not_found" }
  // The document is live but carries no such version. Distinct from `not_found`
  // so the caller can say "that document exists, that version doesn't" — the
  // same split restoreVersionCore and the version-pinned reads already use.
  | { ok: false; code: "version_not_found" };

/**
 * Operator-only: choose WHICH version a public document renders (migration
 * 0018, GitHub issue #43) — the promote half of the published/current split.
 *
 * The problem it closes: any active agent key can overwrite any live document
 * (the single-tenant trust model), and some documents are `public`. With one
 * version pointer, "the bytes an agent just wrote" and "the bytes the anonymous
 * internet reads" are the same thing — so an agent can move private content onto
 * a public address in a single write. Splitting the pointers means an agent's
 * write always lands as a new CURRENT version (visible to every credentialed
 * surface, editable, searchable, indexed) while a public document's HTML byte
 * path keeps serving the version an OPERATOR promoted. Staged is not published.
 *
 * `published_ver` is nullable and means exactly "nothing is published" — the
 * same presence-flag posture as the 0008/0015 source columns, not a default to
 * be papered over. The serving rule itself lives at the render path: a public
 * doc with a non-NULL `published_ver` serves THAT version to every caller —
 * anonymous, agent and operator alike, so the operator sees what the world sees
 * — and a private doc always renders `current_ver`. Every credentialed/machine
 * surface (/text, /source, /links, the MCP reads, search, packs, FTS, vectors,
 * the link graph) stays on `current_ver`, unchanged: the split governs the
 * public BYTE path and nothing else.
 *
 * Classification, not content: no version bump, no FTS write, no vector sync, no
 * tombstone — promoting moves a pointer, exactly like the visibility/tags/status
 * mutators, and stamps `updated_at` for the same reason they do (a change feed
 * must see it; nothing else records that it happened).
 *
 * Deliberately allowed on PRIVATE documents: staging the choice before the door
 * opens is a feature, not a loophole — it takes effect the moment visibility
 * flips, because setDocumentVisibilityCore preserves an already-staged pointer
 * rather than overwriting it with current.
 *
 * Targets LIVE docs only (`revoked_at IS NULL`): a revoked doc renders nothing,
 * so promoting into it is meaningless → `not_found`. Authority lives at the
 * caller (requireOperator in admin.ts / the manage-page form ladder): deciding
 * what the anonymous internet reads is the same KIND of authority as
 * `visibility` itself, so it never reaches the agent door.
 */
export async function promoteVersionCore(
  env: Env,
  publicId: string,
  versionNo: number,
): Promise<PromoteOk | PromoteErr> {
  if (!PUBLIC_ID_RE.test(publicId)) return { ok: false, code: "not_found" };
  // A non-integer / non-positive version can never name a row, so reject it as
  // the miss it is rather than binding a NaN into the lookup below.
  if (!Number.isInteger(versionNo) || versionNo < 1) {
    return { ok: false, code: "version_not_found" };
  }

  // One query answers both questions: the LEFT JOIN means a LIVE document with
  // no such version still comes back (with a NULL version_no), which is what
  // separates "no such document" from "no such version" without a second trip.
  const row = await env.META.prepare(
    `select d.id, v.version_no
     from documents d
     left join versions v on v.document_id = d.id and v.version_no = ?
     where d.public_id = ? and d.revoked_at is null`,
  )
    .bind(versionNo, publicId)
    .first<{ id: string; version_no: number | null }>();
  if (!row) return { ok: false, code: "not_found" };
  if (row.version_no === null) return { ok: false, code: "version_not_found" };

  // Re-assert `revoked_at is null` on the write: a revoke committing between the
  // lookup and here must win (it is the kill switch), and a zero-change UPDATE
  // is how we notice. Idempotent otherwise — re-promoting the version that is
  // already published matches the row and returns ok, like every other mutator
  // in this section.
  const result = await env.META.prepare(
    `update documents set published_ver = ?, ${TOUCH_UPDATED_AT} where id = ? and revoked_at is null`,
  )
    .bind(versionNo, row.id)
    .run();
  if ((result.meta?.changes ?? 0) === 0) return { ok: false, code: "not_found" };
  return { ok: true, public_id: publicId, published_ver: versionNo };
}

export type SetStatusOk = {
  ok: true;
  public_id: string;
  status: DocumentStatus;
  /** The stored replacement pointer after the change (null unless deprecated with a successor). */
  superseded_by: string | null;
};
export type SetStatusErr =
  | { ok: false; code: "not_found" }
  // The status value isn't settable: not in the enum, or the reserved
  // "archived" (pinned in the CHECK for a future migration-free wiring, but
  // no surface honors it in v1 — letting it be SET with undefined behavior
  // would be a silent trap).
  | { ok: false; code: "invalid_status" }
  // superseded_by is malformed, names no live document, or points at the
  // document itself. Mirrors the slug-redirect target validation (same loud
  // single-hop contract).
  | { ok: false; code: "bad_target"; target: string };

/**
 * Set a LIVE document's lifecycle status (migration 0014) WITHOUT bumping a
 * version. Reachable from THREE doors — operator
 * `POST /admin/documents/:id/status`, agent `PUT /d/:id/status`, and the MCP
 * `set_document_status` tool — so this is an "operator mutator" by history, not
 * by gate. Status is classification — like tags (0012) and
 * slug (0005), a property of the document's place in the collection, not of
 * any version's bytes — so this mirrors setDocumentVisibilityCore /
 * setDocumentTagsCore's no-version-bump shape.
 *
 * v1 wires `active` and `deprecated`; `archived` is reserved in the DB CHECK
 * and REJECTED here (`invalid_status`) until its hide-from-default-search
 * behavior is actually built — a settable state with no wired semantics would
 * be a silent trap.
 *
 * `supersededBy` is the optional replacement pointer for a deprecated doc (a
 * target `public_id` — the document-level analogue of
 * slug_tombstones.redirect_to). FULL-REPLACE semantics per call, like tags:
 * the supplied value (or its absence) becomes the stored value outright.
 * Validated when present: must name a LIVE document (`resolveRedirectTarget`)
 * and must not be the document itself (`bad_target` either way) — single-hop
 * by construction, since the stored value is a public_id, never a chain.
 * Setting status back to `active` forces the pointer NULL regardless of input
 * (an active doc has no replacement).
 *
 * Targets LIVE docs only (`revoked_at IS NULL`): a revoked doc is already
 * terminally gone — deprecating it is meaningless → `not_found`. Idempotent on
 * a no-op set. Authority lives at the caller, deliberately NOT in `canRead` —
 * status never gates read access anywhere; it only marks hits and filters packs.
 * Callers now span both doors: the operator's POST /admin/documents/:id/status
 * and manage-page form, plus the agent-reachable `PUT /d/:id/status`
 * (requireReader) and the MCP `set_document_status` tool — same reasoning as
 * tags, since status marks currency without reaching an anonymous surface.
 */
export async function setDocumentStatusCore(
  env: Env,
  publicId: string,
  statusInput: string,
  supersededByInput?: string | null,
): Promise<SetStatusOk | SetStatusErr> {
  if (!PUBLIC_ID_RE.test(publicId)) return { ok: false, code: "not_found" };
  if (statusInput !== "active" && statusInput !== "deprecated") {
    return { ok: false, code: "invalid_status" };
  }
  const status: DocumentStatus = statusInput;

  // Resolve the pointer BEFORE the write. Active forces null; an absent/empty
  // input on deprecate is an explicit "no successor" (full-replace, like tags).
  let supersededBy: string | null = null;
  if (status === "deprecated" && supersededByInput) {
    if (supersededByInput === publicId) {
      return { ok: false, code: "bad_target", target: supersededByInput };
    }
    const target = await resolveRedirectTarget(env, supersededByInput);
    if (!target) return { ok: false, code: "bad_target", target: supersededByInput };
    supersededBy = target.public_id;
  }

  const result = await env.META.prepare(
    `update documents set status = ?, superseded_by = ?, ${TOUCH_UPDATED_AT} where public_id = ? and revoked_at is null`,
  )
    .bind(status, supersededBy, publicId)
    .run();
  if ((result.meta?.changes ?? 0) === 0) return { ok: false, code: "not_found" };
  return { ok: true, public_id: publicId, status, superseded_by: supersededBy };
}

export type SetTagsOk = { ok: true; public_id: string; tags: string[] };
export type SetTagsErr = { ok: false; code: "not_found" };

/**
 * Replace a LIVE document's tags WITHOUT bumping a version (migration 0012).
 * Reachable from THREE doors — operator `POST /admin/documents/:id/tags`, agent
 * `PUT /d/:id/tags`, and the MCP `set_document_tags` tool — so this is an
 * "operator mutator" by history, not by gate. Tags are document-level
 * classification — a property of the
 * document's place in the collection, not of any version's bytes — so this
 * mirrors setDocumentVisibilityCore / setDocumentSlugCore's no-version-bump
 * shape rather than the publish/update version path. This is the librarian's
 * primary write verb (the curation pass retags without churning content).
 *
 * FULL replacement, not a merge: the supplied list becomes the document's tags
 * outright; `[]` clears them (stored NULL via serializeTags). Input runs through
 * the same `sanitizeTagsInput` (charset strip, dedupe, count cap) and
 * `serializeTags` shape as the write path, so the stored bytes are identical to
 * what publish/update would store and `parseStoredTags` / the `?tags=` filter
 * read them back unchanged.
 *
 * No FTS sync is needed — since 0012 `documents_fts` does not index tags; the
 * list/search surfaces read `documents.tags` directly and the `?tags=` filter
 * is a LIKE on that column, never FTS.
 *
 * Targets LIVE docs only (`revoked_at IS NULL`): a revoked doc serves nothing,
 * so retagging it is meaningless → `not_found`. A no-op set still matches the
 * row and returns ok (SQLite counts a matched UPDATE as a change), so the
 * endpoint is idempotent.
 *
 * Authority lives at the caller, NOT in `canRead` — deliberately kept out of the
 * read decision (mirrors visibility/slug; see src/access.ts). That caller is no
 * longer only the operator: `PUT /d/:id/tags` (requireReader) and the MCP
 * `set_document_tags` tool put this on the agent door too, because tags are a
 * fleet-internal filter that reaches no anonymous surface — an agent key that
 * can replace a document's whole CONTENT grants strictly more. `visibility` and
 * publication stayed operator-only for exactly the inverse reason.
 */
export async function setDocumentTagsCore(
  env: Env,
  publicId: string,
  tagsInput: unknown,
): Promise<SetTagsOk | SetTagsErr> {
  if (!PUBLIC_ID_RE.test(publicId)) return { ok: false, code: "not_found" };
  const tags = sanitizeTagsInput(tagsInput);
  const result = await env.META.prepare(
    `update documents set tags = ?, ${TOUCH_UPDATED_AT} where public_id = ? and revoked_at is null`,
  )
    .bind(serializeTags(tags), publicId)
    .run();
  if ((result.meta?.changes ?? 0) === 0) return { ok: false, code: "not_found" };
  return { ok: true, public_id: publicId, tags };
}

export type SetSlugOk = {
  ok: true;
  public_id: string;
  /** The slug after the change — the new value, or null after a clear/no-op-on-empty. */
  slug: string | null;
  /** The prior slug that was retired into a tombstone, or null if there was none. */
  retired: string | null;
  /**
   * True when the retired prior slug now auto-forwards to THIS document (a
   * rename). False on a first-time claim (nothing retired), a clear/release
   * (retired but NOT forwarded — a plain 410 tombstone), or a no-op.
   */
  redirected: boolean;
};
export type SetSlugErr =
  | { ok: false; code: "not_found" }
  | { ok: false; code: "invalid_slug"; reason: SlugReject }
  | { ok: false; code: "slug_taken"; slug: string }
  | { ok: false; code: "slug_retired"; slug: string };

/**
 * Operator-only: change (add / rename / clear) a LIVE document's slug WITHOUT
 * bumping a version. Slug is identity-adjacent — a property of the document, not
 * of any version's bytes — so this mirrors setDocumentVisibilityCore's
 * no-version-bump shape rather than going through the publish/update version
 * path.
 *
 * It reuses the SAME `resolveSlug` decision and `tombstoneSlug` writes the
 * agentic update path uses, so the semantics are identical by construction:
 *   - **rename** (was slug A, now B) → claim B on `documents.slug` and RETIRE A
 *     into `slug_tombstones` with `redirect_to = this document's own public_id`
 *     (migration 0010). `/s/A` then auto-forwards LOUDLY to the doc at its new
 *     name — the exact behavior an agent's `update_document` slug change gives.
 *   - **first claim** (was no slug, now B) → claim B; nothing to retire.
 *   - **clear** (`slugInput === ""`, was slug A) → set slug NULL and retire A as
 *     a plain `released` tombstone (NO redirect — a cleared name 410s).
 *   - **no-op** (same slug, or empty on an already-slugless doc) → nothing.
 *
 * Uniqueness is enforced exactly as on the write path: a slug live on another
 * document → `slug_taken`; one ever claimed and retired → `slug_retired` (slugs
 * are not reusable; the operator's `DELETE /admin/slugs/:slug` escape hatch is
 * the only un-retire path). Invalid charset → `invalid_slug`.
 *
 * No FTS sync is needed — `documents_fts` does not index the slug; the
 * list/search/serve surfaces read `documents.slug` directly.
 *
 * Targets LIVE docs only (`revoked_at IS NULL`): a revoked doc's slug is already
 * retired, so there is nothing to change → `not_found`.
 */
export async function setDocumentSlugCore(
  env: Env,
  publicId: string,
  slugInput: string,
): Promise<SetSlugOk | SetSlugErr> {
  if (!PUBLIC_ID_RE.test(publicId)) return { ok: false, code: "not_found" };

  const row = await env.META.prepare(
    "select id, slug, revoked_at from documents where public_id = ?",
  )
    .bind(publicId)
    .first<{ id: string; slug: string | null; revoked_at: string | null }>();
  if (!row || row.revoked_at) return { ok: false, code: "not_found" };

  // Same decision as the publish/update path. `selfId = row.id` so a same-slug
  // submit is a no-op and the uniqueness check ignores this document's own row.
  const slugResult = await resolveSlug(env, slugInput, row.slug, row.id);
  if (!slugResult.ok) return slugResult;
  const action = slugResult.action;

  const statements: D1PreparedStatement[] = [];
  let resolvedSlug: string | null;
  let retired: string | null = null;
  let redirected = false;

  if (action.kind === "set") {
    statements.push(
      env.META.prepare(
        `update documents set slug = ?, ${TOUCH_UPDATED_AT} where id = ?`,
      ).bind(action.slug, row.id),
    );
    // Rename: retire the old name AND auto-forward it to this doc's own
    // public_id (same-document redirect, migration 0010) — identical to the
    // agentic update path. A first-time claim has retire === null.
    if (action.retire !== null) {
      statements.push(tombstoneSlug(env, action.retire, row.id, "renamed", publicId));
      retired = action.retire;
      redirected = true;
    }
    resolvedSlug = action.slug;
  } else if (action.kind === "clear") {
    statements.push(
      env.META.prepare(
        `update documents set slug = null, ${TOUCH_UPDATED_AT} where id = ?`,
      ).bind(row.id),
    );
    // Release un-publishes the name but does NOT free it — tombstoned with no
    // redirect, so `/s/<old>` 410s.
    statements.push(tombstoneSlug(env, action.retire, row.id, "released"));
    retired = action.retire;
    resolvedSlug = null;
  } else {
    // No-op — leave documents.slug untouched, and DON'T touch `updated_at`
    // either (migration 0017). Re-submitting the same slug changed nothing, so
    // surfacing it in a change feed would be a lie the caller can't distinguish
    // from a real rename.
    resolvedSlug = action.slug;
  }

  if (statements.length > 0) await env.META.batch(statements);
  return { ok: true, public_id: publicId, slug: resolvedSlug, retired, redirected };
}
