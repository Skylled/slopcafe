# Wiring an agent up to Slopcafe

This guide is for the **operator** standing up a connector that lets an agent (Claude / Cowork today, Antigravity tomorrow) publish documents to this service. It's not for a model author or a connector-library implementer — it's for the human running `wrangler deploy`.

There are two transports the worker accepts on `/mcp`:

1. **OAuth 2.1 + PKCE** — the transport every MCP client uses: hosted Claude/Cowork, ChatGPT, **and native clients** like the Claude Code CLI or an IDE. A client can **self-register via DCR** (paste only the MCP URL — no operator-minted `client_id`) or you can **pre-mint** a client for finer control. This is the path you'll wire up 99% of the time.
2. **Static `awh_` bearer** — also wired into `/mcp` (via `resolveExternalToken` in `src/oauth.ts`), but in practice we use this only for shell scripts and CI jobs that hit `POST /d`, `PUT /d/:id`, etc. directly. Not for MCP clients.

> **One OAuth client = one agent.** A connector binds to exactly one agent (`oauth_clients.agent_id` is `UNIQUE`). Mint or pick a **fresh agent per connector** — binding a *second* connector to an agent that already has one returns `409 "that agent is already bound to another OAuth client."` This is deliberate (clean provenance + independent revoke); see [Troubleshooting the OAuth connect](#troubleshooting-the-oauth-connect).

Two connector families get walkthroughs below: **hosted** (Cowork/web/ChatGPT — [Path 1](#path-1-cowork-current-reality)) and **native CLI / IDE** ([Native CLI & IDE clients](#native-cli--ide-clients)). Antigravity specifics are at the [bottom](#antigravity).

---

## Path 1: Cowork (current reality)

End state: an agent shows up in Cowork's connector list with the Slopcafe tools (`publish_document`, `update_document`, etc.) and uses them without ever seeing an API key.

### Step 1 — mint an OAuth client for the agent

> **Note — DCR is on now.** You don't *have* to pre-mint. `ENABLE_DCR` is `true` in `src/oauth.ts`, so a client handed only the MCP URL self-registers (RFC 7591). Hosted connectors and native clients both take that path — see [Native CLI & IDE clients](#native-cli--ide-clients). Pre-minting (this section) is still useful for a **permanent** client (DCR clients carry a 90-day TTL and re-auth after) or when you want to control the `client_secret` yourself.

To pre-mint, hit the operator-only endpoint to create exactly one client per agent:

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

A freshly-minted client is registered with just the Anthropic callback:

```
https://claude.ai/api/mcp/auth_callback
```

That covers hosted Claude (web, mobile, Cowork). For any **other** client (ChatGPT, Cursor, a custom desktop app) the OAuth provider enforces strict redirect-URI matching, so the connector's own callback won't match — but you no longer have to re-mint or hand-edit anything. Two inline options at the `/authorize` consent screen, both operator-gated:

- **Approve the callback inline (TOFU).** When a known client sends an unregistered **https** `redirect_uri`, a logged-in operator sees an *Approve callback* card and registers it with one click. Restricted to an allowlist of approvable **hosts** — `APPROVABLE_CALLBACK_HOSTS` in `src/admin-oauth.ts`, currently `claude.ai`, `claude.com`, `chatgpt.com` (https-only, via `validateCallbackUri`). Adding a *host* (a new vendor) is a deliberate one-line edit there; adding a *path* on an already-trusted host is just the inline click. **Note:** this allowlist is *not* what governs the post-grant redirect in the browser — that's the consent-page CSP `form-action` (`CONSENT_FORM_ACTION_SOURCES` in `src/authorize.ts`), which is deliberately broad (`https:` + loopback + IDE schemes) and decoupled from this list. The two were coupled once, and that coupling is what silently blocked native clients (see [Troubleshooting](#troubleshooting-the-oauth-connect)).
- **Bind the agent at consent.** Mint an *unbound* client with `POST /admin/oauth-clients` (no agent in the path), paste it into the connector, and pick or mint the agent on the `/authorize` screen the first time it connects — handy when you want to provision the connector before deciding its identity.

If you hit `/authorize` before logging in, the page offers a *Log in as operator* link that returns you to the same in-flight request after sign-in.

One OAuth client per agent. Calling the bound mint endpoint twice for the same agent returns 409 `client_exists` with the existing `client_id`. Rotate with `DELETE /admin/oauth-clients/<client_id>` then re-mint.

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

## Native CLI & IDE clients

A **native** client runs on your own machine (the Claude Code CLI, an IDE like VS Code / Cursor / Antigravity) and completes OAuth through a **loopback** (`http://localhost:<port>/callback`, RFC 8252) or a **custom-scheme** (`vscode://…`) callback instead of a hosted https one. The payoff over the hosted account connector: the tools get a **human-readable prefix** you choose — `mcp__slopcafe__publish_document` instead of `mcp__<uuid>__publish_document`.

### Claude Code CLI — the reference flow

```sh
# -s user = available in every project; pick any name for the prefix.
claude mcp add -s user --transport http slopcafe https://slopcafe.com/mcp
```

Then in a Claude Code session: `/mcp` → `slopcafe` → **Authenticate** → browser opens → **Allow** at the consent screen. No `client_id` to paste — the CLI **self-registers via DCR** and rides the bind-or-mint-at-consent path. At consent, **mint a fresh agent** (e.g. "Claude Code") — don't pick an agent that already has a connector, or you'll hit the [409](#troubleshooting-the-oauth-connect).

A CLI/project-added server pointing at the same URL **takes precedence over and hides** the `claude.ai` account connector, so you won't get duplicate tools — `/mcp` marks the account one hidden. (Reverse with `claude mcp remove -s user slopcafe`.)

### What makes native clients work (forkers: don't break these)

Native clients exercise a code path hosted connectors never do — two server-side settings are load-bearing, and tightening either silently breaks the connect with no server error in the logs:

1. **Public DCR clients must be allowed** — `DISALLOW_PUBLIC_CLIENT_REGISTRATION = false` in `src/oauth.ts`. A CLI can't hold a secret, so it registers as a *public* (PKCE-only) client. With this `true`, DCR returns *"Public client registration is not allowed."*
2. **`form-action` must permit the callback shape** — `CONSENT_FORM_ACTION_SOURCES` in `src/authorize.ts` lists `https:` + `http://localhost|127.0.0.1|[::1]:*` + IDE schemes. CSP `form-action` is enforced on the post-grant 302, so a missing shape makes the browser **silently refuse** to deliver the issued code to the listener (symptom: "302, then nothing"). This is *defense-in-depth, not the gate* — the real protection is the per-client registered-redirect match + PKCE + your consent — so it's intentionally broad.

### IDE clients

Same flow; the callback is often a **custom URI scheme** (`vscode://`, `cursor://`) rather than loopback. Those schemes are pre-listed in `CONSENT_FORM_ACTION_SOURCES`. **Onboarding an IDE with a scheme not in that list?** Add it there (only) — the OAuth library still independently validates the client's registered `redirect_uri`, so this is the one place a new scheme needs a line. Config-key gotchas vary per IDE (e.g. Antigravity wants `serverUrl`, not `url`) — see [Antigravity](#antigravity).

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

## Antigravity

Google's Antigravity IDE / CLI speaks MCP natively (stdio + Streamable HTTP). It's just another **native client** — the [Native CLI & IDE clients](#native-cli--ide-clients) path above already covers it, with **no per-vendor worker change** for the callback anymore.

- **Callback.** Antigravity's redirect is a loopback or `https://` callback (some builds use a custom scheme). Loopback and `https:` are already in `CONSENT_FORM_ACTION_SOURCES`; if a build uses a custom scheme not listed there, add that one scheme in `src/authorize.ts`. You do **not** touch `APPROVABLE_CALLBACK_HOSTS` for this — that list is only the https TOFU vendor allowlist, not the callback gate.
- **OAuth vs `awh_`.** Antigravity supports OAuth 2.0 for remote MCP servers (`oauth` sub-object) — point it at `https://slopcafe.com/mcp`, let it self-register via DCR, and bind a **fresh agent** at consent (one client per agent). As an interim it also accepts a static bearer via a `headers` field — `headers.Authorization: Bearer awh_...` works with no worker change, at the cost of the key living in `mcp_config.json` (fine single-operator, doesn't generalize).

Two Antigravity-specific gotchas worth knowing in advance, sourced from the live install guides for other MCP servers:

- **Antigravity uses `serverUrl`, not `url`**, for HTTP-based MCP servers in `mcp_config.json`. This is the single most common copy-paste failure when bringing in a config that works in Cursor or VS Code.
- The `mcp_config.json` path is `~/.gemini/config/mcp_config.json` (macOS/Linux) or `C:\Users\<USER>\.gemini\config\mcp_config.json` (Windows) — distinct from the Gemini CLI's `~/.gemini/settings.json`. (Earlier Antigravity builds used `~/.gemini/antigravity/`; current builds use `~/.gemini/config/`.)

There's a longer-form treatment of all three Gemini surfaces (Antigravity, Gemini CLI, `google-genai` API) at the [Gemini connector guide on Slopcafe](https://slopcafe.com/s/gemini-connector-guide). When the worker changes for Antigravity land, fold the relevant parts of that doc into this section.

---

## Troubleshooting the OAuth connect

These are the failure modes a native/CLI/IDE connect hits — each one cost real debugging time the first time, all are server-side and need a **deploy** after the fix:

| Symptom / error | Cause | Fix |
|---|---|---|
| **`Public client registration is not allowed`** (during *Authenticate* / DCR) | The server rejects secretless **public** clients, but a native CLI can only *be* public — it has nowhere to keep a secret. | `DISALLOW_PUBLIC_CLIENT_REGISTRATION = false` in `src/oauth.ts` (already the default) + deploy. |
| **`409 that agent is already bound to another OAuth client`** (at *Allow*) | One OAuth client per agent (`oauth_clients.agent_id` UNIQUE); you picked an agent that already has a connector. | At consent, **mint a new agent** — one per connector. To *move* a connector onto an existing agent instead, first `DELETE /admin/oauth-clients/<client_id>` for the old one (this breaks that old connector). |
| **"302, then nothing"** — DevTools shows the consent POST returning `302` but the terminal/IDE never completes | The consent-page CSP `form-action` doesn't list the client's callback **shape** (loopback / custom scheme), so the browser **blocks the post-grant redirect** even though the code was issued. Confirm: DevTools **Console** shows `Refused to send form data … violates … "form-action"`. | Add the shape to `CONSENT_FORM_ACTION_SOURCES` in `src/authorize.ts` + deploy. `https:`, all-loopback, and `vscode:`/`cursor:`/`windsurf:` ship by default. |
| **The mint-or-bind card reappears on *every* Authenticate** | Almost always downstream of one of the above: because the callback never completed, the client never received tokens, so it re-registers from scratch each retry. | Fix the underlying connect (rows above). Once one flow completes end-to-end, the client + tokens persist and the prompts stop. |
| **Connected, but tools show a UUID prefix** (`mcp__<uuid>__…`) | You're on the `claude.ai` **account connector**, not a CLI/project-added one. | `claude mcp add -s user --transport http <name> <url>` then authenticate — the local entry takes precedence and hides the account connector, giving you `mcp__<name>__…`. |

Two flow-level tips: don't **refresh or reuse** an old consent tab (each Authenticate spins up a one-shot loopback listener on a fresh port — only the tab it just opened is valid), and don't **dawdle** (that listener times out). If a fresh, prompt pass still dies at the 302, grab the 302's `Location` header — its `<port>` should match the port the terminal is actually listening on.

## Security notes (both paths)

- **Sanitization is server-side, not client-side.** Don't pre-filter HTML in a connector — the worker sanitizes on every write, and double-sanitization can produce subtly different output than a single pass. The `modified` flag in the response is your signal that something changed.
- **`public_id` is the capability.** When the model returns a URL to the user, that URL grants read access to anyone who sees it. A slug, when a document has one, is also a capability — a deliberately *weaker*, guessable one: `GET /s/<slug>` serves the same shell page directly (the slug stays in the address bar), no auth needed. Most documents have no slug and are reachable only by their unguessable `public_id`.
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
