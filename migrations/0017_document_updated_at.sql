-- Migration 0017: `documents.updated_at` — the corpus modification-time axis.
--
-- Every time axis the model had until now answered "when did this APPEAR?":
-- `documents.created_at` (the document) and `versions.created_at` (one revision,
-- reachable one document per call via read_document include_history). Nothing
-- answered "what CHANGED in the corpus since I last looked" — the first question
-- an agent that maintains a knowledgebase over months asks. Listing rows carried
-- `created_at` and ordered by it, so a note written in January and rewritten
-- yesterday sorted last and read as stale, while a scratch doc created yesterday
-- and never touched sorted first.
--
-- `updated_at` is that missing axis: the instant this document's row last
-- CHANGED in a way a corpus consumer cares about. Paired with the `order=updated`
-- walk and the `updated_since=` filter on the list surface, it turns
-- `list_documents` into a change feed.
--
-- WHO STAMPS IT — every mutator, write-path-local, NO TRIGGERS (same discipline
-- as the documents_fts and document_links syncs: a trigger would be a second
-- write path nobody reading core.ts can see):
--
--   * publishDocumentCore — bound EXPLICITLY in the INSERT, never left to the
--     sentinel DEFAULT below. Both timestamps resolve from the same statement's
--     'now', so a freshly published doc has updated_at == created_at exactly.
--   * updateDocumentCore — on the `current_ver` UPDATE. This also covers
--     editDocumentCore and restoreVersionCore, which delegate their write here
--     rather than re-implementing the version-append sequence.
--   * the four CLASSIFICATION mutators — setDocumentTagsCore /
--     setDocumentSlugCore / setDocumentVisibilityCore / setDocumentStatusCore.
--     THIS IS THE WHOLE POINT of a document-level column: those deliberately do
--     NOT bump a version, so `versions.created_at` can never see them. A retag is
--     a corpus change even though it is not a new revision.
--   * revokeDocumentCore — a revoke is the largest change a document can undergo,
--     and without the stamp a polling consumer would never learn the doc died
--     (its row keeps the updated_at of its last content write). Only on the kill
--     itself; the idempotent purge-retry path skips the D1 batch entirely and so
--     leaves both `revoked_at` and `updated_at` at their original values.
--
-- BACKFILL — the honest reconstruction from what the schema already stores:
--     the current version's created_at   (the last CONTENT change we can prove)
--   → revoked_at                         (a revoked doc has current_ver = NULL)
--   → documents.created_at               (a doc with no version row at all)
--
-- What that CANNOT recover: any pre-migration CLASSIFICATION change (a retag,
-- rename, visibility flip, or deprecation) left no timestamp anywhere in the
-- schema, so a document last touched by one of those under-reports as of its last
-- content write. That is the one-time cost of adding the axis late. Nothing heals
-- it and nothing should pretend to — the first post-migration touch corrects the
-- row for good.
--
-- NOT NULL WITH A DELIBERATELY ABSURD SENTINEL DEFAULT. SQLite's ALTER TABLE ADD
-- COLUMN accepts only a CONSTANT default — `strftime(…, 'now')` is rejected — so
-- "default it the way created_at defaults" is simply not expressible here. The
-- epoch sentinel exists only to satisfy NOT NULL during the ADD; the UPDATE below
-- immediately replaces it on every existing row, and every INSERT binds the
-- column explicitly. If a 1970 stamp ever surfaces on a listing row it means a
-- NEW write path forgot to bind `updated_at` — which is loud and self-describing
-- (it sorts last under `order=updated` and matches no `updated_since` window),
-- exactly what a NULL or empty-string default would have hidden instead.
--
-- The index matches the change-feed query shape: `ORDER BY updated_at DESC,
-- id DESC` (the `id` tiebreaker is mandatory — D1's strftime stamps to ms, so
-- collisions under bursty writes are real and a cursor without it could skip a
-- row at a page boundary) plus the `updated_at >= ?` range of `updated_since=`.
-- The created_at ordering has always run scan-then-sort at this corpus size and
-- still does; this axis earns an index because it is the query an agent POLLS,
-- and because rows keep MOVING within it as they are touched.

ALTER TABLE documents ADD COLUMN updated_at TEXT NOT NULL
  DEFAULT '1970-01-01T00:00:00.000Z';

UPDATE documents
SET updated_at = coalesce(
      (SELECT v.created_at FROM versions v
        WHERE v.document_id = documents.id
          AND v.version_no = documents.current_ver),
      revoked_at,
      created_at);

CREATE INDEX documents_updated_at ON documents (updated_at DESC, id DESC);
