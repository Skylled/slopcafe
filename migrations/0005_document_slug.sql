-- Optional document slug — a unique, human/agent-typeable handle that
-- lives alongside `public_id` on the documents row.
--
-- Lives on `documents` (not `versions`) because a slug is identity-adjacent,
-- not per-version metadata: uniqueness is enforced across documents, and
-- callers refer to "this slug" the same way they refer to "this public_id"
-- — across the document's lifetime, not per write. Title/description/tags
-- stay on `versions` because they describe the bytes of a specific version
-- and inherit/clear on update; the slug describes the document itself.
--
-- Uniqueness is partial: the index excludes NULL so unset slugs don't
-- collide. Revoking a document clears the slug to NULL (see
-- revokeDocumentCore in src/core.ts), which automatically releases it for
-- re-use by a future publish. This is the "released on revocation"
-- contract — the slug column has the same lifecycle as the R2 bytes
-- (gone instantly when the doc is revoked), while `public_id` survives
-- on the row as an audit/lookup key.
--
-- Validation (src/metadata.ts validateSlugInput) restricts the charset to
-- /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/ — lowercase URL-safe slugs,
-- 1-64 chars, must start and end alphanumeric. Unlike tags, invalid
-- slug input is REJECTED (not silently sanitized): a slug that's been
-- mutated under the agent's feet could collide unexpectedly with another
-- doc's slug, defeating the uniqueness guarantee.
--
-- No backfill: documents written before this migration have slug = NULL,
-- which is the same shape as a never-set slug. Reads/lists degrade
-- gracefully (slug surfaces as null on the response).

ALTER TABLE documents ADD COLUMN slug TEXT;

-- Partial unique index so the constraint only applies to non-NULL slugs.
-- A plain UNIQUE constraint would also allow multiple NULLs in SQLite, but
-- the partial form is explicit about intent and matches the documented
-- "released on revoke (= NULL)" semantics.
CREATE UNIQUE INDEX documents_slug_unique ON documents (slug) WHERE slug IS NOT NULL;
