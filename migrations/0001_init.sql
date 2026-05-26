-- agent-web-host initial schema.
-- Translates the data model in action-plan-v1.md from Postgres to SQLite (D1):
--   uuid        -> TEXT  (caller-generated, e.g. crypto.randomUUID())
--   timestamptz -> TEXT  (ISO-8601 UTC, e.g. strftime('%Y-%m-%dT%H:%M:%fZ','now'))
--   int         -> INTEGER

-- An agent is the principal that writes documents. One agent may hold many keys.
CREATE TABLE agents (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Hashed API keys. The full secret is HMAC-SHA-256 under a server pepper;
-- key_prefix is the indexed lookup so we can find the row without scanning.
-- revoked_at = null means active; setting it is the rogue-agent kill switch.
CREATE TABLE agent_keys (
  id          TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  key_prefix  TEXT NOT NULL,
  key_hash    TEXT NOT NULL,
  revoked_at  TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX agent_keys_key_prefix ON agent_keys (key_prefix);
CREATE INDEX agent_keys_agent_id   ON agent_keys (agent_id);

-- One document per logical URL. public_id is the capability: ≥128 bits of
-- CSPRNG output, non-enumerable, possession = read access.
-- current_ver points at the live version row; revoked_at set = 404 forever.
CREATE TABLE documents (
  id           TEXT PRIMARY KEY,
  public_id    TEXT NOT NULL UNIQUE,
  current_ver  INTEGER,
  created_by   TEXT REFERENCES agents(id) ON DELETE SET NULL,
  revoked_at   TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX documents_created_by ON documents (created_by);

-- Append-only version history. version_no is monotonic per document and
-- serves as the ETag. r2_key points at the sanitized bytes in R2;
-- sanitizer_v records which Ammonia profile produced this version.
CREATE TABLE versions (
  document_id  TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version_no   INTEGER NOT NULL,
  r2_key       TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL,
  sanitizer_v  TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (document_id, version_no)
);
