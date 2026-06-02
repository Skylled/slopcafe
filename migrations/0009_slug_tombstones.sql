-- Slug tombstones — make a claimed slug semi-permanent.
--
-- REVERSES the "released on revocation" contract that migration 0005
-- established (and that 0005's own comment + revokeDocumentCore documented):
-- there, revoking a document cleared `documents.slug` to NULL, freeing the
-- handle for a future publish to reclaim and serve ENTIRELY DIFFERENT content
-- from the same `/s/<slug>` URL. That silent repurposing is the footgun this
-- migration closes (see GitHub issue #6). A shared / bookmarked / cross-linked
-- (`<a href="/s/other">`) / link-unfurled slug must keep meaning what it meant,
-- or 410/redirect — never resolve to an unrelated document.
--
-- MODEL. `documents.slug` is UNCHANGED in meaning: it still holds a document's
-- single *live* slug, still NULL on revoke, still covered by the partial unique
-- index from 0005. Every existing live-slug query (findDocumentBySlugCore,
-- resolvePublicIdBySlug, the list/search slug filters, the LISTING_* joins) is
-- byte-for-byte unaffected. What changes is that a slug, once removed from a
-- live document, is now RETIRED into this table instead of vanishing:
--
--   * revoke              → tombstone (reason 'revoked')
--   * rename (slug A→B)   → A is tombstoned (reason 'renamed'); B becomes live
--   * explicit clear ("") → tombstone (reason 'released')
--
-- so a document accumulates one tombstone per slug it ever shed (which is why
-- this is a SEPARATE table keyed on slug, not another column on `documents` —
-- one row can't hold a rename history).
--
-- UNIQUENESS now spans TWO sets: a new claim is rejected if the slug is live on
-- another document (partial unique index on documents.slug → `slug_taken`) OR
-- present here (→ `slug_retired`). resolveSlug (src/core.ts) checks both. The
-- two sets are disjoint by construction — a slug is either live on exactly one
-- document or retired here, never both — so there is no cross-table constraint
-- to enforce, only the best-effort pre-check (same race posture as the existing
-- slug_taken check, which 0005 already documents as acceptable for v1).
--
-- SERVE. A retired slug that no live document carries resolves to 410 Gone
-- (serveBySlug / serveTextBySlug / MCP read_document), distinct from the opaque
-- 404 a never-claimed slug returns. The 410 deliberately discloses that the
-- slug once existed — an accepted trade for honest "this was removed" UX on a
-- surface (slugs) that is public and meant to be shared.
--
-- `redirect_to` is added by a later migration (0010) for the operator-only
-- repoint-to-a-new-destination case; it is NOT part of this migration so the
-- reuse-block ships without a dead column.
--
-- ON DELETE SET NULL (not CASCADE): a reservation must OUTLIVE its origin
-- document. Documents are never hard-deleted today (revoke keeps the row as an
-- audit trail), so the FK action is effectively dormant; SET NULL is the
-- correct semantic if a row ever does go away — the slug stays reserved, the
-- audit pointer just goes null. CASCADE would free the slug, defeating the
-- whole point.

CREATE TABLE slug_tombstones (
  slug         TEXT PRIMARY KEY,
  document_id  TEXT REFERENCES documents(id) ON DELETE SET NULL,
  retired_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  reason       TEXT NOT NULL
);

-- Audit lookup: "which slugs did this document shed over its life."
CREATE INDEX slug_tombstones_document_id ON slug_tombstones (document_id);
