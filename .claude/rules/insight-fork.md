# The agent-web-host-insight fork

This checkout is the **Insight fork** of Slopcafe: the deployment that hosts
auto-insight's Android teardowns for a handful of human readers and one
publishing agent. It was rebased onto upstream `main` for QL-275 S6; every rule
in `CLAUDE.md` still applies, and this file is the ONE home for what the fork
adds or changes. `CLAUDE.md` carries short "(fork: …)" notes that point here.

Keep this file current in the same commit as any change to the surfaces below,
exactly like `CLAUDE.md`'s own rule. Fork-wide test entry points:
`test/authz-surface.test.mjs`, `test/insight.test.mjs`,
`test/reader-theme.test.mjs` (all in `npm test`).

## Contract and migrations

- **Contract `3.1.0`** (`OPENAPI_INFO_VERSION`): an additive minor over upstream
  `3.0.1`. The ledger comment above the constant lists the fork's additions;
  before the rebase the fork numbered them `2.3.0`–`2.6.0`, and those numbers
  are retired. A future upstream minor will collide with `3.1.0` — when the fork
  is next rebased, bump past upstream and fold the ledger again, never reuse a
  number upstream has spoken for.
- **Migration `0021_insight_metadata.sql`** was the fork's `0019`; upstream took
  `0019`/`0020`. wrangler tracks applied migrations BY FILE NAME, so a database
  that applied `0019_insight_metadata.sql` must have its `d1_migrations` row
  renamed BEFORE `migrations apply` (the file header has the one statement), or
  `0021` re-runs its ALTERs and fails "duplicate column name". A fresh database
  needs nothing.

## Insight structured metadata (`0021`)

Six nullable, no-default columns on `documents`: `app_package`,
`app_version_code`, `app_version_name`, `compared_version_code`, `company`,
`doc_kind`. `doc_kind` is CHECK-pinned to a fixed vocabulary that is mirrored
THREE times and must move in lockstep: the `0021` CHECK, `DOC_KIND_VALUES` in
`src/metadata.ts`, and `DocKindSchema` in `src/contract.ts` (a `tsc` guard pins
the last two). Indexed `(app_package, app_version_code)`, `(doc_kind)`,
`(company)`.

- **Document-level, like `tags`/`slug`**: resolved "undefined = leave alone" by
  `resolveInsightFieldsForWrite` in `src/document-write.ts`; written by a
  separate conditional UPDATE (column names only from the fixed
  `INSIGHT_COLUMNS` literal, never caller input); part of the identical-write
  no-op collapse key, so an Insight-only change is never swallowed. Restore
  keeps the CURRENT values (classification doesn't roll back).
- **Inputs**: `X-Doc-App-Package` / `-App-Version-Code` / `-App-Version-Name` /
  `-Compared-Version-Code` / `X-Doc-Company` / `X-Doc-Kind` on `POST /d` and
  `PUT /d/:id` (UTF-8 decoded like every `X-Doc-*` header), and the matching MCP
  write inputs (`INSIGHT_METADATA_FIELDS` in `src/mcp-tool-fields.ts`; `doc_kind`
  clears with `null`). PERMISSIVE: a malformed number or unknown kind is
  DROPPED, never a 4xx — none of these carries a uniqueness constraint (contrast
  slug's reject-not-sanitize).
- **Outputs**: echoed on every write/read/list/search result via `metadataEcho`
  (`src/contract.ts`), the shared `DOCUMENT_LISTING_COLUMNS`, the three read
  cores, MCP `read_document`, and the hand-spelled `/text` + `/source` JSON
  envelopes in `src/serve.ts` (both of which once dropped them — a new field on
  a read core must be forwarded there too). Not on `view_document` (its flat
  presentation envelope).
- **Backup/restore** (`src/backup.ts`) carries all six on the document record;
  the schema takes them as optional so an older export restores them NULL.
- Chunked FTS for an oversize Insight document is designed, not built:
  `docs/design/insight-chunked-fts.md`.

## Reader tier + single-publisher write allowlist

Full design and the gate table: `docs/design/single-publisher-auth.md`;
operator runbooks: `docs/operating.md` ("Give someone read-only access", "Lock
writes to one agent"). Both settings are OFF when unset — the Worker then
behaves exactly like upstream.

1. **`READER_TOKENS`** (secret, comma-separated, ONE TOKEN PER PERSON) adds
   `{kind:"reader"}` to `Principal` (`src/access.ts`): reads everything an agent
   reads, private documents included, via a Bearer or a `/login` cookie, and
   writes NOTHING. A reader cookie's payload carries `r` = `hmacSha256Hex(
   "awh-reader-id/v1:" + token, signingKey)[0..16]`; absent `r` = OPERATOR
   session, which is why live operator cookies survived the feature (no
   `PAYLOAD_V` bump). Verification recomputes `r` for every CURRENTLY configured
   token, so deleting one entry logs out exactly that person; `r` fingerprints
   the TOKEN, never its index (an index would re-point at another human on
   every removal). `SESSION_EPOCH` / `OPERATOR_TOKEN` rotation still logs out
   everyone.
   - **The structural safety**: `authenticateOperatorRequest` was NARROWED to
     `tier === "operator"`, and every pre-existing gate calls it (directly or
     via `requireOperator` / `authorizeOperatorForm`), so the tier is
     DENY-BY-DEFAULT and opening a read is an explicit, greppable edit.
     `Author` has no reader member, so a reader can't even be typed into a
     write core.
   - **Widened reads**: `requireReadSession` (`src/session.ts`; operator OR
     reader) on `GET /admin/documents`, `/admin/documents/search`,
     `/admin/documents/:id`, `/admin/documents/:id/versions` and
     `/admin/links/orphans`; the shells, `/d/:id/v/:n(/raw)`, and console
     Dashboard + Documents (`ConsoleTier` picks the nav). Credential surfaces
     (`/admin/agents*`, `/admin/keys*`, `/admin/oauth-clients*`), the audit
     ledger and backup stay `requireOperator` EVEN THOUGH some are reads —
     enumerating credentials is a step in an attack on the write path.
   - **`requireCurator`** (`src/serve-policy.ts`; operator OR agent, NEVER
     reader) gates `PUT /d/:id/tags` + `/status`, which upstream gates on
     `requireReader` — that would hand a read-only principal a mutation. Never
     re-point a write at `requireReader`, and never widen
     `authorizeOperatorForm` to the session resolver (every caller of that
     ladder is a mutation). Refusals are byte-identical to anonymous.
   - **Audit**: a failed `/login` files `login_failed` whichever tier was
     guessed; an operator sign-in files `login_succeeded`; a READER sign-in files
     nothing, because 0020's `principal_kind` CHECK has no reader value and
     filing it as the operator would make the ledger lie. Recording reader
     sign-ins needs a migration widening that CHECK (a known follow-up).
2. **`WRITER_AGENT_IDS`** (`[vars]`, comma-separated `agents.id`) restricts
   WRITE to the listed agents. Empty/unset = every agent writes — it fails OPEN
   on a typo so a config slip can't lock the publisher out (the reader secret
   fails the other way); verify an allowlist took effect rather than assuming.
   Enforced in the SHARED CORES: `publishDocumentCore` / `updateDocumentCore` /
   `editDocumentCore` (`src/document-write.ts`) and `setDocumentTagsCore` /
   `setDocumentStatusCore` (`src/document-lifecycle.ts`, which therefore take a
   REQUIRED `author`) all call `refuseNonWriter(env, author)` (`src/auth.ts`)
   FIRST — before any `await` or sanitize, so a refused agent can't burn CPU
   and the write route is no existence oracle. Failure = `403 read_only_agent`
   with `agent_id` (`readOnlyAgent` in `src/admin-response.ts`;
   `readOnlyAgentText` on MCP says don't retry or mint a key). Operator writes
   are never restricted; an ephemeral `create_publish_credential` key
   authenticates as the same agent, so it's covered by construction.

Both lists parse through `parseTokenList`; reader compares use the hardened
`timingSafeEqual` with NO early exit (`matchTokenInList`), so timing doesn't say
which reader matched. `test/authz-surface.test.mjs` classifies EVERY gated
handler (`mutate`/`credential` → operator-only, `read` → reader-admitting,
`curate` → `requireCurator`) with a completeness check that fails on an
unclassified one, and pins the write-core ordering and `read_only_agent` at every
door — add a row when you add a gated route.

## Browse by app + corpus stats

- Exact-match filters `app_package` / `doc_kind` / `company` on `GET /d`,
  `GET /admin/documents`, both search doors and MCP `list_documents` /
  `search_documents`. Parsed in `src/pagination.ts` (the two text filters
  normalize through the write-path validators; an unknown `doc_kind` is `400
  bad_request`); applied as bound predicates by `appendInsightFilters` in
  `src/document-listing.ts` for the list core and both search legs — one copy,
  like `documentPublicationClause`. They narrow, never grant.
- `GET /stats` (`documentStats` in `src/admin-documents.ts` →
  `corpusStatsCore`, sanitizer-free `src/stats.ts`): live totals,
  `by_app_package` (count DESC, top 500, truncation-flagged), `by_doc_kind`.
  `requireReader` and NEVER anonymous — it deliberately has no visibility
  predicate, so it counts private documents. CORS-eligible as a read.

## Dense teardown theme

`src/reader-theme.ts` (zero-import leaf) owns BOTH reading themes.
`READER_THEME_PREFIX` is upstream's prose theme extracted byte-for-byte (it also
fronts the bundled `/docs` pages via `platform-docs.ts`; the test pins that no
byte drifts). `DENSE_THEME_PREFIX` (~110rem, 14px/1.45, word-breaking cells,
wrapped cell `code`, sticky H2) is chosen by `readerThemePrefixForDocKind` for
`doc_kind` `teardown` / `teardown-section` only, read off the document row at
SERVE time in `serveRaw` / `serveVersionRaw` (a historical version follows the
parent's current kind). CSS edits therefore restyle the whole library with no
republish; HTML-sourced documents get neither theme.

## Sanitizer `ammonia-v1.8`

The fork's one allowlist widening (upstream is at v1.7): `data:image/{png,jpeg,
webp};base64,…` (payload ≤ 3,000,000 chars) on SVG `<image href|xlink:href>`
inside `<svg>` — so a screenshot can ride in a teardown. `data` is admitted to
ammonia's `url_schemes` (its scheme check runs before `attribute_filter`) and
then denied everywhere else in `attribute_filter`, detected with
`url::Url::parse` so whitespace/tab tricks can't slip past; `<image>` itself
takes nothing but that shape (no `http(s):`). Bare `<img src="data:…">` stays
stripped. Tests: the `image_*` cases in `sanitizer/src/lib.rs` and the
independent check in `sanitizer/tests/bypass_corpus.rs`. The stamp is part of
the no-op collapse key, so the next upstream sanitizer change must land as a
NEW stamp on this fork (v1.9+), never reuse upstream's number for different
bytes.

## `AUTO_SLUG_REDIRECT`

`[var]`; exactly `"true"` (read only through `autoSlugRedirect` in
`src/serve-retired-slug.ts`) turns the BROWSER click-through interstitial for a
retired slug with a `redirect_to` into a `308` to the target's canonical path
(`slugPermanentRedirect`). It runs AFTER the readability gate (an unreadable or
dangling target is still the plain 410 that never names it); credentialed
callers keep `409 slug_redirected` + `?follow_redirects=true`; setting a
cross-document redirect stays operator-only. The 308 is `no-store` +
`Vary: Cookie` on purpose: 308 is cacheable by default, and a cached hop would
outlive the operator clearing it or replay a reader's redirect after sign-out.
Kyle approved loosening the interstitial for this instance (QL-275 §7.3); the
upstream instance keeps it.
