-- migrations/0021_oauth_clients_multi.sql
--
-- Allow N OAuth clients per agent by dropping UNIQUE(agent_id) on `oauth_clients`
-- (QL-808 / unblocked by migration 0019 `versions.author_client_id`).
--
-- WHY THIS WAS BLOCKED BEFORE AND IS SAFE NOW.
-- Migration 0002 enforced `UNIQUE(agent_id)` because `versions` did not record
-- which OAuth client authored a write: binding two clients to one agent made
-- their writes indistinguishable in provenance. Migration 0019 added
-- `versions.author_client_id`, stamped from the provider-validated
-- `authReq.clientId` at consent. Every Door A version now carries per-client
-- attribution independently of `oauth_clients`.
--
-- WHAT THIS FIXES.
--   1. Reconnecting Claude or ChatGPT via DCR after expiry/reinstall binds the
--      new `client_id` to the existing logical agent without hitting a 409
--      collision on `UNIQUE(agent_id)` (and `/authorize` also auto-evicts dead
--      KV ghost rows and offers an optional "replace existing" toggle).
--   2. Multiple surfaces for one agent (Claude Web, Claude Desktop, Claude Code
--      CLI) can coexist under one logical agent while remaining individually
--      attributable (`versions.author_client_id`) and individually revocable
--      (`DELETE /admin/oauth-clients/:client_id`).
--
-- REBUILD NOTES.
-- SQLite cannot DROP a table-level/column-level UNIQUE constraint in place, so
-- we rebuild `oauth_clients`, preserving:
--   - `client_id TEXT PRIMARY KEY`
--   - `agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE`
--   - `created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`
--   - `CREATE INDEX oauth_clients_agent_id ON oauth_clients (agent_id)`
-- No other table holds a foreign key referencing `oauth_clients` (0019 and 0020
-- deliberately store `client_id` without an FK so audit history survives
-- client deletion), so `DROP TABLE oauth_clients` runs cleanly under
-- `foreign_keys = ON`.

CREATE TABLE _oauth_clients_new (
  client_id   TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO _oauth_clients_new (client_id, agent_id, created_at)
  SELECT client_id, agent_id, created_at FROM oauth_clients;

DROP TABLE oauth_clients;

ALTER TABLE _oauth_clients_new RENAME TO oauth_clients;

CREATE INDEX oauth_clients_agent_id ON oauth_clients (agent_id);
