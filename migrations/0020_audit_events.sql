-- Migration 0020: `audit_events` — the append-only operator audit ledger
-- (GitHub issue #62).
--
-- WHAT WAS MISSING. Every security-relevant act on this deployment was either
-- invisible or visible only in `wrangler tail` for as long as a log line lives.
-- A DCR self-registration (`POST /register`) is the motivating case: anyone may
-- register a client, and until now that left NO trace anywhere — not in D1, not
-- in R2, and not in `oauth_clients` (a DCR client is deliberately unbound). The
-- consent screen is the human gate, but nothing recorded that the gate had been
-- reached, by which client, or what the operator decided. Same for the operator
-- session: a failed `/login` is exactly the event an operator wants a history
-- of, and it produced nothing durable.
--
-- SUBSTRATE: D1, not Workers Analytics Engine. AE would be a new binding (a tax
-- on every forker) and is sampled/aggregate by design; this ledger wants EXACT
-- rows the operator can list, filter, page and carry in a backup. The volume is
-- bounded by operator actions and auth failures, not by traffic — successful
-- tool calls and document reads are deliberately NOT recorded (that is traffic,
-- and Workers Logs already have it).
--
-- APPEND-ONLY. Nothing in the code updates or deletes a row here. There is no
-- retention sweep in v1; if one is ever wanted it joins the pattern
-- `POST /admin/keys/prune` already established (an explicit operator verb with a
-- mode and an age gate), never a trigger and never an automatic TTL.
--
-- BEST-EFFORT, NEVER BLOCKING. The writer (src/audit.ts) schedules its single
-- INSERT through `ctx.waitUntil` AFTER the request's real work has committed,
-- and swallows + logs any failure — exactly the posture vector sync takes, and
-- for the same reason: an audit write is DERIVED state. A lost row is
-- acceptable; a publish that fails because the ledger was briefly unavailable is
-- not. (The alternative — refuse the write when the ledger cannot be written —
-- was considered and explicitly declined on issue #62.) This is also why the
-- table carries no foreign keys: it must be writable even when the row it
-- describes is in the middle of being deleted, and it must SURVIVE that
-- deletion. Deleting a client, revoking an agent or purging a document must not
-- rewrite what the ledger says happened — the same reasoning migration 0019
-- gives for `versions.author_client_id` having no FK.
--
-- COLUMNS.
--   id              — UUID (newUuid()). Primary key, and the cursor tiebreaker.
--   at              — ISO-8601 with milliseconds, in D1's exact stored shape
--                     (`strftime('%Y-%m-%dT%H:%M:%fZ','now')`), so the `since=`
--                     filter's lexicographic `>=` is a chronological compare —
--                     the same rule `documents.updated_at` (0017) follows.
--   kind            — CHECK-pinned enum, one value per v1 event. The list is
--                     mirrored by `AuditKindSchema` in src/contract.ts and the
--                     two are pinned against each other by test/audit.test.mjs,
--                     so adding a kind in code without a migration fails the
--                     build instead of failing the INSERT at runtime.
--   principal_kind  — who acted: 'operator' | 'agent' | 'anonymous' | 'client'.
--                     'anonymous' is the honest answer for an unauthenticated
--                     actor (a failed login, a DCR registration, a rejected
--                     token exchange) — the ledger records that SOMEONE did it,
--                     never a guess at who.
--   agent_id        — `agents.id` when an agent is implicated. NULL otherwise.
--   client_id       — the OAuth `client_id` (0019's grain) when one is in play.
--                     NULL for Door B, the operator, and every non-OAuth event.
--   key_id          — `agent_keys.id` for a mint/revoke. NULL otherwise. This
--                     is an opaque row identifier, NOT a credential: the key
--                     material itself is never written here or anywhere else.
--   document_id     — the document's PUBLIC id, deliberately not `documents.id`.
--                     The ledger is read by a human holding a URL, and the
--                     public id keeps meaning after the row it names is revoked
--                     and its bytes purged; the internal UUID would require a
--                     join to a row that may no longer resolve.
--   outcome         — 'ok' | 'denied' | 'error'. Fixed per kind by the writer's
--                     typed union, so it can never disagree with the event.
--   detail          — a SMALL JSON object of scalar context (a version number, a
--                     visibility value, a slug, a prune count). It is assembled
--                     by the typed writer from named scalar fields — there is no
--                     API by which a caller can hand the ledger a free-form
--                     object, which is how the never-log list below is enforced
--                     BY CONSTRUCTION rather than by review.
--   request_id      — the edge's `cf-ray` when a Request was in hand (the outer
--                     observe-only layer, the /mcp dispatch, /login,
--                     /authorize). NULL from inside a core, which sees no
--                     Request. Correlates a ledger row with a Workers Logs line.
--
-- NEVER WRITTEN HERE, at any grain: minted keys or client secrets,
-- OPERATOR_TOKEN, session cookies or CSRF nonces, request bodies, document
-- content, Authorization headers, PKCE verifiers or authorization codes. The
-- writer's union has no field that could carry any of them, and
-- test/audit.test.mjs walks the union's field names to keep it that way.
--
-- INDEX. `(at DESC, id DESC)` is the exact ordering + tiebreaker shape every
-- other cursor-paginated list in this schema uses (see 0017's
-- `documents_updated_at`). D1 stamps to milliseconds, so ties under a burst of
-- writes are real and the `id` tiebreaker is mandatory — without it a cursor
-- could skip a row at a page boundary. It also serves the `since=` range scan.
-- The `kind` / `agent_id` / `document_id` filters ride this index's scan rather
-- than earning their own: they are equality narrowings on a table an operator
-- reads interactively, not a query shape anything polls.

CREATE TABLE audit_events (
  id             TEXT PRIMARY KEY,
  at             TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN (
                   'client_registered',
                   'token_issued',
                   'token_denied',
                   'mcp_auth_failed',
                   'consent_allowed',
                   'consent_denied',
                   'oauth_client_bound',
                   'callback_approved',
                   'login_succeeded',
                   'login_failed',
                   'agent_key_minted',
                   'agent_key_revoked',
                   'agent_keys_pruned',
                   'agent_revoked',
                   'oauth_client_minted',
                   'oauth_client_deleted',
                   'document_revoked',
                   'document_visibility_changed',
                   'document_promoted',
                   'slug_redirect_set',
                   'slug_redirect_cleared',
                   'slug_released',
                   'write_conflict',
                   'slug_locked'
                 )),
  principal_kind TEXT NOT NULL CHECK (principal_kind IN ('operator', 'agent', 'anonymous', 'client')),
  agent_id       TEXT,
  client_id      TEXT,
  key_id         TEXT,
  document_id    TEXT,
  outcome        TEXT NOT NULL CHECK (outcome IN ('ok', 'denied', 'error')),
  detail         TEXT,
  request_id     TEXT
);

CREATE INDEX audit_events_at ON audit_events (at DESC, id DESC);
