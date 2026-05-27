-- Record which input format an agent used to author each version, so the
-- admin views and the list endpoint can show "this version came in as
-- Markdown" without having to inspect the stored bytes (which are HTML in
-- both cases — convert-and-discard is the v1 storage model).
--
-- Default 'html' covers every row written before this migration: the only
-- write surfaces in those days accepted text/html, so the backfill is
-- factually correct rather than a guess.
--
-- This column does NOT change the trust model: the sanitizer still runs
-- once at write time on the post-conversion HTML, regardless of source
-- format. See src/core.ts publishDocumentCore / updateDocumentCore.

ALTER TABLE versions ADD COLUMN source_format TEXT NOT NULL DEFAULT 'html';
