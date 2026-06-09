-- migrations/0014_document_status.sql
--
-- Lifecycle `status` — the third per-document state axis (context packs
-- prerequisite, docs/design/context-packs-design.md §3.4 / GitHub issue #21).
-- The two existing axes answer "does it exist?" (revoked_at, the hard kill) and
-- "who can see it?" (visibility, the anonymous gate). Neither can say "still
-- findable, no longer current" — a superseded design note keeps ranking in
-- search, and an automatic context pack that pulls it would confidently brief
-- an agent on outdated truth. `status` is that missing state.
--
--   * active     — normal (the default; every pre-migration row backfills here).
--   * deprecated — still renders, still found by search BUT carried/marked in
--                  the hit; EXCLUDED from context packs by default.
--   * archived   — RESERVED. Pinned in the CHECK now so wiring its stronger
--                  "hidden from default search/list unless opted in" semantics
--                  later needs no migration; NO behavior in v1 and the operator
--                  mutator (setDocumentStatusCore) rejects setting it.
--
-- LIVES ON `documents`, NOT `versions`: status is classification (like tags,
-- migration 0012, and slug, 0005) — a property of the document's place in the
-- collection, not of any version's bytes. It survives version bumps and
-- restores, and a status change never bumps a version (operator mutator
-- setDocumentStatusCore / POST /admin/documents/:id/status, mirroring the
-- visibility/tags/slug siblings). Operator-gated in v1; agent-reachable
-- self-deprecation is a deferred follow-up the trust model already permits.
--
-- `superseded_by` is the companion pointer: a deprecated document can name its
-- replacement by the target's `public_id`. The document-level analogue of
-- slug_tombstones.redirect_to (migration 0010) with the same LOUD contract —
-- surfaces never auto-follow it; the reader is told and decides. Single-hop by
-- construction (the target is a public_id, not another pointer). Plain TEXT
-- with no FK (it stores a public_id, not the documents.id PK — same shape as
-- redirect_to); validated at write time (live target, no self-pointer) and
-- forced NULL whenever status returns to 'active'.
--
-- DEFAULT 'active' is both the backfill AND the product default — unlike
-- visibility-0011 there is no split: a new document is genuinely active. The
-- write path still relies on the column default at INSERT (status is not a
-- birth-time knob; deprecation is always an explicit later act). The CHECK pins
-- the three legal values so a stray write fails loud at the DB.

ALTER TABLE documents ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
  CHECK (status IN ('active', 'deprecated', 'archived'));

ALTER TABLE documents ADD COLUMN superseded_by TEXT;
