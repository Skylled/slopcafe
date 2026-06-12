-- Migration 0016: the document link graph (wiki-style backlinks, GitHub issue #40).
--
-- One row per distinct on-platform link a document's CURRENT version carries:
-- the `/d/<public_id>` and `/s/<slug>` hrefs extracted from the sanitized
-- render H at write time (the same extractOutboundLinks walk context packs
-- already run at read time — src/pack.ts). The table is synced INSIDE the same
-- D1 batch as the documents_fts row (delete-then-insert on every publish/
-- update; deleted on revoke), so the graph tracks the current version exactly
-- like search does — never a trigger, never a second write path.
--
-- LATE BINDING is the core design point: `target_value` stores the RAW
-- addressed name (a public_id or a slug), NOT a resolved documents.id FK. A
-- link may point at a slug nobody has claimed yet, a slug that later gets
-- renamed/retired, or a doc that later gets revoked — all legal states of a
-- wiki. Resolution happens at READ time (listBacklinksCore / the outbound
-- link-health join), where "live / redirected / retired / revoked / missing"
-- can be answered against the tables that actually know.
--
-- Columns:
--   src_doc_id   — the LINKING document (documents.id). Cascade-deleted with
--                  its document; also explicitly deleted in the revoke batch
--                  (revoke never deletes the documents row, it tombstones it —
--                  the explicit DELETE is the live cleanup).
--   position     — 0-based first-appearance order in the body, so an outbound
--                  listing reads in authored order.
--   target_kind  — which namespace the href addressed: 'public_id' (/d/…) or
--                  'slug' (/s/…). CHECK-pinned like every discriminator here.
--   target_value — the raw addressed name. Shape-validated at extraction
--                  (PUBLIC_ID/slug regexes in src/pack.ts); never resolved at
--                  write time.
--
-- The PK dedupes per (source, kind, value) — extractOutboundLinks already
-- dedupes in first-appearance order, the PK is the DB-level backstop.
-- The target index is the backlinks query ("who links HERE") — it scans by
-- (kind, value) and joins src_doc_id back to documents.
--
-- No backfill in SQL: link rows derive from the R2-resident H bytes, which
-- SQLite can't see. Existing docs get rows on their next write, or via the
-- operator sweep POST /admin/links/backfill (same posture as the FTS table's
-- "no backfill" note in 0006 — but with the sweep actually built this time,
-- because most of this corpus is write-once).

CREATE TABLE document_links (
  src_doc_id   TEXT    NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  position     INTEGER NOT NULL,
  target_kind  TEXT    NOT NULL CHECK (target_kind IN ('public_id', 'slug')),
  target_value TEXT    NOT NULL,
  PRIMARY KEY (src_doc_id, target_kind, target_value)
);

CREATE INDEX document_links_target ON document_links (target_kind, target_value);
