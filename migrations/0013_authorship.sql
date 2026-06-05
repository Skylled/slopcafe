-- migrations/0013_authorship.sql
--
-- Authorship as a PRINCIPAL, not an agent. The write path historically took a
-- bare `agentId: string` and stamped it as both the document creator
-- (documents.created_by) and the per-version writer (R2 customMetadata only).
-- That hardcoded "every author is an agent" — but the operator is a distinct,
-- TABLELESS principal (src/access.ts Principal: {kind:"operator"} | {kind:
-- "agent";agentId}). Operator authoring (POST /admin/documents, PUT
-- /admin/documents/:id) makes the operator a first-class author, so storage must
-- record WHICH KIND of principal created a document and wrote each version.
-- `created_by` alone can't say so: it's an agents FK that goes NULL BOTH for an
-- operator author AND for an agent whose row was deleted (ON DELETE SET NULL) —
-- an ambiguity only an explicit discriminator resolves.
--
-- TWO LEVELS, deliberately both recorded (a mild, pre-existing denormalization —
-- documents.created_by already duplicates version 1's author):
--   * DOCUMENT creator — documents.created_by_kind. Read by the listing
--     surfaces (listDocumentsCore / findDocumentBySlugCore / searchDocumentsCore)
--     WITHOUT a versions join, so the kind must live on `documents`.
--   * VERSION writer — versions.author_kind + versions.author_agent_id. Lifts
--     per-version authorship out of R2 customMetadata into D1 so a document's
--     FULL AUTHOR LIST is queryable (the version-history surfaces). The R2
--     customMetadata copy stays as a best-effort audit echo.
--
-- BACKFILL: every pre-migration row was agent-authored, so DEFAULT 'agent' is
-- correct for both kinds. New writes set the kind EXPLICITLY from the resolved
-- principal (the visibility-0011 pattern), so the DEFAULT only ever covers
-- legacy rows. versions.author_agent_id is LEFT NULL for legacy versions — the
-- true historical per-version writer lives only in R2 customMetadata, and an R2
-- scan to backfill it is deliberately NOT run (manual-migration-over-legacy
-- stance; an honest NULL beats asserting a possibly-wrong author). The CHECKs
-- pin both discriminators to the two legal values so a stray write fails loud at
-- the DB. (SQLite ADD COLUMN legality: a constant NOT NULL default, a nullable
-- FK whose default is NULL, and a CHECK are all permitted forms.)
--
-- MULTI-OPERATOR is the deferred seam, NOT built here: a second operator needs
-- per-operator auth (today there is ONE OPERATOR_TOKEN) and an `operators`
-- table. The kind discriminator is the only forward-compatible artifact added
-- now — when operators multiply, an additive `author_operator_id` column fills
-- in, with the kind already recorded.

ALTER TABLE documents ADD COLUMN created_by_kind TEXT NOT NULL DEFAULT 'agent'
  CHECK (created_by_kind IN ('agent', 'operator'));

ALTER TABLE versions ADD COLUMN author_kind TEXT NOT NULL DEFAULT 'agent'
  CHECK (author_kind IN ('agent', 'operator'));

ALTER TABLE versions ADD COLUMN author_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL;
