# Dynamic Client Registration (DCR) — design note

**Status: built (flagged on).** Enables the "just paste the MCP URL, no client_id" connect
flow for Claude / ChatGPT by exposing RFC 7591 dynamic client registration, gated behind a
build-time flag and composed with the existing unbound → bind-or-mint-at-consent path.

> Because `/register` is unauthenticated, **the operator consent screen is the entire human gate**
> — so it now renders judgeable client identity (callback address first, self-reported name marked
> as a claim). See [The consent screen carries client identity](#the-consent-screen-carries-client-identity-the-other-half-of-the-consent-gates-job).

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

**That safety argument is load-bearing on the consent screen, so the consent screen has to be
judgeable — see the next section.**

## The consent screen carries client identity (the other half of "the consent gate's job")

`/register` is unauthenticated and accepts public clients, so **anyone** can mint a `client_id`
with their own `redirect_uri`. Every sentence above that says "registration confers no authority,
the operator consent gate decides" cashes out at one screen — and for a while that screen showed
the operator **nothing about the client**: `renderConsent` named only the agent, and
`renderBindOrMint` said merely "This OAuth client isn't bound to an agent yet." The attack that
follows is short: self-register, mail the signed-in operator an `/authorize` link, and one "Allow"
click hands over an agent identity — read and overwrite authority over the whole single-tenant
corpus — on a card **visually identical** to the legitimate connect flow. The TOFU
`renderApproveCallback` card (which *does* show the host) never fires here, because a
self-registered client's `redirect_uri` **is** registered for it.

`renderClientIdentity` (`src/authorize.ts`) is now rendered on **all three** consent-shaped cards —
bound consent, bind-or-mint, and TOFU callback approval. What it shows, in this order, and why:

| Shown | Trust | Why it is where it is |
|---|---|---|
| **Callback address** (host, prominent; full URI below it) | **Unforgeable** | It is where the authorization code is *physically delivered*, and the provider matched it against this client's registered `redirect_uri`s. This is the ONLY thing on the page a hostile client cannot choose freely, so it leads. |
| Self-reported name (`clientName`) | **Attacker-chosen** | Rendered as a claim — *calls itself "…"*, italic + quoted, with a `self-reported` chip — never as a badge. A self-registered client can call itself "Claude", so styling the name as an identity assertion is theatre. |
| `client_id` | Neutral fact | Lets the operator correlate with `GET /admin/oauth-clients` / revoke the right record. |
| Registration age (`registrationDate`) | Neutral fact | A record created **seconds ago**, arrived at via a link, is the signature of this exact attack. Under 10 minutes it renders in red with that framing. (Both `/register` and `createClient` stamp this field, so it dates the record — it does **not** reveal which door made it.) |
| Client type (`tokenEndpointAuthMethod`) | Neutral fact | Labelled, never flagged: public/secretless is *required* for a native CLI (RFC 8252), so "public" is not a red flag. |

Deliberately **not** rendered: `logoUri`, `clientUri`, `tosUri`, `policyUri`. An attacker-supplied
image or outbound link is a phishing aid, not evidence (and the page's CSP is `default-src 'none'`).

**No per-vendor allowlist in the rendering path.** The card works by showing the host *whatever it
is* and letting the operator judge — a vendor list here would be a maintenance treadmill and would
teach the operator to trust the badge instead of the address. The three shapes render honestly:

| Callback shape | Rendered as |
|---|---|
| `https://claude.ai/…`, `https://chatgpt.com/…` | the host, prominent: *"the code will be sent to `chatgpt.com` over https"* |
| `http://127.0.0.1:PORT` / `localhost` / `[::1]` | *"an application on THIS machine"* — a loopback callback is a local handoff, not a network hop, and says so |
| `vscode:` / `cursor:` / … | *"whichever application on this machine has registered the `vscode:` URL scheme"* |

Hostile-input handling: `clientName` and `redirect_uri` are attacker-controlled, so every value
goes `displaySafe()` (NFC → strip C0/C1 + bidi overrides/isolates + zero-width/BOM → fold
whitespace → 500-char cap, with the cap **flagged** so a padded host can't hide its own tail) then
`escapeHtml()` at interpolation. Homograph hosts: WHATWG `URL.host` already yields the **punycode**
form, which is exactly what we want displayed (`xn--pple-43d.com` is unmistakably not `apple.com`),
and an `xn--` label additionally raises a "read this character by character" caution.

### What the operator is expected to check

1. **The callback address, first and last.** Did you start this connection, just now, from
   something that would legitimately receive a code *there*? A host you don't recognize is a stop,
   regardless of how the client names itself.
2. **Loopback means your own machine.** `127.0.0.1:PORT` is right for `claude mcp add` that you
   just ran, and wrong if you arrived from a link in a message.
3. **"Registered N seconds ago" + you didn't start a connect flow = deny.** That combination is the
   mailed-link attack.
4. **Ignore the name as evidence.** It is a string the client chose; a name matching a vendor you
   trust is not corroboration of anything.
5. Public/secretless is normal for CLI and desktop clients — do not treat it as a signal on its own.

Deny costs nothing (the operator can re-run the connect flow); allow hands over the whole corpus.

### Why a build-time flag, not a `[var]`

The provider is constructed at module-init (`export default wrapWithOAuth(innerHandler)` in
`src/index.ts:236`), before `env` exists — there is no runtime env to read at construction.
Toggling a `[var]` would also require a redeploy, so a documented constant next to the config
it gates costs nothing extra and keeps the security-relevant switch discoverable.

## Callback URLs: what we filter, and why `form-action` is deliberately broad

Three distinct mechanisms touch the OAuth callback. They're easy to conflate — and conflating
two of them is exactly what blocked native clients. Builders/forkers: know which is which before
tightening any of them.

| Layer | Where | Job | Load-bearing? |
|---|---|---|---|
| **Registered-`redirect_uri` exact match** | the OAuth library, per client | Every client declares its `redirect_uris`; `/authorize` matches the request against them. With S256 PKCE (`allowPlainPKCE: false`) + the operator consent screen, this is the actual defense against auth-code redirect theft. | **Yes — never weaken.** |
| **`APPROVABLE_CALLBACK_HOSTS` / `validateCallbackUri`** | `src/admin-oauth.ts` + `src/session.ts` | The narrow **https** vendor allowlist for the *TOFU inline-approval* repair (operator rubber-stamps an unregistered redirect host). | No — convenience repair. |
| **Consent CSP `form-action`** | `CONSENT_FORM_ACTION_SOURCES`, `src/authorize.ts` | Browser-side: which 302 targets the Allow form may navigate to. **Defense-in-depth, not the gate.** | No — but too narrow *silently breaks real connects.* |

The bug we shipped and fixed: `form-action` was *derived from* the vendor allowlist, so it only knew
https vendor hosts. A validly-registered native client (a CLI's `http://localhost:<port>`) then had
its post-grant 302 **blocked in-browser** even though the server issued the code — "302, then nothing."
`form-action` is now standalone and broad — `'self' https: http://localhost|127.0.0.1|[::1]:* vscode:
cursor: …`. Since the form can *only* 302 to a library-validated registered `redirect_uri`, allowing
the **shapes** gives up nothing: it just stops the browser second-guessing a target the real gate
already approved. It still blocks gross schemes (`javascript:`, `data:`).

**Client shapes you'll meet:**

| Shape | Examples | Needs |
|---|---|---|
| Fixed `https://` | claude.ai web, Cowork, ChatGPT, Claude Desktop | nothing extra (confidential; `https:` covers it) |
| Loopback `http://localhost\|127.0.0.1\|[::1]:*` | Claude Code CLI, custom CLI/SDK agents | public-DCR (above) + loopback in `form-action` (RFC 8252) |
| Custom scheme `vscode:`/`cursor:`/… | VS Code, Cursor, Antigravity (some builds) | the scheme in `CONSENT_FORM_ACTION_SOURCES` |

Rule of thumb: keep layer 1 strict, keep `form-action` broad enough for every legitimate shape, and
only ever make a *trust* decision by editing `APPROVABLE_CALLBACK_HOSTS` (the vendor list) — never by
narrowing `form-action`. (Whether an agent should be allowed *more than one* client at all is the
separate question in [GitHub issue #37](https://github.com/Skylled/slopcafe/issues/37).)

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
