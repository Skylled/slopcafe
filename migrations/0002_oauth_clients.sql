-- One OAuth client per agent-driven client. Created via
-- POST /admin/agents/:id/oauth-clients (operator-only). The companion
-- record lives in OAUTH_KV (the OAuthProvider's storage); this table is
-- our authoritative join back to the `agents` row that owns the client,
-- which `completeAuthorization` reads to stamp `props.agentId` so issued
-- tokens carry the agent identity through to /mcp tool calls.
--
-- One row per agent enforced by the unique constraint on agent_id below
-- (and by the 409 in the POST endpoint). To rotate, the operator calls
-- DELETE /admin/oauth-clients/:client_id (which cascades to live tokens
-- via OAUTH_PROVIDER.deleteClient) then re-issues. To kill the agent
-- entirely, DELETE /admin/agents/:id revokes every key and every OAuth
-- client in one operator call.
CREATE TABLE oauth_clients (
  client_id   TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL UNIQUE REFERENCES agents(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX oauth_clients_agent_id ON oauth_clients (agent_id);
