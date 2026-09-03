// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/**
 * Link-graph READ cores (migration 0016, issue #40) — a PURE MOVE out of
 * core.ts (GitHub issue #53, zero logic edits): `documentLinksCore` (the
 * per-document backlinks/outbound neighborhood), `listOrphanDocumentsCore`
 * (curation worklist), and `backfillLinksCore` (the R2-reading rebuild sweep).
 *
 * The WRITE-time trio — `documentLinkStatements` / `extractDocumentLinks` /
 * `linkSyncStatements` — deliberately STAYS in core.ts, spliced into the same
 * `META.batch()` as the version/FTS writes (link-graph sync convention
 * bullet); this module imports `extractDocumentLinks`/`linkSyncStatements`
 * from there for the backfill sweep's re-extraction, which is the 0016
 * read/write seam this split is cut along.
 *
 * Edge is strictly ONE-WAY: this module imports core.ts (the listing
 * projection constants, `parseStoredTags`, the write-time link helpers);
 * core.ts imports nothing from here.
 */

import type { Env } from "./env.js";
import { PUBLIC_ID_RE } from "./ids.js";
import { type ListParams, paginate } from "./pagination.js";
import {
  type DocumentLinksOk,
  type DocumentListing,
  extractDocumentLinks,
  LISTING_JOINS,
  LISTING_SELECT_COLUMNS,
  linkSyncStatements,
  type OutboundLink,
  parseStoredTags,
} from "./core.js";

// -- link-graph reads (migration 0016, GitHub issue #40) -----------------------

/** Chunk size for the IN-list resolution selects below — comfortably under
 * D1's bound-parameter cap even with a couple of fixed binds alongside. */
const LINK_RESOLVE_CHUNK = 80;

export type DocumentLinksErr = { ok: false; code: "not_found" };

/**
 * A live document's link-graph neighborhood — both directions, resolved at
 * read time (the late-binding half of the migration-0016 design):
 *
 *   - `backlinks` — live documents whose CURRENT version links here, by this
 *     doc's public_id or its current live slug. Full DocumentListing rows
 *     (same projection as list/search — LISTING_SELECT_COLUMNS), newest first,
 *     capped at 200 like every list surface. Self-rows are excluded twice
 *     (write-time filter + the `d.id != ?` guard here). NOTE the slug match is
 *     against the doc's CURRENT name only: a link authored against a
 *     since-renamed slug resolves through the tombstone REDIRECT on the
 *     serving path, but is deliberately NOT counted as a backlink — same
 *     loud-never-auto-followed posture as every other redirect surface; it
 *     surfaces on the SOURCE doc's outbound list as `redirected` instead.
 *
 *   - `outbound` — this doc's stored link rows in authored order, each with
 *     the state its raw target resolves to right now: `live` (with the
 *     target's public_id + title), `redirected` (retired slug that forwards —
 *     target_public_id is the forward target), `retired` (410 tombstone),
 *     `revoked` (a /d/ link whose doc was killed), or `missing` (unclaimed
 *     slug / unknown public_id). `retired`/`revoked`/`missing` are the
 *     broken-link signals.
 *
 * Revoked/missing/malformed doc → opaque `not_found`, like every read core.
 * Visibility does NOT gate this (it's a credentialed surface — the HTTP
 * handler runs requireReader, MCP is agent-scoped); a private doc's backlinks
 * are as readable to a credentialed caller as the doc itself.
 */
export async function documentLinksCore(
  env: Env,
  publicId: string,
): Promise<DocumentLinksOk | DocumentLinksErr> {
  if (!PUBLIC_ID_RE.test(publicId)) return { ok: false, code: "not_found" };
  const doc = await env.META.prepare(
    "select id, slug from documents where public_id = ? and revoked_at is null",
  )
    .bind(publicId)
    .first<{ id: string; slug: string | null }>();
  if (!doc) return { ok: false, code: "not_found" };

  // --- backlinks: who (live) links here, by public_id or current live slug.
  type Row = Omit<DocumentListing, "tags"> & { id: string; tags: string | null };
  const targetClauses = ["(l.target_kind = 'public_id' and l.target_value = ?)"];
  const targetBinds: unknown[] = [publicId];
  if (doc.slug !== null) {
    targetClauses.push("(l.target_kind = 'slug' and l.target_value = ?)");
    targetBinds.push(doc.slug);
  }
  // DISTINCT: a source that links both /d/<id> and /s/<slug> matches twice but
  // is one backlink. LISTING_SELECT_COLUMNS includes d.id, so the projection
  // is per-document unique and DISTINCT collapses exactly those doubles.
  const backRows = await env.META.prepare(
    `select distinct ${LISTING_SELECT_COLUMNS}
     ${LISTING_JOINS}
     join document_links l on l.src_doc_id = d.id
     where (${targetClauses.join(" or ")}) and d.revoked_at is null and d.id != ?
     order by d.created_at desc, d.id desc
     limit 200`,
  )
    .bind(...targetBinds, doc.id)
    .all<Row>();
  const backlinks: DocumentListing[] = (backRows.results ?? []).map(
    ({ id: _id, tags, ...rest }) => ({ ...rest, tags: parseStoredTags(tags) }),
  );

  // --- outbound: this doc's rows, resolved in three batched lookups.
  const linkRows = await env.META.prepare(
    "select target_kind, target_value from document_links where src_doc_id = ? order by position",
  )
    .bind(doc.id)
    .all<{ target_kind: "public_id" | "slug"; target_value: string }>();
  const stored = linkRows.results ?? [];

  const slugTargets = stored.filter((l) => l.target_kind === "slug").map((l) => l.target_value);
  const pidTargets = stored
    .filter((l) => l.target_kind === "public_id")
    .map((l) => l.target_value);

  // Live docs by slug (slug only exists on live rows, but belt-and-suspenders).
  const liveBySlug = new Map<string, { public_id: string; title: string | null }>();
  for (let i = 0; i < slugTargets.length; i += LINK_RESOLVE_CHUNK) {
    const chunk = slugTargets.slice(i, i + LINK_RESOLVE_CHUNK);
    const qs = chunk.map(() => "?").join(", ");
    const rows = await env.META.prepare(
      `select d.slug, d.public_id, v.title
       from documents d
       left join versions v on v.document_id = d.id and v.version_no = d.current_ver
       where d.revoked_at is null and d.slug in (${qs})`,
    )
      .bind(...chunk)
      .all<{ slug: string; public_id: string; title: string | null }>();
    for (const r of rows.results ?? []) liveBySlug.set(r.slug, r);
  }

  // Tombstones for the slugs that didn't resolve live (retired vs missing,
  // and the loud redirect pointer).
  const deadSlugs = slugTargets.filter((s) => !liveBySlug.has(s));
  const tombstoneBySlug = new Map<string, string | null>(); // slug → redirect_to
  for (let i = 0; i < deadSlugs.length; i += LINK_RESOLVE_CHUNK) {
    const chunk = deadSlugs.slice(i, i + LINK_RESOLVE_CHUNK);
    const qs = chunk.map(() => "?").join(", ");
    const rows = await env.META.prepare(
      `select slug, redirect_to from slug_tombstones where slug in (${qs})`,
    )
      .bind(...chunk)
      .all<{ slug: string; redirect_to: string | null }>();
    for (const r of rows.results ?? []) tombstoneBySlug.set(r.slug, r.redirect_to);
  }

  // Documents by public_id (live AND revoked — "revoked" is its own state).
  const byPid = new Map<string, { revoked: boolean; title: string | null }>();
  for (let i = 0; i < pidTargets.length; i += LINK_RESOLVE_CHUNK) {
    const chunk = pidTargets.slice(i, i + LINK_RESOLVE_CHUNK);
    const qs = chunk.map(() => "?").join(", ");
    const rows = await env.META.prepare(
      `select d.public_id, d.revoked_at, v.title
       from documents d
       left join versions v on v.document_id = d.id and v.version_no = d.current_ver
       where d.public_id in (${qs})`,
    )
      .bind(...chunk)
      .all<{ public_id: string; revoked_at: string | null; title: string | null }>();
    for (const r of rows.results ?? []) {
      byPid.set(r.public_id, { revoked: r.revoked_at !== null, title: r.title });
    }
  }

  const outbound: OutboundLink[] = stored.map((l) => {
    if (l.target_kind === "slug") {
      const live = liveBySlug.get(l.target_value);
      if (live) {
        return {
          kind: "slug",
          value: l.target_value,
          state: "live",
          target_public_id: live.public_id,
          title: live.title,
        };
      }
      if (tombstoneBySlug.has(l.target_value)) {
        const redirectTo = tombstoneBySlug.get(l.target_value) ?? null;
        return {
          kind: "slug",
          value: l.target_value,
          state: redirectTo !== null ? "redirected" : "retired",
          target_public_id: redirectTo,
          title: null,
        };
      }
      return { kind: "slug", value: l.target_value, state: "missing", target_public_id: null, title: null };
    }
    const hit = byPid.get(l.target_value);
    if (!hit) {
      return { kind: "public_id", value: l.target_value, state: "missing", target_public_id: null, title: null };
    }
    if (hit.revoked) {
      return { kind: "public_id", value: l.target_value, state: "revoked", target_public_id: null, title: null };
    }
    return {
      kind: "public_id",
      value: l.target_value,
      state: "live",
      target_public_id: l.target_value,
      title: hit.title,
    };
  });

  return { ok: true, public_id: publicId, backlinks, outbound };
}

/**
 * Orphan detection (issue #40): live documents NO live document links to —
 * neither by their public_id nor by their current slug. Self-links don't count
 * (write-time filter + the `s.id != d.id` guard). Newest first, capped at 200
 * (deliberately no cursor: this is a curation worklist, not a browse surface —
 * past 200 orphans the answer is "link or prune," not "next page").
 *
 * "Orphan" is a curation signal, not a health one — a deliberately standalone
 * doc (a homepage, a one-off share) is a fine orphan. The operator decides.
 */
export async function listOrphanDocumentsCore(
  env: Env,
): Promise<{ documents: DocumentListing[] }> {
  type Row = Omit<DocumentListing, "tags"> & { id: string; tags: string | null };
  const rows = await env.META.prepare(
    `select ${LISTING_SELECT_COLUMNS}
     ${LISTING_JOINS}
     where d.revoked_at is null
       and not exists (
         select 1 from document_links l
         join documents s on s.id = l.src_doc_id
         where s.revoked_at is null
           and s.id != d.id
           and ((l.target_kind = 'public_id' and l.target_value = d.public_id)
             or (l.target_kind = 'slug' and l.target_value = d.slug))
       )
     order by d.created_at desc, d.id desc
     limit 200`,
  ).all<Row>();
  const documents: DocumentListing[] = (rows.results ?? []).map(({ id: _id, tags, ...rest }) => ({
    ...rest,
    tags: parseStoredTags(tags),
  }));
  return { documents };
}

export type LinksBackfillOk = {
  ok: true;
  /** Live docs examined on this page. */
  scanned: number;
  /** Docs whose link rows were rewritten (every doc with a fetchable H). */
  updated: number;
  /** Total link rows stored across this page. */
  links: number;
  /** Opaque resume cursor, or null when this was the last page. */
  next_cursor: string | null;
};

/**
 * Link-graph backfill (migration 0016 / issue #40): re-extract `document_links`
 * rows from each live doc's STORED render H. The write path keeps the graph
 * current from here on; this sweep exists because much of the corpus is
 * write-once and would otherwise never get rows (the same gap the vectors
 * `missing` backfill exists for — but unlike vectors, link extraction needs the
 * H bytes, so this DOES read R2, one GET per doc per page).
 *
 * Always rebuild-semantics (delete-then-insert per doc) — extraction is cheap
 * and deterministic, so there's no "missing" mode to bother with; re-running is
 * idempotent. Operator-invoked via POST /admin/links/backfill, resumable via
 * the returned cursor. A doc whose H can't be fetched is counted in `scanned`
 * but not `updated` (its existing rows, if any, are left untouched) — re-run to
 * retry. `origin` scopes which absolute hrefs count as on-platform, same as the
 * write path.
 */
export async function backfillLinksCore(
  env: Env,
  params: ListParams,
  origin: string,
): Promise<LinksBackfillOk> {
  type Row = {
    id: string;
    public_id: string;
    slug: string | null;
    created_at: string;
    r2_key: string | null;
  };
  const clauses: string[] = ["d.revoked_at is null"];
  const binds: unknown[] = [];
  if (params.cursor) {
    clauses.push("(d.created_at < ? or (d.created_at = ? and d.id < ?))");
    binds.push(params.cursor.ts, params.cursor.ts, params.cursor.id);
  }
  const peek = params.limit + 1;
  binds.push(peek);

  const sql = `select d.id, d.public_id, d.slug, d.created_at, v.r2_key
     from documents d
     left join versions v on v.document_id = d.id and v.version_no = d.current_ver
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

  let updated = 0;
  let links = 0;
  for (const row of items) {
    if (row.r2_key === null) continue; // live doc with no current version: nothing to extract
    const obj = await env.DOCS.get(row.r2_key);
    if (obj === null) continue; // H missing — loud elsewhere; skip, re-run retries
    const html = await obj.text();
    const extracted = extractDocumentLinks(html, origin, {
      publicId: row.public_id,
      slug: row.slug,
    });
    await env.META.batch(linkSyncStatements(env, row.id, extracted));
    updated++;
    links += extracted.length;
  }
  return { ok: true, scanned: items.length, updated, links, next_cursor };
}
