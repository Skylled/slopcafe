// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/**
 * The document WRITE transaction: publish / update / edit / restore, without
 * any Request/Response or auth coupling. The caller (HTTP handler in
 * src/index.ts, MCP tool in src/mcp-tools/*, the operator door in src/admin-documents.ts,
 * the seeder, the backup restore) is responsible for resolving an identity;
 * these functions trust the `Author` they receive and stamp it as the document
 * creator / version author.
 *
 * Two callers, one path: sanitization runs exactly once, inside
 * `screenAndPrepare`, regardless of which surface the bytes arrived through.
 * This is the extraction promised in plans/playful-stirring-deer.md §"Step 8".
 *
 * Key invariants, all kept locally readable in THIS file (issue #72 phase 3 —
 * the sequenced `META.batch()` bodies are deliberately not chopped into
 * cross-module steps):
 *   - `screenAndPrepare` is the ONE copy of the input guards + the
 *     convert-then-sanitize step (empty_body / too_large / pre-depth /
 *     prepareForStorage / post-depth).
 *   - `updateDocumentCore` orders version_conflict → slug lock → identical-write
 *     no-op collapse (contract 2.1.0), keyed on source S + sanitizer_v.
 *   - FTS, link-graph and `updated_at` maintenance ride the SAME batch as the
 *     version row; vector sync is post-commit via `waitUntil`.
 *   - edit and restore DELEGATE to updateDocumentCore with the doc's OWN
 *     source_format, never a hardcoded "html".
 *
 * Dependency direction: this module imports document-read (source reads),
 * document-slug, document-storage, document-link-sync and document-listing.
 * Nothing imports this module except transports, src/backup.ts and
 * src/seed-docs.ts.
 */

import { type Author, defaultDocumentVisibility, type Visibility } from "./access.js";
import { recordAudit } from "./audit.js";
import { maxNestingDepth } from "./depth.js";
import { applyEdits, type EditSpec } from "./edit.js";
import { computeAdvisories, readDocumentSourceCore } from "./document-read.js";
import { documentLinkStatements } from "./document-link-sync.js";
import { NOW_SQL, parseStoredTags, serializeTags, TOUCH_UPDATED_AT } from "./document-listing.js";
import { resolveSlug, tombstoneSlug } from "./document-slug.js";
import { checkStorageCap, putVersionBlobs } from "./document-storage.js";
import type { Env } from "./env.js";
import { newPublicId, newUuid, PUBLIC_ID_RE } from "./ids.js";
import { sha256Hex } from "./integrity.js";
import {
  deriveTitleFromHtml,
  type DocumentMetadataInput,
  type ResolvedMetadata,
  sanitizeTagsInput,
  type SlugReject,
  validateDescriptionInput,
  validateTitleInput,
} from "./metadata.js";
import {
  htmlToMarkdown,
  markdownToHtml,
  maxDomDepth,
  sanitizerVersion,
} from "./sanitizer.js";
import { syncDocumentVector, type WaitUntil } from "./vector-io.js";
import type {
  EditOk,
  RestoreOk,
  SourceFormat,
  WriteOk,
} from "./contract.js";

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

/** The output of `prepareForStorage` — both write paths thread this through.
 *  Exported (with `screenAndPrepare` / `putVersionBlobs`) for the ONE other
 *  path that stores a version without minting a document: the backup restore
 *  in src/backup.ts, which re-renders retained source S through this exact
 *  pipeline rather than trusting the H bytes in the file. */
export type Prep = ReturnType<typeof prepareForStorage>;

export type PrepareErr =
  | { ok: false; code: "empty_body" }
  | { ok: false; code: "too_large"; limit: number; size: number }
  | { ok: false; code: "too_deep"; limit: number; depth: number };

/**
 * The input guards + the convert-then-sanitize step, in the one order every
 * write door must run them. The SINGLE copy: publishDocumentCore and
 * updateDocumentCore (hence edit/restore) call it, and so does the backup
 * restore path (src/backup.ts) — which is precisely why it is exported: a
 * restored version's H is re-derived from its source S through THIS function,
 * so it can't be deeper, larger or less sanitized than a fresh publish.
 *
 *   1. `empty_body` — nothing to store.
 *   2. `too_large` — rejects oversize *input* up front, matching the HTTP path
 *      (which 413s on raw req.arrayBuffer() bytes before decoding). The MCP
 *      path has no Request to pre-check, so the cap is enforced here. It
 *      applies to the raw input bytes (HTML or Markdown); a Markdown document
 *      that expands during conversion is still bounded by what was sent.
 *   3. `too_deep` (pre-screen, issue #42) — the cheap O(n) open-tag scan runs
 *      BEFORE the ~O(n²) sanitize parse (html5ever tree-build + Rc drop) ever
 *      touches the bytes. Markdown converts first (pulldown-cmark is O(n) even
 *      on deep nesting), then the converted HTML's depth is scanned. A genuine
 *      bomb is refused here ~1000× cheaper than the tree-build.
 *   4. `prepareForStorage` — convert (if needed) + sanitize; the trust boundary
 *      for both input formats (pulldown-cmark does not filter dangerous HTML on
 *      its own — see sanitizer/src/lib.rs markdown_to_html docs).
 *   5. `too_deep` (authoritative, issue #41) — measured precisely on the
 *      sanitized H, the bytes htmlToMarkdown would later recurse over; the
 *      pre-screen has already refused the bombs, so this runs on shallow input.
 */
export function screenAndPrepare(
  body: string,
  format: SourceFormat,
): { ok: true; prep: Prep } | PrepareErr {
  if (body.length === 0) return { ok: false, code: "empty_body" };

  const inputBytes = new TextEncoder().encode(body);
  if (inputBytes.byteLength > MAX_INPUT_BYTES) {
    return { ok: false, code: "too_large", limit: MAX_INPUT_BYTES, size: inputBytes.byteLength };
  }

  const preDepth = maxNestingDepth(format === "markdown" ? markdownToHtml(body) : body);
  if (preDepth > MAX_DOM_DEPTH) {
    return { ok: false, code: "too_deep", limit: MAX_DOM_DEPTH, depth: preDepth };
  }

  const prep = prepareForStorage(body, format);

  if (prep.depth > MAX_DOM_DEPTH) {
    return { ok: false, code: "too_deep", limit: MAX_DOM_DEPTH, depth: prep.depth };
  }

  return { ok: true, prep };
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
  // Screen + prepare: empty / oversize / depth-bomb guards, then convert-if-
  // needed → sanitize. ONE copy, in screenAndPrepare (shared with
  // updateDocumentCore and the backup restore path in src/backup.ts).
  const screened = screenAndPrepare(body, format);
  if (!screened.ok) return screened;
  const prep = screened.prep;

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
  // The OAuth client that minted the writing grant (migration 0019 / issue #63),
  // or NULL — for the operator, for a Door B `awh_` bearer, and for any caller
  // whose Author simply carries no client. Purely attributive; it never reaches
  // an access decision. `?? null` normalizes the optional field's `undefined`
  // into the SQL NULL D1 binds.
  const authorClientId = author.kind === "agent" ? (author.clientId ?? null) : null;

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
        `insert into versions (document_id, version_no, r2_key, size_bytes, sanitizer_v, source_format, source_r2_key, source_size_bytes, source_sha256, title, description, author_kind, author_agent_id, author_client_id)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        authorClientId,
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
    // Ledger (0020). Recorded HERE rather than at each route because this core
    // is the single point every principal-driven write converges on — HTTP
    // `PUT /d/:id`, MCP `update_document` and `edit_document`, and restore all
    // delegate here — so one call covers every door and a future write surface
    // gets it for free.
    //
    // A refusal, not a failure: at low volume a run of conflicts on one document
    // is the readable signature of two writers fighting over it, which is
    // invisible in any other record the system keeps.
    recordAudit(env, waitUntil, {
      kind: "write_conflict",
      principal_kind: author.kind,
      document_id: publicId,
      agent_id: author.kind === "agent" ? author.agentId : undefined,
      client_id: author.kind === "agent" ? (author.clientId ?? undefined) : undefined,
      expected: expectedVersion,
      current: row.current_ver,
    });
    return {
      ok: false,
      code: "version_conflict",
      current_version: row.current_ver,
      expected: expectedVersion,
    };
  }

  // Same shared screen + prepare as publish (edit/restore/backup-restore all
  // reach this core or the same helper, so a deep or oversize version can't be
  // re-stored through any door).
  const screened = screenAndPrepare(body, format);
  if (!screened.ok) return screened;
  const prep = screened.prep;

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
    // Ledger (0020): an agent attempting to rename or release the name of an
    // ANONYMOUSLY READABLE document is the refusal most worth a durable record
    // — it is the exact write channel onto the open web that issue #43 closed,
    // and repeated attempts say either "a client is misconfigured" or something
    // worse. The lock itself is unchanged; this only writes it down.
    recordAudit(env, waitUntil, {
      kind: "slug_locked",
      principal_kind: "agent",
      document_id: publicId,
      agent_id: author.agentId,
      client_id: author.clientId ?? undefined,
    });
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
  // The writing grant's OAuth client (migration 0019 / issue #63) — NULL for the
  // operator, for a Door B `awh_` bearer, and for any Author with no client.
  // Recorded per VERSION, so a document written by two different clients bound
  // to the same agent reads back as two distinguishable writes.
  const authorClientId = author.kind === "agent" ? (author.clientId ?? null) : null;

  // Same write-time markdown derivation as publishDocumentCore — feeds the
  // FTS body column so search results follow the doc's current version.
  const ftsBody = htmlToMarkdown(prep.cleanedHtml);

  try {
    // Build the batch dynamically — only include the slug UPDATE when the
    // agent actually changed something. Keeps the no-op path (the vast
    // majority of updates) free of an extra round-trip statement.
    const statements: D1PreparedStatement[] = [
      env.META.prepare(
        `insert into versions (document_id, version_no, r2_key, size_bytes, sanitizer_v, source_format, source_r2_key, source_size_bytes, source_sha256, title, description, author_kind, author_agent_id, author_client_id)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        authorClientId,
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
