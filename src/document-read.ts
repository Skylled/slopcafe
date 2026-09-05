// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/**
 * The document READ cores: sanitized-H read, the read-time HTML→Markdown text
 * read, the retained-SOURCE read, and the version-history manifest.
 *
 * Key invariants:
 *   - The text channel is derived from sanitized H at READ time (no per-version
 *     markdown cache), so it can never surface what the sanitizer stripped.
 *   - `readDocumentSourceCore` returns UNSANITIZED S and re-runs the advisory
 *     pass over it (`computeAdvisories` — the one definition the write path's
 *     `prepareForStorage` shares); `source_r2_key IS NULL` hard-fails
 *     `source_unavailable`, never a fall-back-to-H legacy branch.
 *   - Every read here is on `current_ver` (or an explicit version), never the
 *     served version — the served-version rule is the HTML byte path's only.
 *   - Gating-agnostic: callers apply the principal gate.
 *
 * `computeAdvisories` lives here (not in document-write) so document-write →
 * document-read is the only edge between the two; a reverse edge would be a
 * runtime cycle.
 */

import { detectAdvisories } from "./advisories.js";
import { parseStoredTags } from "./document-listing.js";
import type { Env } from "./env.js";
import { PUBLIC_ID_RE } from "./ids.js";
import {
  converterVersion,
  htmlToMarkdown,
  markdownToHtml,
  sanitize,
} from "./sanitizer.js";
import type {
  DocumentStatus,
  ListVersionsOk,
  ReadOk,
  ReadSourceOk,
  ReadTextOk,
  SourceFormat,
  VersionListing,
} from "./contract.js";

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
export function computeAdvisories(body: string, format: SourceFormat): {
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
  // the document listing). author_client_id (migration 0019 / issue #63) is the
  // OAuth client that minted the writing grant — no join: it is deliberately
  // NOT an FK to oauth_clients, since deleting a client must not erase which
  // client wrote a historical version (see the migration).
  const rows = await env.META.prepare(
    `select v.version_no, v.created_at, v.size_bytes, v.source_size_bytes, v.sanitizer_v,
       v.source_format, v.title, v.source_r2_key, v.source_sha256, v.author_kind,
       v.author_agent_id, v.author_client_id, a.name as author_name
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
      author_client_id: string | null;
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
    // NULL for a Door B (`awh_` bearer) write, an operator write, and every
    // pre-0019 version — three honest readings the sibling columns separate.
    author_client_id: r.author_client_id,
  }));

  return { ok: true, public_id: publicId, current_ver: doc.current_ver, versions };
}
