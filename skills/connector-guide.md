# Wiring an agent up to agent-web-host

This guide is for the **operator** standing up a connector that lets an agent (Claude / Cowork today, Antigravity tomorrow) publish documents to this service. It's not for a model author or a connector-library implementer — it's for the human running `wrangler deploy`.

There are two transports the worker accepts on `/mcp`:

1. **OAuth 2.1 + PKCE** — the only transport in production use today. Hosted Claude and Cowork mint a short-lived access token through this flow and present it on `/mcp`. This is the path you'll wire up 99% of the time.
2. **Static `awh_` bearer** — also wired into `/mcp` (via `resolveExternalToken` in `src/oauth.ts`), but in practice we use this only for shell scripts and CI jobs that hit `POST /d`, `PUT /d/:id`, etc. directly. Not for MCP clients.

Antigravity is the planned next addition. See [Antigravity (planned)](#antigravity-planned) at the bottom.

---

## Path 1: Cowork (current reality)

End state: an agent shows up in Cowork's connector list with the Slopcafe tools (`publish_document`, `update_document`, etc.) and uses them without ever seeing an API key.

### Step 1 — mint an OAuth client for the agent

Pre-registration only; the worker does not expose a public Dynamic Client Registration endpoint (`clientRegistrationEndpoint` is unset in `src/oauth.ts`). You hit the operator-only endpoint to create exactly one client per agent.

```sh
curl -X POST "https://slopcafe.com/admin/agents/<agent-uuid>/oauth-clients" \
  -H "authorization: Bearer ${OPERATOR_TOKEN}"
```

Response (201):

```json
{
  "client_id": "...",
  "client_secret": "...",
  "mcp_url": "https://slopcafe.com/mcp",
  "agent_id": "<uuid>",
  "agent_name": "...",
  "note": "store client_secret now — it is never returned again."
}
```

**Capture `client_secret` immediately.** It's only returned once. If you lose it, `DELETE /admin/oauth-clients/<client_id>` and mint a new one — losing the secret is recoverable, just noisy.

The redirect URI is **hardcoded** in `src/admin-oauth.ts`:

```
https://claude.ai/api/mcp/auth_callback
```

This is fine for hosted Claude (web, mobile, Cowork) — they all funnel through the same Anthropic callback. It is **not** fine for any other client (Cursor, Antigravity, a custom desktop app), because the OAuth provider enforces strict redirect-URI matching. See [Antigravity (planned)](#antigravity-planned) for what changes when we add a second redirect.

One OAuth client per agent. Calling the mint endpoint twice for the same agent returns 409 `client_exists` with the existing `client_id`. Rotate with `DELETE /admin/oauth-clients/<client_id>` then re-mint.

### Step 2 — paste the three values into Cowork

In Cowork: **Customize → Connectors → + → Add custom connector**. Fill in:

| Field | Value |
|---|---|
| Server URL | `mcp_url` from the response |
| Client ID | `client_id` |
| Client Secret | `client_secret` |

Cowork starts the OAuth handshake. The user is sent to `/authorize` on the worker.

### Step 3 — approve at the worker's consent screen

`/authorize` is a single-operator consent page (see `src/authorize.ts`). It shows the agent's name and asks for `OPERATOR_TOKEN`. Submit with **Allow** and the worker calls `OAUTH_PROVIDER.completeAuthorization`, pinning `props.agentId` for every token issued under this client.

Access tokens are 15 minutes (`accessTokenTTL: 900` in `src/oauth.ts`) with refresh tokens; Cowork rotates them transparently.

That's the whole flow. The model now sees Slopcafe's tools in Cowork's tool list with no awareness of a key.

### What's actually happening on `/mcp`

The OAuth provider wraps the worker (`wrapWithOAuth` in `src/oauth.ts`). On every `/mcp` request it tries the OAuth path first: validate the bearer against `OAUTH_KV`, look up `props.agentId` from the grant, dispatch into `apiHandler` (which is the same `innerHandler` as `defaultHandler`) with `ctx.props` populated. If no valid OAuth token is present, `resolveExternalToken` runs — it accepts an `awh_` bearer as a fallback (Door B, see Path 2). Either way the MCP tool handlers see `props.agentId` and stamp provenance on writes.

### Rotation and revocation

- **Rotate the OAuth client** (compromise, refresh) — `DELETE /admin/oauth-clients/<client_id>` invalidates every live token via `OAUTH_KV` cascade (see `OAUTH_PROVIDER.deleteClient` in `@cloudflare/workers-oauth-provider`). Then re-mint and re-paste into Cowork. There's no overlap window — Cowork will hit 401 until the new client is wired up.
- **Kill the whole agent** — `DELETE /admin/agents/<agent-uuid>` cascades to both the OAuth client and any `awh_` keys (`revokeAgent` in `src/admin.ts`). Use this when the agent identity itself shouldn't exist anymore.
- 15-minute TTL is the fallback if any of the above partial-fails. The provider checks token validity against KV on every request; nothing is cached at the worker layer.

---

## Path 2: `awh_` bearer for HTTP scripting

Use this when you want to drive the service from a shell script, a CI job, or a tiny one-off Python script — not from a model. The `awh_` bearer goes on `Authorization: Bearer ...` for either the raw HTTP endpoints (`POST /d`, `PUT /d/:id`, `GET /d/:id`) or, technically, `/mcp` (via `resolveExternalToken`), though there's no reason to use it on `/mcp` in practice.

### Mint a key

```sh
curl -X POST "https://slopcafe.com/admin/agents/<agent-uuid>/keys" \
  -H "authorization: Bearer ${OPERATOR_TOKEN}"
```

Response includes `awh_<prefix>.<secret>`. Same one-shot-secret rule: capture it now, you won't see it again.

### Test it

```sh
export AGENT_WEB_HOST_URL=https://slopcafe.com
export AGENT_WEB_HOST_KEY=awh_<prefix>.<secret>

# Publish
curl -s -X POST "$AGENT_WEB_HOST_URL/d" \
  -H "authorization: Bearer $AGENT_WEB_HOST_KEY" \
  -H 'content-type: text/html' \
  --data '<h1>connector smoke test</h1>'

# Read it back
curl -s "$AGENT_WEB_HOST_URL/d/<public_id>" \
  -H "authorization: Bearer $AGENT_WEB_HOST_KEY"
```

### When this is the right tool

- A scheduled job that publishes a daily report.
- A migration script that batch-publishes archived content.
- Local debugging where standing up the OAuth flow would be overhead.
- Anywhere the credential lives in env, not in a user-facing connector config.

### When it's the wrong tool

- Anywhere a model sees it. The key should never enter the conversation. If you're authoring a connector, use Path 1.
- Anywhere a non-operator might see the URL it produces. The `awh_` key is fleet-wide — any active key can read or write any doc.

### Rotation

`DELETE /admin/keys/<key-id>` revokes a single key (see `revokeKey` in `src/admin.ts`); `DELETE /admin/agents/<agent-uuid>` revokes the whole agent and all its keys. The worker checks D1 on every request — revocation is instant.

---

## Antigravity (planned)

Google's Antigravity IDE / CLI speaks MCP natively and supports both stdio and Streamable HTTP transports. It would be the most plausible second OAuth client after Cowork.

Wiring it up needs **two small changes** to the worker:

1. **Add Antigravity's redirect URI to the allowlist.** Today `ANTHROPIC_CALLBACK` in `src/admin-oauth.ts` is hardcoded to `https://claude.ai/api/mcp/auth_callback`. The OAuth provider enforces strict matching, so any other client (Cursor, Antigravity, VS Code) fails the handshake. The minimum change is a `redirect_uri` parameter on `POST /admin/agents/:id/oauth-clients` (defaulting to the Anthropic URL for backward compatibility) and persisting one client per `(agent, surface)` pair instead of per agent.
2. **Decide whether Antigravity uses OAuth or `awh_` first.** Antigravity supports OAuth 2.0 for remote MCP servers (`oauth` sub-object in its server config), but the OAuth-first path requires solving (1) first. As an interim, Antigravity also supports a `headers` field for static bearers — so an `awh_` key in `headers.Authorization: Bearer awh_...` works today without any worker change. Trade-off: the key is in the user's `mcp_config.json`, which is fine for a single-operator setup but doesn't generalize.

Once (1) ships, the operator flow is identical to Cowork: mint a client (with `redirect_uri` set to Antigravity's callback), paste `client_id` / `client_secret` / `mcp_url` into Antigravity's `mcp_config.json`, and the handshake runs the same `/authorize` consent page.

Two Antigravity-specific gotchas worth knowing in advance, sourced from the live install guides for other MCP servers:

- **Antigravity uses `serverUrl`, not `url`**, for HTTP-based MCP servers in `mcp_config.json`. This is the single most common copy-paste failure when bringing in a config that works in Cursor or VS Code.
- The `mcp_config.json` path is `~/.gemini/config/mcp_config.json` (macOS/Linux) or `C:\Users\<USER>\.gemini\config\mcp_config.json` (Windows) — distinct from the Gemini CLI's `~/.gemini/settings.json`. (Earlier Antigravity builds used `~/.gemini/antigravity/`; current builds use `~/.gemini/config/`.)

There's a longer-form treatment of all three Gemini surfaces (Antigravity, Gemini CLI, `google-genai` API) at the [Gemini connector guide on Slopcafe](https://slopcafe.com/s/gemini-connector-guide). When the worker changes for Antigravity land, fold the relevant parts of that doc into this section.

---

## Security notes (both paths)

- **Sanitization is server-side, not client-side.** Don't pre-filter HTML in a connector — the worker sanitizes on every write, and double-sanitization can produce subtly different output than a single pass. The `modified` flag in the response is your signal that something changed.
- **`public_id` is the capability.** When the model returns a URL to the user, that URL grants read access to anyone who sees it. A slug, when a document has one, is also a capability — a deliberately *weaker*, guessable one: `GET /s/<slug>` returns a 302 to the same shell page, no auth needed. Most documents have no slug and are reachable only by their unguessable `public_id`.
- **Don't log request bodies or `Authorization` headers.** Agent output can contain content the user didn't intend to ship to disk. Log tool name + status code; that's it.
- **Read access bypasses the connector.** A `read_document` call hits the same `GET /d/:id` endpoint a human's browser would; the only difference is the `Authorization` header. The URL secret is the access control, not the connector.

## Error mapping for connector-side translation

If you're translating worker responses into model-facing text in your own connector (the MCP server in `src/mcp.ts` already does this for you), this is the shape:

| Status | When | What to surface to the model |
|---|---|---|
| 401 | Bad/revoked token | "connector misconfigured" — don't ask the model to fix |
| 404 | Doc missing/revoked, `public_id` malformed | "no such document" |
| 409 | Slug collision | "slug taken — pick a different one" |
| 412 | `If-Match` version mismatch on PUT | "version conflict: current is vN, you sent vM; refetch and retry" |
| 413 | Body > 5 MiB or fleet quota | "too large or over quota" |
| 415 | Wrong `Content-Type` | Connector bug — `text/html` or `text/markdown` required |
| 422 | `invalid_slug` charset/length | "slug shape invalid: {reason}" — model can retry |
| 428 | PUT without `If-Match` | Connector bug — always send `If-Match` |
| 500 | Unexpected | Retry once; if persistent, alert the operator |

The 412 path is the only one the model needs to handle on its own. The 4xx values that are "connector bugs" should be surfaced to the operator in logs, not to the model — there's nothing the model can do about them.

---

## Where each file in this folder fits

- **`publishing.md`** is the agent-facing HTTP contract (the wire shape, the sanitizer allowlist, the metadata fields). Bundled as the `awh://publishing-guide` MCP resource. Keep in sync with the sanitizer.
- **`connector-guide.md`** (this file) is the operator-facing wire-up doc. Keep it grounded in what's actually deployed.
- **`README.md`** is the index.

If a future connector path lands (Antigravity, Cursor, native desktop), this is the file that grows. `publishing.md` doesn't change unless the wire protocol changes.
