-- Migration 0019: Insight structured metadata — nullable, indexed columns on
-- `documents` for the auto-insight Android-teardown producer (agent-web-host
-- "insight" fork; slopcafe_migration/DESIGN.md Decision 8).
--
-- WHY COLUMNS, NOT MORE TAGS. Tags (migration 0012) already carry teardown
-- classification today (`teardown`, `pkg-<pkgslug>`, `vc-<version_code>`,
-- `company-<company>`, `src-<kind>` — see DESIGN.md Decision 4) and that
-- stays the filing system for equality lookups, zero-fork. Two things tags
-- structurally cannot do:
--   1. Dots aren't in the tag charset ([A-Za-z0-9_-] only), so a package name
--      like `com.google.android.gms` has to be dot-to-hyphen mangled into a
--      tag and can't round-trip losslessly.
--   2. Tags are membership tests (`tags LIKE '%"vc-250101"%'`) — there is no
--      way to ask "version code > 249000" against a JSON array of opaque
--      strings. A real INTEGER column supports the range query
--      (`app_version_code > ?`) that unlocks "everything newer than build X".
-- These six columns are the fast-follow DESIGN.md Decision 4 explicitly
-- deferred past the tags-only v1.
--
-- LIVES ON `documents`, NOT `versions` — same rationale as `tags`/`slug`
-- (migrations 0012/0005): a teardown's app identity is a property of the
-- document's place in the corpus, not of one revision's bytes. In practice
-- the producer publishes one write-once document per teardown (the slug
-- scheme in DESIGN.md Decision 2 already encodes package+version_code), but
-- living on `documents` keeps these columns in the same identity-adjacent
-- family as the ones they get filtered alongside (`tags`, `slug`, `status`)
-- rather than requiring a join through `versions` for a value that never
-- actually varies per version.
--
-- ALL SIX NULLABLE, NO DEFAULT — additive and reversible in spirit: an
-- existing row, or a document published by an unrelated Slopcafe agent that
-- never sends the `X-Doc-App-*`/`X-Doc-Company`/`X-Doc-Kind` headers, reads
-- back as "no Insight metadata," never a false value. Same presence-flag
-- posture as 0008's source columns / 0015's digest / 0018's `published_ver`.
--
--   app_package             — reverse-DNS Android package, e.g.
--                              "com.google.android.gms". Free text, NO CHECK:
--                              validated/length-capped at the application
--                              layer (src/metadata.ts), the same posture as
--                              title/description — a malformed value here
--                              can't corrupt or collide with another document
--                              (unlike slug, this column carries no
--                              uniqueness constraint).
--   app_version_code        — the integer versionCode from AndroidManifest.xml
--                              (monotonic per package — what "newer" means
--                              for an Android build, unlike the human-
--                              readable versionName below). The reason this
--                              migration adds real columns at all:
--                              `app_version_code > ?` is not expressible
--                              against a JSON tags array.
--   app_version_name        — the human-readable versionName (e.g.
--                              "17.5.34"), free text, carried purely for
--                              display — never a sort/range key.
--   compared_version_code   — the PRIOR version_code this teardown diffed
--                              against; NULL for a first-seen app with no
--                              comparison (mirrors the producer's
--                              TeardownResult.NO_COMPARISON in
--                              teardown_utils.py). Lets a reader reconstruct
--                              the diff chain (compared_version_code ->
--                              app_version_code) without re-deriving it from
--                              two documents' slugs.
--   company                 — the publisher/company label the producer
--                              already tracks per app (e.g. "Google"), free
--                              text.
--   doc_kind                — a controlled vocabulary naming what KIND of
--                              Insight document this row is (a teardown body,
--                              an overflow section per DESIGN.md Decision 1's
--                              size-bound spill rule, or an investigation-
--                              agent writeup/hypothesis/experiment-result/
--                              KB entry/scratch context — see DESIGN.md
--                              Decision 9). CHECK-pinned like every other
--                              discriminator column in this schema
--                              (`visibility`, `status`, `source_format`,
--                              `target_kind`, `created_by_kind`,
--                              `author_kind`): a SQLite CHECK constraint is
--                              satisfied whenever the expression evaluates to
--                              NULL (it only FAILS on an expression that
--                              evaluates to 0), so `doc_kind IN (...)` on
--                              this NULLABLE column still accepts "no
--                              doc_kind set" and rejects only an out-of-
--                              vocabulary non-null value. Keep this list in
--                              lockstep with DOC_KIND_VALUES in
--                              src/metadata.ts.
--
-- INDEXES support the query shapes DESIGN.md Decision 8 names:
--   (app_package, app_version_code)  — "every teardown for package P"
--                                       (equality on the leading column) AND
--                                       "every teardown for P at or above
--                                       version V" (equality + range on the
--                                       same index — the standard leftmost-
--                                       prefix composite-index use).
--   (doc_kind)                       — "every hypothesis" / "every writeup" —
--                                       the investigation-agent taxonomy
--                                       filter (Decision 9); low-cardinality
--                                       but still narrows a 10 GB-cap corpus
--                                       fast.
--   (company)                       — cheap (single low-cardinality column,
--                                       same shape as the other two) and
--                                       named explicitly in the fork brief;
--                                       "every teardown from company C" is
--                                       the obvious next question once
--                                       app_package exists.
-- All three indexes use IF NOT EXISTS. NOTE the ALTER TABLE statements below
-- CANNOT be guarded the same way (SQLite has no ADD COLUMN IF NOT EXISTS), so
-- this migration is NOT blindly re-runnable: a partial failure mid-ALTER
-- followed by a naive retry fails with "duplicate column name". If a partial
-- apply ever happens on live D1, delete the already-added columns' ALTER
-- lines (or the whole applied prefix) from a copy before retrying, or drop
-- the columns first. This migration has not yet been run against live D1 (no
-- Cloudflare credentials were available to the overnight session that wrote
-- it — see the auto-insight branch's slopcafe_migration/RUNBOOK.md).

ALTER TABLE documents ADD COLUMN app_package TEXT;
ALTER TABLE documents ADD COLUMN app_version_code INTEGER;
ALTER TABLE documents ADD COLUMN app_version_name TEXT;
ALTER TABLE documents ADD COLUMN compared_version_code INTEGER;
ALTER TABLE documents ADD COLUMN company TEXT;
ALTER TABLE documents ADD COLUMN doc_kind TEXT
  CHECK (doc_kind IN (
    'teardown',
    'teardown-section',
    'writeup',
    'hypothesis',
    'experiment-result',
    'kb-feature',
    'analyst-context'
  ));

CREATE INDEX IF NOT EXISTS documents_app_version
  ON documents (app_package, app_version_code);

CREATE INDEX IF NOT EXISTS documents_doc_kind
  ON documents (doc_kind);

CREATE INDEX IF NOT EXISTS documents_company
  ON documents (company);
