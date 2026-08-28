// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/**
 * Corpus aggregates for the Insight fork's "corpus stats" surface (sketch #6):
 * document totals and per-`app_package` / per-`doc_kind` breakdowns over the
 * live corpus. Backs the authenticated `GET /stats` JSON route (src/admin.ts →
 * src/index.ts) and, indirectly, the operator console's browse-by-app view.
 *
 * DELIBERATELY SANITIZER-FREE. Unlike listDocumentsCore/searchDocumentsCore this
 * is pure D1 aggregation — no R2, no sanitizer, no metadata validation — so it
 * lives in its own module rather than core.ts. That keeps it importable under
 * the strip-types test runner (core.ts pulls in the WASM sanitizer and cannot
 * be), which is what lets test/insight.test.mjs exercise the real aggregation
 * against an in-memory D1 shim instead of a copy.
 *
 * LIVE CORPUS, NOT TOMBSTONES. Every aggregate here excludes revoked rows
 * (`revoked_at IS NULL`), and so does `totals.documents`. A revoked document has
 * had its bytes purged (the kill switch) and is not something a "how big is the
 * corpus / which apps do we cover" view should count — stats describe what is
 * live and servable, not what once existed. (This is the same revoked-exclusion
 * posture the `publication` filter takes; the plain list surface, by contrast,
 * still SHOWS revoked rows so an operator can audit them.)
 *
 * AUTH/VISIBILITY. The route in front of this is `requireReader`-gated (operator
 * OR reader OR agent, never anonymous), i.e. the single-tenant whole-fleet trust
 * model — every authenticated principal already reads and lists every document
 * regardless of visibility. So the aggregates count PUBLIC and PRIVATE docs
 * alike, with no visibility predicate, exactly as listDocumentsCore returns the
 * full fleet to the same callers. There is deliberately NO anonymous entry point
 * to this function: an unauthenticated aggregate that counted private documents
 * would leak their existence/volume (an existence oracle the visibility model
 * exists to prevent). If this ever grows an anonymous door it MUST add
 * `visibility = 'public'` first — see the route handler's guard test.
 */

import type { Env } from "./env.js";
import { DOC_KIND_VALUES, type DocKind } from "./metadata.js";

/**
 * Cap on the `by_app_package` breakdown: the top-N packages by document count.
 * A teardown corpus has O(hundreds) of distinct packages, so 500 comfortably
 * covers the real fleet while bounding the response — but if the corpus ever
 * exceeds it the response says so (`by_app_package_truncated: true`) rather than
 * silently dropping the tail. Ordered by count DESC (ties broken by package name
 * ASC for a stable page).
 */
export const STATS_TOP_APP_PACKAGES = 500;

/** One row of the per-app-package breakdown. */
export type AppPackageStat = { app_package: string; count: number };
/** One row of the per-doc-kind breakdown — every DOC_KIND_VALUES member appears. */
export type DocKindStat = { doc_kind: DocKind; count: number };

/** The `GET /stats` response shape (also the MCP-free source for its OpenAPI schema). */
export type CorpusStats = {
  totals: { documents: number };
  by_app_package: AppPackageStat[];
  /**
   * True when the live corpus holds MORE than `STATS_TOP_APP_PACKAGES` distinct
   * app_packages and `by_app_package` was capped to the top N. The cap value is
   * `STATS_TOP_APP_PACKAGES`; documented in docs/http-api.md so a consumer knows
   * the list is a top-N, never the whole set, when this is set.
   */
  by_app_package_truncated: boolean;
  by_doc_kind: DocKindStat[];
};

/**
 * Compute the corpus aggregates over LIVE (non-revoked) documents. Three cheap
 * GROUP BY / COUNT reads against `documents`, each using the migration-0019
 * indexes on `app_package` / `doc_kind`.
 *
 *   - `totals.documents`  — live row count.
 *   - `by_app_package`    — count per non-null app_package, count DESC, capped
 *                           to the top `STATS_TOP_APP_PACKAGES` (peek one past
 *                           the cap to set `by_app_package_truncated` honestly).
 *                           NULL app_package rows are excluded — they are not
 *                           "an app" to browse by (moot on today's fully
 *                           backfilled corpus, correct if a non-Insight doc ever
 *                           lands here).
 *   - `by_doc_kind`       — count per doc_kind, projected over the FULL
 *                           DOC_KIND_VALUES enum so every kind appears (0 when
 *                           absent), in the canonical enum order.
 */
export async function corpusStatsCore(env: Env): Promise<CorpusStats> {
  // Totals — live documents only.
  const totalsRow = await env.META.prepare(
    "select count(*) as n from documents where revoked_at is null",
  ).first<{ n: number }>();
  const documents = totalsRow?.n ?? 0;

  // Per-app_package, count DESC. Peek one past the cap so we can report
  // truncation without a second COUNT(DISTINCT) query. Ties broken by package
  // name ASC for a deterministic page. NULL app_package excluded (see above).
  const appRows = await env.META.prepare(
    `select app_package, count(*) as count
       from documents
       where revoked_at is null and app_package is not null
       group by app_package
       order by count desc, app_package asc
       limit ?`,
  )
    .bind(STATS_TOP_APP_PACKAGES + 1)
    .all<{ app_package: string; count: number }>();
  const appResults = appRows.results ?? [];
  const by_app_package_truncated = appResults.length > STATS_TOP_APP_PACKAGES;
  const by_app_package: AppPackageStat[] = (
    by_app_package_truncated ? appResults.slice(0, STATS_TOP_APP_PACKAGES) : appResults
  ).map((r) => ({ app_package: r.app_package, count: r.count }));

  // Per-doc_kind, projected over the full enum so a consumer sees every kind
  // (a 0 for an unused kind is a signal, not a gap). Low cardinality — no cap.
  const kindRows = await env.META.prepare(
    `select doc_kind, count(*) as count
       from documents
       where revoked_at is null and doc_kind is not null
       group by doc_kind`,
  ).all<{ doc_kind: string; count: number }>();
  const kindCounts = new Map<string, number>();
  for (const r of kindRows.results ?? []) kindCounts.set(r.doc_kind, r.count);
  const by_doc_kind: DocKindStat[] = DOC_KIND_VALUES.map((doc_kind) => ({
    doc_kind,
    count: kindCounts.get(doc_kind) ?? 0,
  }));

  return { totals: { documents }, by_app_package, by_app_package_truncated, by_doc_kind };
}
