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
import type { Env } from "./env.js";
import { newPublicId, newUuid } from "./ids.js";
import { type ListParams, paginate } from "./pagination.js";
import {
  deriveTitleFromHtml,
  type DocumentMetadataInput,
  type ResolvedMetadata,
  sanitizeTagsInput,
  type SlugReject,
  validateDescriptionInput,
  validateSlugInput,
  validateTitleInput,
} from "./metadata.js";
import {
  converterVersion,
  htmlToMarkdown,
  markdownToHtml,
  sanitize,
  sanitizerVersion,
} from "./sanitizer.js";
import { PUBLIC_ID_RE } from "./serve.js";

// Re-export so HTTP/MCP wrappers don't have to import from two places.
export type { DocumentMetadataInput, ResolvedMetadata };

/** Per-document raw input cap. The per-fleet storage cap is enforced separately. */
export const MAX_INPUT_BYTES = 5 * 1024 * 1024; // 5 MiB

/**
 * Which input format the caller sent. Stored on the versions row as
 * `source_format` so admin/list views can show provenance without inspecting
 * the bytes. The stored R2 blob is always sanitized HTML — convert-and-discard
 * is the v1 model — but knowing what the agent originally authored is useful.
 *
 * The trust boundary is identical for both: sanitize() runs on the
 * post-conversion HTML regardless of source format.
 */
export type SourceFormat = "html" | "markdown";

/** Shared "successful write" shape — same for publish and update. */
export type WriteOk = {
  ok: true;
  public_id: string;
  url: string;
  version: number;
  size_bytes: number;
  sanitizer_v: string;
  modified: boolean;
  /**
   * Short, human/agent-readable summaries of constructs the sanitizer
   * removed. Empty array when `modified: false` (and usually empty even
   * when modified, if the change was something we don't pattern-match —
   * advisory is best-effort). See src/advisories.ts.
   */
  stripped: string[];
  /**
   * Constructs that survived the sanitizer but the iframe CSP will refuse
   * to load (currently: external <img src>). Without this the agent has
   * no signal at all — `modified: false` and a broken-image render.
   */
  will_not_render: string[];
  /**
   * Metadata as resolved at write time — what actually ends up stored on
   * the new version row. Worth echoing back because two paths produce a
   * value the agent didn't directly supply:
   *   - title was DERIVED from the document's first <h1> (or first-N text)
   *     because the agent omitted it on publish, or sent "" on update.
   *   - title/description/tags were INHERITED from the prior version
   *     because the agent omitted them on update.
   * Returning the resolved values lets the agent confirm what got stored
   * without a follow-up read.
   */
  title: string | null;
  description: string | null;
  tags: string[];
  /**
   * Document slug, if one is set. Lives on the `documents` row — survives
   * updates without rewriting unless the agent explicitly changes it — and
   * is cleared (released) on revoke. `null` for documents without a slug.
   */
  slug: string | null;
};

/** Result codes the wrappers translate to HTTP statuses / model-readable text. */
export type PublishErr =
  | { ok: false; code: "empty_body" }
  | { ok: false; code: "too_large"; limit: number; size: number }
  | { ok: false; code: "storage_cap_exceeded"; used: number; cap: number; this_write: number }
  | { ok: false; code: "invalid_slug"; reason: SlugReject }
  | { ok: false; code: "slug_taken"; slug: string };

export type UpdateErr =
  | PublishErr
  | { ok: false; code: "not_found" }
  | { ok: false; code: "version_conflict"; current_version: number; expected: number };

/**
 * Global storage cap. Sums `size_bytes` across every non-revoked version,
 * regardless of which agent created the document — v1 is single-operator,
 * so the cap is a fleet-wide guardrail rather than a per-agent quota.
 *
 * Best-effort: the SUM runs outside the insert batch, so two concurrent
 * writes can both pass the check. v1 accepts the slight overrun.
 */
export async function checkStorageCap(
  env: Env,
  addBytes: number,
): Promise<{ ok: true } | { ok: false; used: number; cap: number }> {
  const cap = Number(env.STORAGE_CAP_BYTES);
  const row = await env.META.prepare(
    `select coalesce(sum(v.size_bytes), 0) as used
     from versions v
     join documents d on d.id = v.document_id
     where d.revoked_at is null`,
  ).first<{ used: number }>();
  const used = Number(row?.used ?? 0);
  if (used + addBytes > cap) return { ok: false, used, cap };
  return { ok: true };
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
 */
function prepareForStorage(body: string, format: SourceFormat): {
  cleanedHtml: string;
  cleanedBytes: Uint8Array;
  sanitizerV: string;
  modified: boolean;
  stripped: string[];
  will_not_render: string[];
} {
  const asHtml = format === "markdown" ? markdownToHtml(body) : body;
  const cleanedHtml = sanitize(asHtml);
  const cleanedBytes = new TextEncoder().encode(cleanedHtml);
  const advisories = detectAdvisories(asHtml, cleanedHtml);
  return {
    cleanedHtml,
    cleanedBytes,
    sanitizerV: sanitizerVersion(),
    modified: asHtml !== cleanedHtml,
    stripped: advisories.stripped,
    will_not_render: advisories.will_not_render,
  };
}

/**
 * Resolve the per-version metadata triple into the values that get written
 * to the versions row. Encodes the three rules:
 *
 *   1. Inheritance — `undefined` on update means "carry over from prior".
 *      On publish, prior is null, so `undefined` falls back to defaults
 *      (derive title; null description; empty tags).
 *
 *   2. Explicit clear — empty string for title means "re-derive from new
 *      content"; empty string for description means "no description";
 *      empty array for tags means "no tags". Distinguishes "leave alone"
 *      (undefined) from "actively clear" (empty), which the inherit-on-
 *      omit contract needs.
 *
 *   3. Defensive validation — derived titles flow through validateTitleInput
 *      (NFC + control-strip + trim + length cap), agent-supplied tags flow
 *      through sanitizeTagsInput, agent-supplied strings through validate*.
 *      Boundary parsers (parseMetadataHeaders, MCP tool wrappers) already do
 *      this, but applying it here too means a single source of truth — the
 *      versions row never ends up with bytes a future validator would reject.
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

  // ---- tags ---------------------------------------------------------------
  let tags: string[];
  if (input.tags === undefined) {
    tags = prior ? [...prior.tags] : [];
  } else {
    tags = sanitizeTagsInput(input.tags);
  }

  return { title, description, tags };
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
  | { kind: "set"; slug: string }
  | { kind: "clear" };
async function resolveSlug(
  env: Env,
  input: string | undefined,
  priorSlug: string | null,
  selfId: string | null,
): Promise<{ ok: true; action: SlugAction } | Extract<PublishErr, { code: "invalid_slug" | "slug_taken" }>> {
  // Field absent → carry through whatever's already there.
  if (input === undefined) return { ok: true, action: { kind: "noop", slug: priorSlug } };

  // Empty value → release. Cheap and unambiguous; no uniqueness check needed
  // since NULL slugs aren't covered by the partial unique index.
  if (input.trim().length === 0) {
    // If the doc already has no slug, this is a no-op — avoid the UPDATE.
    if (priorSlug === null) return { ok: true, action: { kind: "noop", slug: null } };
    return { ok: true, action: { kind: "clear" } };
  }

  const v = validateSlugInput(input);
  if (!v.ok) return { ok: false, code: "invalid_slug", reason: v.reason };
  const slug = v.slug;

  // Same slug as the existing one — skip the uniqueness query AND the UPDATE.
  if (slug === priorSlug) return { ok: true, action: { kind: "noop", slug } };

  // Uniqueness pre-check. The partial UNIQUE INDEX on documents(slug) WHERE
  // slug IS NOT NULL also enforces this at insert/update time, but a
  // pre-check gives us a clean error code instead of a thrown constraint
  // violation (D1 doesn't surface those structurally). Best-effort: a race
  // can still slip a second claim through between this SELECT and the
  // write, in which case the UPDATE/INSERT will throw and the top-level
  // try/catch surfaces it as an internal error. Acceptable for v1.
  const conflictQ = selfId
    ? env.META.prepare("select id from documents where slug = ? and id != ?").bind(slug, selfId)
    : env.META.prepare("select id from documents where slug = ?").bind(slug);
  const conflict = await conflictQ.first<{ id: string }>();
  if (conflict) return { ok: false, code: "slug_taken", slug };

  return { ok: true, action: { kind: "set", slug } };
}

export async function publishDocumentCore(
  env: Env,
  body: string,
  agentId: string,
  origin: string,
  format: SourceFormat,
  opts: DocumentMetadataInput = {},
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

  // Convert (if needed) + sanitize so the cap check reflects what would
  // actually be stored. The sanitize step is the trust boundary for both
  // input formats; pulldown-cmark does not filter dangerous HTML on its
  // own (see sanitizer/src/lib.rs markdown_to_html docs).
  const prep = prepareForStorage(body, format);

  const capCheck = await checkStorageCap(env, prep.cleanedBytes.byteLength);
  if (!capCheck.ok) {
    return {
      ok: false,
      code: "storage_cap_exceeded",
      used: capCheck.used,
      cap: capCheck.cap,
      this_write: prep.cleanedBytes.byteLength,
    };
  }

  // No prior version on publish — resolveMetadata derives title from the
  // cleaned HTML and falls back to defaults for description/tags.
  const meta = resolveMetadata(prep.cleanedHtml, opts, null);

  // Slug uniqueness check happens BEFORE the R2 write so a slug collision
  // doesn't leave orphan bytes. publish has no prior, no self — so we pass
  // null for both. The `action` we get back is either noop(null), set(slug),
  // or clear (impossible on publish since prior is null but we accept it).
  const slugResult = await resolveSlug(env, opts.slug, null, null);
  if (!slugResult.ok) return slugResult;
  const slugForInsert = slugResult.action.kind === "set" ? slugResult.action.slug : null;

  const docId = newUuid();
  const publicId = newPublicId();
  const versionNo = 1;
  const r2Key = `${docId}/v${versionNo}`;

  // R2 first. If the D1 batch fails we attempt to delete the blob so we
  // don't accumulate orphans. R2 keys are unique per (docId, version), so a
  // retry harmlessly overwrites.
  await env.DOCS.put(r2Key, prep.cleanedBytes, {
    httpMetadata: { contentType: "text/html; charset=utf-8" },
    customMetadata: {
      document_id: docId,
      version: String(versionNo),
      sanitizer_v: prep.sanitizerV,
      agent_id: agentId,
      source_format: format,
    },
  });

  // Body text for FTS — htmlToMarkdown is the same conversion the read path
  // runs at request time (readDocumentTextCore). Doing it once here at write
  // time lets us index plain text without re-walking the HTML on every
  // search. Single-digit ms; shares the WASM module already loaded.
  const ftsBody = htmlToMarkdown(prep.cleanedHtml);

  try {
    await env.META.batch([
      env.META.prepare(
        "insert into documents (id, public_id, created_by, slug) values (?, ?, ?, ?)",
      ).bind(docId, publicId, agentId, slugForInsert),
      env.META.prepare(
        `insert into versions (document_id, version_no, r2_key, size_bytes, sanitizer_v, source_format, title, description, tags)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        docId,
        versionNo,
        r2Key,
        prep.cleanedBytes.byteLength,
        prep.sanitizerV,
        format,
        meta.title,
        meta.description,
        serializeTags(meta.tags),
      ),
      env.META.prepare("update documents set current_ver = ? where id = ?").bind(
        versionNo,
        docId,
      ),
      // Same batch as the document/version writes so the FTS index can't
      // diverge from the metadata it indexes. Tags are joined with spaces
      // because FTS5 tokenizes the column at index time — separator chars
      // (including underscore via unicode61's default rules) split tokens,
      // so a stored "foo bar" tokenizes the same way "foo" "bar" would.
      env.META.prepare(
        `insert into documents_fts (document_id, title, description, tags, body)
         values (?, ?, ?, ?, ?)`,
      ).bind(docId, meta.title, meta.description, meta.tags.join(" "), ftsBody),
    ]);
  } catch (err) {
    await env.DOCS.delete(r2Key).catch(() => {
      /* best effort; surfaced via logs if it matters */
    });
    throw err;
  }

  return {
    ok: true,
    public_id: publicId,
    url: `${origin}/d/${publicId}`,
    version: versionNo,
    size_bytes: prep.cleanedBytes.byteLength,
    sanitizer_v: prep.sanitizerV,
    modified: prep.modified,
    stripped: prep.stripped,
    will_not_render: prep.will_not_render,
    title: meta.title,
    description: meta.description,
    tags: meta.tags,
    slug: slugForInsert,
  };
}

/**
 * Append a new version to an existing document. `expectedVersion`:
 *   - number   → fail with `version_conflict` if the current version differs.
 *   - null     → clobber (skip the version check, last-write-wins).
 *
 * Cross-agent writes are intentional per the single-tenant trust model
 * documented in updateDocument's wrapper. The caller's `agentId` is
 * stamped onto the new version (R2 customMetadata only; `documents.created_by`
 * retains the original creator).
 */
export async function updateDocumentCore(
  env: Env,
  publicId: string,
  body: string,
  expectedVersion: number | null,
  agentId: string,
  origin: string,
  format: SourceFormat,
  opts: DocumentMetadataInput = {},
): Promise<WriteOk | UpdateErr> {
  if (!PUBLIC_ID_RE.test(publicId)) return { ok: false, code: "not_found" };
  if (body.length === 0) return { ok: false, code: "empty_body" };

  // Look up document + current version + revoked state + prior metadata in
  // one go. Prior metadata is what omitted fields inherit from on update —
  // pulling it here keeps the write path to a single round trip. `slug`
  // lives on `documents` (not `versions`) because it's identity-adjacent
  // and uniqueness is enforced per-doc; we pull it from `d` rather than `v`.
  const row = await env.META.prepare(
    `select d.id, d.current_ver, d.revoked_at, d.slug as prior_slug,
       v.title as prior_title,
       v.description as prior_description,
       v.tags as prior_tags
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
      prior_slug: string | null;
      prior_title: string | null;
      prior_description: string | null;
      prior_tags: string | null;
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

  const prep = prepareForStorage(body, format);

  const capCheck = await checkStorageCap(env, prep.cleanedBytes.byteLength);
  if (!capCheck.ok) {
    return {
      ok: false,
      code: "storage_cap_exceeded",
      used: capCheck.used,
      cap: capCheck.cap,
      this_write: prep.cleanedBytes.byteLength,
    };
  }

  // Resolve metadata with inheritance from the prior version. `undefined`
  // fields carry over; `""` / `[]` clear (and re-derive in the title case).
  const prior: ResolvedMetadata = {
    title: row.prior_title,
    description: row.prior_description,
    tags: parseStoredTags(row.prior_tags),
  };
  const meta = resolveMetadata(prep.cleanedHtml, opts, prior);

  // Resolve slug separately — it's per-document, not per-version, and its
  // claim path needs DB access (uniqueness check). BEFORE the R2 write so
  // a slug collision doesn't leave orphan bytes. The "noop" action keeps
  // the prior slug intact (the common case for content-only updates) and
  // avoids touching documents.slug.
  const slugResult = await resolveSlug(env, opts.slug, row.prior_slug, row.id);
  if (!slugResult.ok) return slugResult;
  const slugAction = slugResult.action;
  // What slug ends up on the response — same whether we changed it or not.
  const resolvedSlug =
    slugAction.kind === "set" ? slugAction.slug : slugAction.kind === "clear" ? null : slugAction.slug;

  const nextVer = row.current_ver + 1;
  const r2Key = `${row.id}/v${nextVer}`;

  await env.DOCS.put(r2Key, prep.cleanedBytes, {
    httpMetadata: { contentType: "text/html; charset=utf-8" },
    customMetadata: {
      document_id: row.id,
      version: String(nextVer),
      sanitizer_v: prep.sanitizerV,
      agent_id: agentId,
      source_format: format,
    },
  });

  // Same write-time markdown derivation as publishDocumentCore — feeds the
  // FTS body column so search results follow the doc's current version.
  const ftsBody = htmlToMarkdown(prep.cleanedHtml);

  try {
    // Build the batch dynamically — only include the slug UPDATE when the
    // agent actually changed something. Keeps the no-op path (the vast
    // majority of updates) free of an extra round-trip statement.
    const statements: D1PreparedStatement[] = [
      env.META.prepare(
        `insert into versions (document_id, version_no, r2_key, size_bytes, sanitizer_v, source_format, title, description, tags)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        row.id,
        nextVer,
        r2Key,
        prep.cleanedBytes.byteLength,
        prep.sanitizerV,
        format,
        meta.title,
        meta.description,
        serializeTags(meta.tags),
      ),
      env.META.prepare("update documents set current_ver = ? where id = ?").bind(nextVer, row.id),
      // Sync the FTS row in lockstep. DELETE-then-INSERT (rather than UPDATE)
      // covers two cases with one shape: the normal case where publish inserted
      // an FTS row we're refreshing, AND the legacy case where the document
      // pre-dates the search migration and has no FTS row yet. UPDATE would
      // silently zero-affect on a missing row; DELETE+INSERT is idempotent.
      // FTS5 has no ON CONFLICT / UPSERT, so two statements is the way.
      env.META.prepare("delete from documents_fts where document_id = ?").bind(row.id),
      env.META.prepare(
        `insert into documents_fts (document_id, title, description, tags, body)
         values (?, ?, ?, ?, ?)`,
      ).bind(row.id, meta.title, meta.description, meta.tags.join(" "), ftsBody),
    ];
    if (slugAction.kind === "set") {
      statements.push(
        env.META.prepare("update documents set slug = ? where id = ?").bind(slugAction.slug, row.id),
      );
    } else if (slugAction.kind === "clear") {
      statements.push(
        env.META.prepare("update documents set slug = null where id = ?").bind(row.id),
      );
    }
    await env.META.batch(statements);
  } catch (err) {
    await env.DOCS.delete(r2Key).catch(() => {
      /* best effort; D1 is the source of truth */
    });
    throw err;
  }

  return {
    ok: true,
    public_id: publicId,
    url: `${origin}/d/${publicId}`,
    version: nextVer,
    size_bytes: prep.cleanedBytes.byteLength,
    sanitizer_v: prep.sanitizerV,
    modified: prep.modified,
    stripped: prep.stripped,
    will_not_render: prep.will_not_render,
    title: meta.title,
    description: meta.description,
    tags: meta.tags,
    slug: resolvedSlug,
  };
}

/** Read the current version's bytes for the given public_id, buffered. */
export type ReadOk = {
  ok: true;
  bytes: Uint8Array;
  version_no: number;
  sanitizer_v: string;
  /** Resolved metadata for the current version. `null` for legacy rows. */
  title: string | null;
  description: string | null;
  tags: string[];
  /** Document slug if set, else null. Comes from documents.slug (per-doc). */
  slug: string | null;
};
export type ReadErr = { ok: false; code: "not_found" };

/**
 * Fetch the current version's sanitized HTML, buffered into memory.
 *
 * The browser path (`serveRaw` in src/serve.ts) streams R2 directly to
 * avoid buffering — different consumer, different needs. The MCP tool
 * needs the bytes in-process to return as text content, so we buffer here.
 *
 * Metadata (title/description/tags) is read alongside the R2 key in the
 * same query — same join cost, no extra round trip. Callers that only
 * want the bytes can ignore the metadata fields.
 */
export async function readDocumentCore(
  env: Env,
  publicId: string,
): Promise<ReadOk | ReadErr> {
  if (!PUBLIC_ID_RE.test(publicId)) return { ok: false, code: "not_found" };

  const row = await env.META.prepare(
    `select d.revoked_at, d.slug, v.r2_key, v.version_no, v.sanitizer_v,
       v.title, v.description, v.tags
     from documents d
     join versions v on v.document_id = d.id and v.version_no = d.current_ver
     where d.public_id = ?`,
  )
    .bind(publicId)
    .first<{
      revoked_at: string | null;
      slug: string | null;
      r2_key: string;
      version_no: number;
      sanitizer_v: string;
      title: string | null;
      description: string | null;
      tags: string | null;
    }>();
  if (!row || row.revoked_at) return { ok: false, code: "not_found" };

  const obj = await env.DOCS.get(row.r2_key);
  if (!obj) return { ok: false, code: "not_found" }; // D1 says it should exist; treat as gone.

  const buf = await obj.arrayBuffer();
  return {
    ok: true,
    bytes: new Uint8Array(buf),
    version_no: row.version_no,
    sanitizer_v: row.sanitizer_v,
    title: row.title,
    description: row.description,
    tags: parseStoredTags(row.tags),
    slug: row.slug,
  };
}

/** Markdown read result — derived on the fly from the sanitized HTML. */
export type ReadTextOk = {
  ok: true;
  text: string;
  version_no: number;
  sanitizer_v: string;
  converter_v: string;
  /** Resolved metadata from the current version, passed through from readDocumentCore. */
  title: string | null;
  description: string | null;
  tags: string[];
  slug: string | null;
};

/**
 * Fetch the current version's sanitized HTML and convert it to Markdown.
 *
 * The conversion runs at read time (no per-version cache in v1 — see
 * action-plan-v1.md follow-ups for the cost analysis). The input to
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
): Promise<ReadTextOk | ReadErr> {
  const html = await readDocumentCore(env, publicId);
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
  };
}

/** Listing row shape — same columns as GET /admin/documents today. */
export type DocumentListing = {
  public_id: string;
  current_ver: number | null;
  created_at: string;
  created_by_id: string | null;
  created_by_name: string | null;
  current_size: number | null;
  revoked_at: string | null;
  /** Per-version metadata from the current version; null on revoked / legacy rows. */
  title: string | null;
  description: string | null;
  tags: string[];
  /** Per-document slug from `documents.slug`. Null on revoked or unset. */
  slug: string | null;
};

/**
 * The columns we project for every listing-row read — shared between
 * listDocumentsCore (paginated, filtered) and findDocumentBySlugCore
 * (single-row lookup). Centralizing the SELECT keeps the surface in lockstep:
 * any new column added to DocumentListing flows to both paths in one edit.
 */
const LISTING_SELECT_COLUMNS = `d.id, d.public_id, d.current_ver, d.created_at, d.revoked_at, d.slug,
       a.name as created_by_name, d.created_by as created_by_id,
       v.size_bytes as current_size,
       v.title, v.description, v.tags`;
const LISTING_JOINS = `from documents d
     left join agents a on a.id = d.created_by
     left join versions v on v.document_id = d.id and v.version_no = d.current_ver`;

/**
 * Build the LIKE-pattern for an AND-style tag filter against the JSON-encoded
 * `versions.tags` column.
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
 * List documents (including revoked), newest first. Cursor-paginated — see
 * src/pagination.ts for the contract; callers omit `cursor` on the first
 * page and pass back `next_cursor` from the prior response to walk forward.
 *
 * Single-tenant trust model: any caller (operator or any agent) sees the
 * full fleet. If per-agent filtering becomes a need, add a `createdBy?`
 * arg here and an additional `WHERE created_by = ?` clause.
 *
 * The versions LEFT JOIN pulls title/description/tags/size from the
 * current version row in a single query — older code used a correlated
 * subselect for size; the JOIN form scales better as more per-version
 * fields get surfaced.
 *
 * Ordering is (created_at DESC, id DESC). The `id` tiebreaker matters when
 * two rows share `created_at` (D1's strftime stamps to ms; collisions are
 * rare but possible under bursty writes) — without it cursors could skip a
 * row at a page boundary.
 *
 * FILTERS:
 *   - `params.tags` — AND semantics. One `tags LIKE ? ESCAPE '\'` predicate
 *     per requested tag (see tagLikePattern for the encoding). Tags are
 *     pre-sanitized by `parseHttpListParams` / `parseMcpListArgs` to the
 *     stored shape so a `?tag=Foo!` query filters by `["Foo"]` — same
 *     silent-strip semantics as the write path.
 *   - `params.slug` — exact match against `documents.slug` (unique across
 *     live docs, so returns 0 or 1 rows when combined with no other filter).
 *
 * Filters compose with the cursor predicate: the WHERE clause is always
 * built as `<cursor>? AND <tags>? AND <slug>?`, so paginating through a
 * filtered list walks the filtered subset in the same (created_at, id)
 * order as the unfiltered list. Revoked docs are still included — slug
 * is cleared on revoke (see revokeDocumentCore), so a `slug=` filter
 * naturally only matches live docs anyway.
 */
export async function listDocumentsCore(
  env: Env,
  params: ListParams,
): Promise<{ documents: DocumentListing[]; next_cursor: string | null }> {
  // `d.id` is needed for the cursor tiebreaker but isn't part of the public
  // DocumentListing shape — we strip it in the projection below.
  type Row = Omit<DocumentListing, "tags"> & { id: string; tags: string | null };

  // Build the WHERE clause + bind list dynamically. Every predicate is
  // optional, so we accumulate clauses + bind args and join with AND at
  // the end. The cursor predicate, when present, comes first so its three
  // binds line up positionally with the existing `?, ?, ?` triple.
  const clauses: string[] = [];
  const binds: unknown[] = [];

  if (params.cursor) {
    clauses.push("(d.created_at < ? or (d.created_at = ? and d.id < ?))");
    binds.push(params.cursor.ts, params.cursor.ts, params.cursor.id);
  }
  for (const tag of params.tags) {
    // One LIKE per tag = AND semantics. SQLite plans this as a sequential
    // scan over the `documents` set joined to `versions` — fine for v1's
    // scale; a tag index would mean restructuring storage (json_each + a
    // separate `version_tags` table, say). Deferred.
    clauses.push("v.tags like ? escape '\\'");
    binds.push(tagLikePattern(tag));
  }
  if (params.slug !== null) {
    // Slug uses the partial UNIQUE INDEX on documents(slug) WHERE slug IS NOT NULL.
    // Equality match — the planner uses the index for a single row hit.
    clauses.push("d.slug = ?");
    binds.push(params.slug);
  }
  const whereSql = clauses.length > 0 ? `where ${clauses.join(" and ")}` : "";

  // Peek one past the limit so we know whether next_cursor should be set.
  const peek = params.limit + 1;
  binds.push(peek);

  const sql = `select ${LISTING_SELECT_COLUMNS}
     ${LISTING_JOINS}
     ${whereSql}
     order by d.created_at desc, d.id desc
     limit ?`;
  const result = await env.META.prepare(sql).bind(...binds).all<Row>();
  const { items, next_cursor } = paginate(
    result.results ?? [],
    params.limit,
    ({ id: _id, tags, ...rest }): DocumentListing => ({ ...rest, tags: parseStoredTags(tags) }),
    (row) => ({ ts: row.created_at, id: row.id }),
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
 * NULL on revoke, so a slugged document that's been revoked has no slug at
 * all and naturally won't match. The `revoked_at IS NULL` clause is belt-and-
 * suspenders: if a future migration ever decoupled slug-release from revoke,
 * we still don't want this lookup surfacing tombstones.
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
 * Hit row from searchDocumentsCore — the same DocumentListing shape every
 * list surface returns, plus three search-specific fields:
 *
 *   - `score`: positive float, bigger = better match. The raw FTS5 bm25()
 *     function returns NEGATIVE values (lower = better, so ORDER BY rank
 *     puts the best first); we negate before surfacing so callers can use
 *     the natural "higher is better" reading.
 *   - `matched_field`: which column the agent should treat as the
 *     "reason" for this hit. Useful for an agent deciding whether the hit
 *     is metadata-substantive (title/description/tags) vs only a body
 *     mention. **Per-column attribution rather than strength.** D1's
 *     FTS5 bm25() does not produce reliable per-column subscores via the
 *     weights-isolation trick (passing `(1,0,0,0)` gives the same value
 *     as `(0,0,0,1)` for the same row — verified locally), so we instead
 *     detect which columns matched via their per-column `snippet()` output
 *     (the matched-token bracketing is unambiguous) and pick a winner by
 *     priority: title > description > tags > body. The priority mirrors
 *     BM25 weights and reflects "metadata hits are stronger relevance
 *     signals than body mentions."
 *   - `snippet`: a short excerpt of the matched column with `[bracketed]`
 *     match tokens, drawn from whichever column won the matched_field
 *     priority. For a body match this is the FTS5 snippet builtin's
 *     output; for a title match it's the title with the matched term
 *     bracketed.
 */
export type SearchHit = DocumentListing & {
  score: number;
  matched_field: "title" | "description" | "tags" | "body";
  snippet: string;
};

/** Tunable BM25 column weights. Title >> description ≈ tags >> body. */
const BM25_WEIGHTS = { title: 20.0, description: 5.0, tags: 5.0, body: 1.0 };

/**
 * Full-text search over live documents. Backed by the documents_fts FTS5
 * virtual table; see migrations/0006_documents_search.sql.
 *
 * The `match` argument is a SANITIZED FTS5 MATCH expression — the caller
 * is responsible for running it through `buildFtsMatchQuery` in
 * src/search.ts first. We accept the sanitized form here (not the raw
 * query) so this function stays focused on SQL and the tokenization rule
 * is encoded in one place.
 *
 * Pagination is deliberately limited: BM25 score isn't a stable cursor
 * key the way (created_at, id) is — a concurrent write can reorder the
 * tail of a result set in non-monotonic ways. v1 caps results at `limit`
 * (MAX_LIMIT = 200), returns no `next_cursor`, and trusts that an agent
 * not seeing what they want in the top 200 should refine the query
 * rather than paginate further. The `cursor` field on `ListParams` is
 * ignored here.
 *
 * Tag and slug filters (from `ParsedListParams`) compose with the MATCH —
 * "search for X within tag Y" is one call. Revoked docs are excluded via
 * the JOIN's `d.revoked_at is null` predicate AND via the DELETE that
 * runs in revokeDocumentCore's batch — belt and suspenders, in case a
 * future migration ever decoupled FTS DELETE from revoke.
 *
 * `matched_field` is determined by running four single-column bm25()
 * calls (each weighted only on the column of interest) and picking the
 * smallest (most negative) — i.e. the column that contributed most to
 * the overall match. Three extra bm25 evaluations per hit; FTS5 caches
 * the per-document match state across them, so the cost is small.
 */
export type SearchErr = { ok: false; code: "bad_query" };
export async function searchDocumentsCore(
  env: Env,
  match: string,
  params: ListParams,
): Promise<{ ok: true; documents: SearchHit[] } | SearchErr> {
  if (match.length === 0) return { ok: false, code: "bad_query" };

  // Per-row shape with the overall BM25 score and four per-column snippet
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
    tags_snippet: string | null;
    body_snippet: string | null;
  };

  const clauses: string[] = ["documents_fts match ?", "d.revoked_at is null"];
  const binds: unknown[] = [match];

  for (const tag of params.tags) {
    clauses.push("v.tags like ? escape '\\'");
    binds.push(tagLikePattern(tag));
  }
  if (params.slug !== null) {
    clauses.push("d.slug = ?");
    binds.push(params.slug);
  }

  // Snippet builtin: 5-arg form is (table, column_idx, start, end, ellipsis,
  // token_count). Columns are 0-indexed from the CREATE order: document_id=0,
  // title=1, description=2, tags=3, body=4. We render body and description
  // snippets up-front and pick which to surface based on matched_field below
  // — cheaper than running snippet() in JS post-fetch since FTS5 already has
  // the match state per row.
  // Snippet builtin: 6-arg form is (table, column_idx, start, end, ellipsis,
  // token_count). Columns are 0-indexed from the CREATE order: document_id=0,
  // title=1, description=2, tags=3, body=4. One snippet() per indexed column
  // gives us both the bracketed match context AND the per-column "did this
  // match" signal — a column whose snippet contains '[' had a hit. Cheaper
  // than the four per-column bm25 calls we originally tried (which D1's FTS5
  // doesn't isolate correctly anyway). FTS5 caches the match state across
  // these four snippet() calls per row.
  const sql = `select ${LISTING_SELECT_COLUMNS},
       -bm25(documents_fts, ${BM25_WEIGHTS.title}, ${BM25_WEIGHTS.description}, ${BM25_WEIGHTS.tags}, ${BM25_WEIGHTS.body}) as score,
       snippet(documents_fts, 1, '[', ']', '…', 16) as title_snippet,
       snippet(documents_fts, 2, '[', ']', '…', 16) as description_snippet,
       snippet(documents_fts, 3, '[', ']', '…', 16) as tags_snippet,
       snippet(documents_fts, 4, '[', ']', '…', 16) as body_snippet
     ${LISTING_JOINS}
     join documents_fts on documents_fts.document_id = d.id
     where ${clauses.join(" and ")}
     order by score desc
     limit ?`;
  binds.push(params.limit);

  const result = await env.META.prepare(sql).bind(...binds).all<Row>();
  const documents: SearchHit[] = (result.results ?? []).map((row) => {
    // Detect which columns matched by looking for FTS5's bracket delimiters
    // in each per-column snippet. The snippet builtin only wraps matched
    // tokens with the start/end strings we passed — a column with no match
    // gets its value back verbatim, no brackets. This is unambiguous and
    // works around D1's FTS5 not honoring weight-isolation for per-column
    // bm25 attribution (see the SearchHit doc comment).
    //
    // Priority on multi-column matches: title > description > tags > body.
    // Mirrors the BM25 weight ordering — a hit in curated metadata is a
    // stronger relevance signal than a body mention. Deterministic, so
    // identical queries on identical content always pick the same field.
    const matched = {
      title: (row.title_snippet ?? "").includes("["),
      description: (row.description_snippet ?? "").includes("["),
      tags: (row.tags_snippet ?? "").includes("["),
      body: (row.body_snippet ?? "").includes("["),
    };
    const matched_field: SearchHit["matched_field"] = matched.title
      ? "title"
      : matched.description
        ? "description"
        : matched.tags
          ? "tags"
          : "body"; // every row has at least one match (it's a search hit);
                    // if no column lit up via the bracket signal something
                    // upstream broke and we default to body, which is the
                    // most informative snippet to surface anyway.

    // Snippet to surface: just the matched column's bracketed output.
    // All four columns get snippet()'d so we can pick any one without an
    // extra round trip.
    const snippetByField = {
      title: row.title_snippet ?? "",
      description: row.description_snippet ?? "",
      tags: row.tags_snippet ?? "",
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
      tags_snippet: _tgsn,
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
  return { ok: true, documents };
}

export type RevokeOk = { ok: true; public_id: string; r2_objects_purged: number };
export type RevokeErr = { ok: false; code: "not_found" };

/**
 * Operator kill switch for a single document. Marks `revoked_at` first so
 * the doc is unreachable instantly, then purges every version's R2 object.
 * Keeps `versions` rows as an audit trail; bytes are the irrecoverable part.
 *
 * Also CLEARS the slug (sets documents.slug = NULL) as part of the same
 * UPDATE — this is the "released on revocation" contract from migration
 * 0005. The partial unique index over slug WHERE slug IS NOT NULL excludes
 * NULL, so clearing makes the slug immediately available to a future publish.
 * The `public_id` survives on the row as an audit/lookup key, but the slug
 * is treated like the R2 bytes: gone instantly on revoke.
 */
export async function revokeDocumentCore(
  env: Env,
  publicId: string,
): Promise<RevokeOk | RevokeErr> {
  if (!PUBLIC_ID_RE.test(publicId)) return { ok: false, code: "not_found" };

  const row = await env.META.prepare(
    "select id, revoked_at from documents where public_id = ?",
  )
    .bind(publicId)
    .first<{ id: string; revoked_at: string | null }>();
  if (!row || row.revoked_at) return { ok: false, code: "not_found" };

  const versions = await env.META.prepare(
    "select r2_key from versions where document_id = ? order by version_no",
  )
    .bind(row.id)
    .all<{ r2_key: string }>();
  const r2Keys = (versions.results ?? []).map((v) => v.r2_key);

  // Mark revoked + release the slug + drop the FTS row BEFORE purging R2 so
  // the doc is unreachable instantly (including via search) and the slug is
  // available for reuse, even if the bucket call hangs or fails. Batched so
  // both writes succeed together — a half-completed revoke that left the
  // FTS row alive would surface a tombstone in search results until the
  // next reindex.
  await env.META.batch([
    env.META.prepare(
      `update documents
       set revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           current_ver = null,
           slug = null
       where id = ?`,
    ).bind(row.id),
    env.META.prepare("delete from documents_fts where document_id = ?").bind(row.id),
  ]);

  if (r2Keys.length > 0) {
    await env.DOCS.delete(r2Keys);
  }

  return { ok: true, public_id: publicId, r2_objects_purged: r2Keys.length };
}
