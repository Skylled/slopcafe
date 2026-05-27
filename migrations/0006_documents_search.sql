-- Full-text search over documents, backed by SQLite FTS5.
--
-- One row per live document; the row tracks the document's current version
-- and is updated in lockstep with version writes (publish → INSERT,
-- update → UPDATE, revoke → DELETE). The shadow tables FTS5 maintains are
-- the SOLE storage of body-as-text: at write time core.ts runs the same
-- htmlToMarkdown converter used by readDocumentTextCore on the sanitized
-- bytes and feeds the result here. Read paths still re-derive markdown
-- from R2 on demand — the FTS body is a write-time-only side channel.
--
-- Columns rationale:
--   document_id UNINDEXED  — join key back to documents.id. UNINDEXED keeps
--                            the UUID out of the tokenizer (so a search for
--                            `foo` doesn't match against a UUID fragment).
--   title / description / tags / body — separate columns so BM25 can weight
--                            title hits heavier than body hits, and so the
--                            snippet() builtin can target a specific column
--                            (or be skipped when the match is in a short
--                            field where the value itself is the "snippet").
--
-- Tokenizer rationale:
--   porter            — light English stemming; "publish/publishes/published"
--                       collapse to one match without a custom dictionary.
--   unicode61         — Unicode-aware case folding + word boundary detection,
--                       safer than the default `simple` for any non-ASCII.
--   remove_diacritics 2 — strip combining marks (NFD then drop) so naïve and
--                         naive match. The `2` form keeps the underlying
--                         character even when the combining mark is encoded
--                         as a single precomposed codepoint.
--
-- No backfill: the FTS table starts empty. Existing documents (if any) become
-- searchable on their next update. v1 deployment has a tiny corpus so this is
-- acceptable; a future POST /admin/reindex could walk the fleet if needed.

CREATE VIRTUAL TABLE documents_fts USING fts5(
  document_id UNINDEXED,
  title,
  description,
  tags,
  body,
  tokenize = 'porter unicode61 remove_diacritics 2'
);
