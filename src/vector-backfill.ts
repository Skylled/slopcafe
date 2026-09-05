// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/**
 * Vectorize backfill / reconciliation (docs/design/vector-search-design.md §8)
 * — the operator's durability net for the best-effort write-time vector sync.
 *
 * Key invariants: idempotent (upsert-by-id + the fixed-range delete inside
 * `syncDocumentVector`), resumable via the list cursor, reads the FTS body
 * rather than R2, and a zero-chunk doc is SKIPPED in `missing` mode rather
 * than retried forever.
 */

import type { Env } from "./env.js";
import { type ListParams, paginate } from "./pagination.js";
import { chunkEmbedInputs } from "./vector.js";
import { presentDocIds, syncDocumentVector } from "./vector-io.js";

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
