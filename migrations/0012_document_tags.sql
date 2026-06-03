-- migrations/0012_document_tags.sql
--
-- Lift `tags` from per-version metadata (versions.tags, migration 0004) to a
-- document-level attribute (documents.tags), and drop the now-redundant tags
-- column from the FTS index. librarian-design.md §3.1-3.3, build-order steps 1-2.
--
-- ROOT CAUSE (design §2): tags were filed on `versions` alongside title/
-- description "because they describe content." Title and description genuinely
-- track revisions; a TAG is classification — a property of the document's place
-- in the collection, not of one revision's wording. Misfiling it meant curation
-- couldn't be a no-bump write, restore clobbered classification, and a retag
-- churned a client's If-Match. All three dissolve when tags move next to `slug`
-- and `visibility` on the IDENTITY side (documents, migrations 0005 / 0011).
--
-- FOUR ORDERED STEPS (D1 runs the file's statements in sequence — order is
-- load-bearing: the backfill in (2) reads versions.tags, which (3) drops):
--   (1) ADD documents.tags TEXT (nullable, no default; same JSON-array-or-NULL
--       shape as the old versions.tags — see serializeTags / parseStoredTags in
--       src/core.ts; NULL == "no tags").
--   (2) BACKFILL each document's tags from its CURRENT version (current_ver).
--       Tags decouple from history at the live state: a doc keeps what it has
--       NOW, not v1's. A current version with NULL tags (or a legacy doc with no
--       current version) backfills to NULL — graceful (parseStoredTags NULL->[]).
--   (3) DROP versions.tags. Pre-launch no-legacy stance: break the churn now
--       rather than carry a dead column or a fallback. `tags` is in NO index/
--       constraint (only the ADD COLUMN in 0004) and NOT in the versions PK
--       (document_id, version_no) — DROP is unblocked on D1's SQLite. MUST run
--       AFTER (2) reads it.
--   (4) REBUILD documents_fts WITHOUT the tags column, PRESERVING body. FTS5
--       cannot DROP COLUMN in place. The `body` column is htmlToMarkdown(H)
--       derived by the WASM converter at WRITE time and stored ONLY here (no
--       versions/documents column holds it) — a pure-SQL migration cannot
--       regenerate it, so we MUST carry document_id/title/description/body across
--       via a temp table. CREATE TABLE ... AS SELECT ... FROM documents_fts reads
--       the stored column text out of the FTS5 table verbatim. NEVER repopulate
--       body from versions/documents — that would write NULL and silently blank
--       all full-text search.
--
-- COLUMN-INDEX SHIFT (the silent-corruption trap — fixed in src/core.ts, NOT
-- here): documents_fts columns were 0=document_id,1=title,2=description,3=tags,
-- 4=body. After this migration: 0=document_id,1=title,2=description,3=body. In
-- searchDocumentsCore, bm25() weights map to INDEXED columns (4->3: drop the
-- tags weight) while snippet() indexes count the UNINDEXED document_id (body
-- moves from index 4 to 3; the tags snippet at index 3 is removed). The two
-- conventions shift DIFFERENTLY — a uniform decrement corrupts ranking/snippets
-- with NO error. The bm25()/snippet() args, BM25_WEIGHTS, the matched_field
-- ladder, and SearchHit.matched_field MUST be updated in the SAME deploy.
--
-- TAG FILTERING is unaffected in shape but retargets its source: the ?tags=
-- AND-filter (tagLikePattern -> `tags LIKE ? ESCAPE '\'`) has NEVER used FTS —
-- it matches the real JSON tags column. It moves from v.tags to d.tags
-- (src/core.ts listDocumentsCore + searchDocumentsCore) and keeps working. Only
-- the FTS BM25 boost for a free-text query that happened to match a tag is given
-- up (design §3.3) — the precise tool is q=async&tags=python.
--
-- DEPLOY ORDERING (breaking, forward-only): run db:migrate:remote IMMEDIATELY
-- before `wrangler deploy` of the already-built fixed code. There is a brief
-- window where the OLD Worker (5-column FTS INSERT, 4-weight bm25, snippet
-- index 4, v.tags reads) hits the NEW schema and errors on publish/update/
-- search/list/tag-filter. Acceptable for this pre-launch single-tenant deploy.
-- D1 has no down-migration and this DROP discards per-version tag history
-- permanently (design §3.2 accepts this) — commit the fixed code BEFORE
-- migrating.

-- (1) document-level tags column. Nullable, no default: NULL is "no tags".
ALTER TABLE documents ADD COLUMN tags TEXT;

-- (2) backfill from each document's CURRENT version. The WHERE guard skips
-- legacy rows with no current version (the subquery would yield NULL for them
-- anyway — the guard just avoids the pointless correlated scan). A current
-- version with NULL tags yields NULL (the "no tags" shape).
UPDATE documents
   SET tags = (
     SELECT v.tags
       FROM versions v
      WHERE v.document_id = documents.id
        AND v.version_no  = documents.current_ver
   )
 WHERE current_ver IS NOT NULL;

-- (3) drop the per-version tags column (reads in step 2 are already done).
ALTER TABLE versions DROP COLUMN tags;

-- (4) rebuild documents_fts without `tags`, preserving body/title/description.
--     Carry the stored text through a temp table because the body markdown is
--     derived at write time and lives ONLY in this index.
CREATE TABLE _fts_migrate AS
  SELECT document_id, title, description, body FROM documents_fts;

DROP TABLE documents_fts;

-- Recreated with the EXACT tokenizer string from 0006 (byte-identical:
-- 'porter unicode61 remove_diacritics 2') minus the tags column. Keep this
-- tokenizer in lockstep with 0006 if either ever changes.
CREATE VIRTUAL TABLE documents_fts USING fts5(
  document_id UNINDEXED,
  title,
  description,
  body,
  tokenize = 'porter unicode61 remove_diacritics 2'
);

INSERT INTO documents_fts (document_id, title, description, body)
  SELECT document_id, title, description, body FROM _fts_migrate;

DROP TABLE _fts_migrate;
