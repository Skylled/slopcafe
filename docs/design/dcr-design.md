# Dynamic Client Registration (DCR) — design note

**Status: built (flagged on).** Enables the "just paste the MCP URL, no client_id" connect
flow for Claude / ChatGPT by exposing RFC 7591 dynamic client registration, gated behind a
build-time flag and composed with the existing unbound → bind-or-mint-at-consent path.

## What changed

`src/oauth.ts` now passes the OAuthProvider its DCR options when `ENABLE_DCR` is true:

| Constant | Value | Purpose |
|---|---|---|
| `ENABLE_DCR` | `true` | Master switch. `false` → no `clientRegistrationEndpoint` → pre-registration-only (the prior behavior). |
| `DCR_REGISTRATION_ENDPOINT` | `/register` | Public registration endpoint; advertised as `registration_endpoint` in discovery metadata. |
| `DCR_CLIENT_TTL_SECONDS` | 90 days | Lifetime of a dynamically-registered client. **Absolute, not sliding** (see below). |
| `DISALLOW_PUBLIC_CLIENT_REGISTRATION` | `false` | Allow public (secretless, PKCE-only) clients. Required for native clients — see below. |

A dynamically-registered client writes **no `oauth_clients` D1 row**, so it is "unbound" by
the existing definition (absence of the row *is* unbound) and flows through the operator-gated
bind-or-mint card at `/authorize` with zero new code there. **DCR confers no authority** — it
only removes the manual client_id paste; the agent is still chosen at consent.

### Why public clients are allowed (`DISALLOW_PUBLIC_CLIENT_REGISTRATION = false`)

This started `true` (confidential-only) on the assumption that every connector — Claude, ChatGPT
— registers as a confidential client. That holds for the **web/desktop claude.ai connector**, but
not for a **native CLI**: **Claude Code's** `claude mcp add --transport http https://…/mcp` path
registers as a *public* client (`token_endpoint_auth_method: "none"`) because a CLI has nowhere
safe to store a secret. Confidential-only DCR therefore rejected the CLI connect with
`invalid_client_metadata` → "Public client registration is not allowed" (`oauth-provider.js:1908`),
so the only client the `true` setting ever excluded was the one we now want to support. Flipped to
`false` so the friendly-named CLI connector (`mcp__<name>__…` instead of the UUID-prefixed account
connector) can self-register.

Allowing public clients is safe in this single-operator model: registration still confers no
authority (the operator consent gate binds the agent and authorizes tokens, regardless of client
category), and a public client's code exchange is protected by **mandatory S256 PKCE**
(`allowPlainPKCE: false`) — public + PKCE is the sanctioned pattern for native apps (RFC 8252). The
confidential-only setting bought no real security here; it only blocked a legitimate native client.

### Why a build-time flag, not a `[var]`

The provider is constructed at module-init (`export default wrapWithOAuth(innerHandler)` in
`src/index.ts:236`), before `env` exists — there is no runtime env to read at construction.
Toggling a `[var]` would also require a redeploy, so a documented constant next to the config
it gates costs nothing extra and keeps the security-relevant switch discoverable.

## The 90-day TTL is an absolute ceiling, not idle cleanup

This is the load-bearing, easy-to-misread fact. There are two independent expiry clocks:

| Clock | Default | Behavior | Bites when |
|---|---|---|---|
| refresh-token TTL | 30 days | **sliding** — every refresh resets `grantData.expiresAt = now + ttl` (`oauth-provider.js:1294-1299`) | connector sits idle 30 days |
| `clientRegistrationTTL` | 90 days | **absolute from registration** — the client KV record's `expirationTtl` is set once at register (`oauth-provider.js:1945`) and is *not* re-written on refresh (only `updateClient` re-applies it) | 90 days after first connect, **even if used daily** |

When the client record lapses, the next token refresh calls `getClient` → null → `401
invalid_client` "Client not found" *before it even reads the grant* (`oauth-provider.js:1011-1015`).
Since `accessTokenTTL` is 900s, Claude refreshes every ~15 min of use, so the connector dies
within minutes of the TTL passing. We chose 90 days as a self-purging backstop against the
*public* `/register` endpoint accumulating junk registrations, accepting ~quarterly re-auth on a
continuously-used DCR connector.

## Operator guidance: which connector uses which path

- **Permanent connector you don't want to re-auth (e.g. Claude):** do **not** use DCR. Mint a
  client via `POST /admin/oauth-clients` (`createClient`, which is **immune** to
  `clientRegistrationTTL` per the library) and paste its `client_id` + `client_secret`. No
  90-day dance.
- **Convenience / rarely-used connector (e.g. ChatGPT):** DCR is fine — paste the URL, register
  automatically, re-auth roughly every 90 days when it happens to be in use.

## Deferred — [RESEARCH NEEDED]: smooth the expired-client experience

When a DCR client hits the 90-day ceiling the user gets a hard `invalid_client` and must
re-authenticate, with no graceful prompt. We want to **explore what actually happens on the
client side at expiry** (does Claude/ChatGPT auto-re-register and only need a re-consent click,
or does it require a full manual remove/re-add?) and, if possible, **smooth it into a re-consent
flow** — ideally a near-seamless "approve again" rather than a teardown. Open questions:

- Does the connector auto-trigger discovery + re-registration on `invalid_client`, or surface a
  dead-connector error to the user?
- Could the server detect a soon-to-expire client and proactively extend it via `updateClient`
  during an authenticated refresh (turning the absolute TTL into an effective sliding one for
  *consented* clients, while still purging never-consented junk)? This would need the refresh
  path to call `updateClient` — not currently done by the library.
- Is a "re-consent" screen (recognize the returning client, skip straight to allow) worth
  building, vs. just lengthening / removing the TTL for consented clients?

Not in scope for the initial DCR landing.
