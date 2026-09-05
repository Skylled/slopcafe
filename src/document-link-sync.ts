// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/**
 * Write-time link-graph sync (migration 0016, GitHub issue #40): the
 * `document_links` DELETE-then-INSERT statements a write splices into the SAME
 * `META.batch()` as the version and FTS rows.
 *
 * Key invariants:
 *   - Targets are stored RAW (late binding; resolution is read-time in
 *     src/links-core.ts); self-links filtered; `MAX_DOCUMENT_LINKS` cap;
 *     INSERTs chunked under D1's bind limit.
 *   - A leaf (imports only src/pack.ts + Env) so both the write cores and the
 *     backfill sweep in links-core can share it without a cycle.
 */

import type { Env } from "./env.js";
import { type ExtractedLink, extractOutboundLinks } from "./pack.js";

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
export function documentLinkStatements(
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
