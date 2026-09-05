// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/**
 * Operator-only corpus maintenance + observability endpoints (issue #72 phase
 * 4: moved verbatim out of the former src/admin.ts). All await the shared
 * `requireOperator` (src/session.ts) before any read.
 *
 *   POST   /admin/docs/seed                    seed the bundled platform docs NOW (issue #4)
 *   GET    /admin/audit                        the append-only audit ledger (0020 / issue #62)
 *   POST   /admin/vectors/backfill             Vectorize backfill / reconciliation (manual, resumable)
 *   POST   /admin/links/backfill               backfill the link graph from stored renders (issue #40)
 *   GET    /admin/links/orphans                live docs nothing links to (link-graph curation view)
 *
 * The audit ledger has NO agent-door twin and none may be added; the backfills
 * are idempotent, resumable sweeps over the write-once corpus.
 */

import { jsonError } from "./admin-response.js";
import { listAuditEventsCore } from "./audit.js";
import type { Env } from "./env.js";
import { backfillLinksCore, listOrphanDocumentsCore } from "./links-core.js";
import { parseAuditListParams, parseHttpListParams } from "./pagination.js";
import { seedPlatformDocsCore } from "./seed-docs.js";
import { requireOperator } from "./session.js";
import { type BackfillMode, backfillVectorsCore } from "./vector-backfill.js";

/**
 * POST /admin/docs/seed — operator-invoked platform-documentation seeding
 * (GitHub issue #4).
 *
 * The seed pass also runs automatically, latched to once per isolate, off the
 * `/mcp` path (src/seed-docs.ts). This route exists for the two cases that
 * latch cannot serve: making it happen NOW rather than on the next cold start,
 * and seeing the per-doc outcome — in particular a `blocked` line, which is how
 * a retired reserved slug surfaces (the seeder deliberately will not release a
 * tombstone on its own).
 *
 * Operator-gated even though it writes only build output: it is a write, and
 * the report names corpus state. Idempotent — a pass with nothing to do writes
 * nothing and reports every doc `unchanged`.
 */
export async function seedPlatformDocs(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const denied = await requireOperator(req, env);
  if (denied) return denied;

  const origin = new URL(req.url).origin;
  const results = await seedPlatformDocsCore(env, origin, ctx.waitUntil.bind(ctx));
  const failed = results.filter((r) => r.action === "failed" || r.action === "blocked");
  return Response.json({ seeded: results, ok: failed.length === 0 }, { status: failed.length ? 207 : 200 });
}

/**
 * GET /admin/audit  →  200 { events: [...], next_cursor }
 *
 * The append-only operator audit ledger (migration 0020 / issue #62), newest
 * first, cursor-paginated on `(at DESC, id DESC)` like every other list here.
 *
 * Query: `?limit=&cursor=&kind=&agent_id=&document_id=&since=`. `kind` is
 * validated against the enum and rejected when unknown (`bad_request`) rather
 * than silently dropped — an audit filter that quietly matched everything would
 * read as "nothing suspicious ever happened."
 *
 * OPERATOR-ONLY, and there is no agent-door twin — nor should one be added. The
 * ledger names OAuth clients, key ids and documents across the whole fleet; it
 * is the operator's history of their own deployment, and the same reasoning
 * that keeps `visibility`, revoke and promotion off the agent door applies with
 * more force to the record of them. `requireOperator` runs before any DB read.
 */
export async function listAuditEvents(req: Request, env: Env): Promise<Response> {
  const denied = await requireOperator(req, env);
  if (denied) return denied;

  const params = parseAuditListParams(new URL(req.url));
  if (!params.ok) return jsonError(400, params.code, params.message);

  const result = await listAuditEventsCore(env, params);
  return Response.json(result);
}

/**
 * POST /admin/vectors/backfill?mode=missing|rebuild&limit=N&cursor=…
 *   →  200 { ok, mode, scanned, embedded, vectors, skipped, next_cursor }
 *
 * Operator-invoked Vectorize backfill / reconciliation (docs/design/vector-search-design.md
 * §8), MANUAL in v1 (no cron). `mode` (default "missing") is the incremental
 * heal — embeds only docs whose `#0` chunk is absent; "rebuild" re-embeds every
 * live doc. Idempotent and resumable: a non-null `next_cursor` means "more pages
 * — re-invoke with `?cursor=<that>`". `limit`/`cursor` reuse the standard list
 * params (tags/slug are ignored). Runs synchronously so the response carries the
 * counts; `vectors ≪ embedded` signals a transient Vectorize/AI failure (re-run).
 *
 * Status codes:
 *   200  page processed (see counts + next_cursor)
 *   400  bad mode / bad limit / bad cursor
 *   401  bad/missing operator auth       403  csrf_failed
 */
export async function backfillVectors(req: Request, env: Env): Promise<Response> {
  const denied = await requireOperator(req, env);
  if (denied) return denied;

  const url = new URL(req.url);
  const modeRaw = url.searchParams.get("mode") || "missing";
  if (modeRaw !== "missing" && modeRaw !== "rebuild") {
    return jsonError(400, "bad_request", `mode must be "missing" or "rebuild"`);
  }
  const mode: BackfillMode = modeRaw;

  // Reuse the list-param parser for limit/cursor validation. tags/slug are
  // parsed but unused by backfillVectorsCore.
  const params = parseHttpListParams(url);
  if (!params.ok) return jsonError(400, params.code, params.message);

  const r = await backfillVectorsCore(env, mode, params);
  return Response.json({
    mode: r.mode,
    scanned: r.scanned,
    embedded: r.embedded,
    vectors: r.vectors,
    skipped: r.skipped,
    next_cursor: r.next_cursor,
  });
}

/**
 * POST /admin/links/backfill?limit=N&cursor=…
 *   →  200 { scanned, updated, links, next_cursor }
 *
 * Operator-invoked link-graph backfill (migration 0016 / issue #40): re-extracts
 * `document_links` rows from each live doc's stored render H. The write path
 * keeps the graph current from here on; this sweep covers the write-once corpus
 * that predates the migration. Always rebuild-semantics (idempotent, cheap —
 * one R2 GET + one tiny D1 batch per doc); resumable via `?cursor=` exactly
 * like the vectors backfill above.
 *
 * Status codes:
 *   200  page processed         400  bad limit / bad cursor
 *   401  bad/missing operator auth       403  csrf_failed
 */
export async function backfillLinks(req: Request, env: Env): Promise<Response> {
  const denied = await requireOperator(req, env);
  if (denied) return denied;

  const url = new URL(req.url);
  const params = parseHttpListParams(url);
  if (!params.ok) return jsonError(400, params.code, params.message);

  const r = await backfillLinksCore(env, params, url.origin);
  return Response.json({
    scanned: r.scanned,
    updated: r.updated,
    links: r.links,
    next_cursor: r.next_cursor,
  });
}

/**
 * GET /admin/links/orphans
 *   →  200 { documents: DocumentListing[] }
 *
 * Orphan detection (issue #40): live documents NO live document links to —
 * neither by public_id nor by current slug. Newest first, capped at 200, no
 * cursor (a curation worklist, not a browse surface). A doc only ever written
 * and shared by URL is a perfectly fine orphan — this is a librarian's view,
 * not an error list. Run the links backfill first or pre-0016 docs will ALL
 * read as orphans (no graph rows yet to say otherwise).
 *
 * Status codes:
 *   200  list returned          401  bad/missing operator auth
 */
export async function listOrphanDocuments(req: Request, env: Env): Promise<Response> {
  const denied = await requireOperator(req, env);
  if (denied) return denied;
  const r = await listOrphanDocumentsCore(env);
  return Response.json({ documents: r.documents });
}
