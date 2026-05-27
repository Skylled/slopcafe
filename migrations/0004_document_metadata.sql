-- Per-version document metadata: title, description, tags.
--
-- All three are agent-supplied (optional) at publish/update time. Title can
-- also be derived from the document's first <h1> (or first ~80 chars of text)
-- when the agent doesn't supply one — see src/metadata.ts deriveTitleFromHtml.
-- The shell page (src/serve.ts) renders `<title>{title} | Slopcafe</title>`
-- with display-time normalization to strip bidi-override / control chars so a
-- malicious title can't reorder the brand suffix visually.
--
-- Lives on `versions` (not `documents`) so metadata evolves with content the
-- same way `sanitizer_v`, `source_format`, and `size_bytes` already do. On
-- update, the agent can omit any/all fields to inherit from the prior version
-- — that resolution happens at WRITE time in src/core.ts and the resolved
-- values are stored, so reads stay one query (no walking back through
-- versions to find the last non-null title).
--
-- Tags are JSON-encoded text. Charset is restricted to [A-Za-z0-9_-] at write
-- time (see sanitizeTagsInput in src/metadata.ts), so a comma-separated TEXT
-- would also work — JSON is chosen for unambiguous round-trip and to leave
-- room for richer per-tag metadata later. No tag index in v1 — we don't query
-- by tag yet.
--
-- All three columns default to NULL for rows written before this migration.
-- The shell page falls back to bare "Slopcafe" when title is NULL, and the
-- list/read responses surface null/[] for absent values — old docs degrade
-- gracefully.

ALTER TABLE versions ADD COLUMN title TEXT;
ALTER TABLE versions ADD COLUMN description TEXT;
ALTER TABLE versions ADD COLUMN tags TEXT;
