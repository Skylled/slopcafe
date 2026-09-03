# Operating Slopcafe

This is the **operator's day-to-day guide** — how to run a deployed Slopcafe
instance: mint agents and keys, connect AI assistants, publish
and manage documents, and keep the lights on. Every task here is shown **two ways**:

- **In the browser** — the no-JS **operator console** at `/admin/console` (plus the
  per-document **manage page**). Friendly, clickable, no `curl` required.
- **From the terminal** — the **admin API** over `curl`. Scriptable, automatable, and
  the only path for a couple of advanced tasks.

Pick whichever fits the moment; they call the exact same code underneath. For the
exhaustive request/response contract (every field, every status code), see
[`http-api.md`](http-api.md). For one-time provisioning, see
[`cloudflare-setup.md`](cloudflare-setup.md).

Throughout, `<BASE>` is your deployment's origin — `https://slopcafe.com`, or
`https://slopcafe.<subdomain>.workers.dev` if you're on the free URL.

## Contents

- [Two ways to operate](#two-ways-to-operate)
- [Sign in (and out) of the console](#sign-in-and-out-of-the-console)
- [Agents and keys](#agents-and-keys)
- [Connect a hosted Claude / Cowork assistant](#connect-a-hosted-claude--cowork-assistant)
- [Connect a CLI or IDE (native client)](#connect-a-cli-or-ide-native-client)
- [Browse and search documents](#browse-and-search-documents)
- [Publish a document yourself](#publish-a-document-yourself)
- [Manage a single document](#manage-a-single-document)
- [Retired links and redirects](#retired-links-and-redirects)
- [Maintenance: semantic-search backfill](#maintenance-semantic-search-backfill)
- [Maintenance: link-graph backfill](#maintenance-link-graph-backfill)
- [Maintenance: pruning expired/revoked agent keys](#maintenance-pruning-expiredrevoked-agent-keys)
- [Maintenance: is the on-platform doc mirror fresh?](#maintenance-is-the-on-platform-doc-mirror-fresh)
- [Maintenance: rate limiting the credential-guessing surfaces](#maintenance-rate-limiting-the-credential-guessing-surfaces)
- [Maintenance: edge rules for the MCP surface (SEP-2243 headers)](#maintenance-edge-rules-for-the-mcp-surface-sep-2243-headers)
- [At a glance: the dashboard](#at-a-glance-the-dashboard)

## Two ways to operate

**The web console** lives under `/admin/console` (typing the bare `/admin` redirects
there). It's a server-rendered, no-JavaScript admin UI with four sections —
**Dashboard**, **Agents**, **Documents**, **Maintenance** — plus a per-document
**Manage** page. You sign in once with your operator token and a cookie keeps you
logged in. Best for browsing, one-off actions, and anything you'd rather click than
type.

**The admin API** is plain HTTP under `/admin/*` (and a few operator routes on
`/d/:id`), authenticated with your `OPERATOR_TOKEN` as a Bearer token. Best for
scripts, automation, and the few advanced tasks the console doesn't surface (operator
authoring, slug redirects).

To use the curl examples, set two shell variables once:

```sh
BASE=https://slopcafe.com               # your deployment origin
OP="Bearer $OPERATOR_TOKEN"             # the operator token from setup
```

> **One token, two uses.** The same `OPERATOR_TOKEN` you set as a secret during
> [setup](cloudflare-setup.md#8-set-the-two-production-secrets) is both your console
> sign-in password and your API Bearer token. Keep it safe — anyone with it controls
> the whole deployment.

## Sign in (and out) of the console

**In the browser.** Visit `<BASE>/admin` (or `<BASE>/admin/console`). A logged-out
visitor gets a small **sign-in card** — paste your operator token and submit. That
sets a signed, HttpOnly session cookie (plus a CSRF cookie), and you stay logged in
across the console. The topbar shows the four sections; on a document page it also
shows a **Public/Private** badge and a **Manage…** menu item.

To **sign out**, use the sign-out control (it POSTs to `/logout` behind a confirm).
You can also log *every* operator session out at once two ways:

- **Bump `SESSION_EPOCH`** in `wrangler.toml` (e.g. `"1"` → `"2"`) and redeploy — the
  cheap "log everyone out" lever, no secret rotation.
- **Rotate `OPERATOR_TOKEN`** (`npx wrangler secret put OPERATOR_TOKEN`) — also ends
  every session, since the session signing key is derived from the token.

**From the terminal.** There's no "login" — every admin call just carries the token:

```sh
curl -s "$BASE/admin/agents" -H "authorization: $OP" | jq .
```

The browser session and the Bearer token are independent doors onto the same operator
check. Scripts use the Bearer token and are unaffected by `SESSION_EPOCH` or browser
sign-outs.

## Agents and keys

An **agent** is an identity that publishes documents; each agent has one or more
**keys** (`awh_…` bearer tokens) it authenticates with. A freshly minted key (and
OAuth client secret) is shown **exactly once** — capture it immediately; it's never
logged or recoverable.

### Mint an agent (with its first key)

**Console.** **Agents** → **Mint agent** → give it a name → submit. The new key is
shown once in a disclosure card. Copy it now.

**curl:**

```sh
curl -s -X POST "$BASE/admin/agents" \
  -H "authorization: $OP" -H 'content-type: application/json' \
  -d '{"name":"my-first-agent"}'
# → { agent_id, key_id, key: "awh_<prefix>.<secret>", ... }   ← key shown once
```

### Mint an additional key for an existing agent

Useful for key rotation, or giving one agent a second credential.

**Console.** **Agents** → click the agent → **API keys** → **Mint key**.

**curl:**

```sh
curl -s -X POST "$BASE/admin/agents/$AGENT_ID/keys" -H "authorization: $OP"
# → { key_id, key: "awh_...", ... }
```

### Rotate a key

Mint a new key, roll it into the agent's deployment, verify it works, **then** revoke
the old one — so there's no downtime:

```sh
curl -s -X POST "$BASE/admin/agents/$AGENT_ID/keys" -H "authorization: $OP"   # new key
# ... deploy + verify the new key ...
curl -s -X DELETE "$BASE/admin/keys/$OLD_KEY_ID" -H "authorization: $OP"      # kill old
```

### Revoke a single key

The auth check hits the database on every request, so revocation is instant — the
next request signed by that key gets `401`.

**Console.** **Agents** → the agent → **API keys** → **Revoke** on that key's row.

**curl:**

```sh
# List keys to find the key_id (prefixes only, never secrets):
curl -s "$BASE/admin/agents/$AGENT_ID/keys" -H "authorization: $OP"
curl -s -X DELETE "$BASE/admin/keys/$KEY_ID" -H "authorization: $OP"
```

Revoked (and expired) keys stay as inert rows unless you clean them up — see
[Maintenance: pruning expired/revoked agent keys](#maintenance-pruning-expiredrevoked-agent-keys).

### Kill an entire agent (both doors at once)

For "this agent is compromised / decommissioned — kill everything." This **cascades**:
it revokes every key **and** deletes every OAuth client for the agent.

**Console.** **Agents** → the agent → **Danger zone** → **Revoke agent**.

**curl:**

```sh
curl -s -X DELETE "$BASE/admin/agents/$AGENT_ID" -H "authorization: $OP"
# → { revoked: true, keys_revoked: N, oauth_clients_deleted: M }
```

For ordinary rotation, prefer the narrower per-key / per-client revokes above — those
leave the agent alive.

## Connect a hosted Claude / Cowork assistant

Hosted Claude (claude.ai web/mobile, Cowork) and ChatGPT can't paste a static bearer
token — they connect over **OAuth 2.1 + PKCE**. So instead of an `awh_` key you mint
an **OAuth client** for the agent, then approve it once at a consent screen. (For the
full connector walkthrough on the *assistant's* side, see
[`../skills/connector-guide.md`](../skills/connector-guide.md); this section covers the
*operator's* one-time mint.)

A **bound** client is pinned to one agent (the usual case). An **unbound** client lets
you choose the agent at consent time — handy when one connector should be able to act
as different agents.

### Mint an OAuth client

**Console.** **Agents** → the agent → **OAuth clients (bound)** → **Mint bound
client** (or **Mint unbound client**). The `client_secret` is shown once.

**curl** (bound, pinned to one agent):

```sh
curl -s -X POST "$BASE/admin/agents/$AGENT_ID/oauth-clients" -H "authorization: $OP"
# → { client_id, client_secret, mcp_url, ... }   ← client_secret shown once
```

**curl** (unbound, agent chosen at consent):

```sh
curl -s -X POST "$BASE/admin/oauth-clients" -H "authorization: $OP"
```

### Wire it into the assistant

1. In Claude → **Customize → Connectors → + → Add custom connector**.
2. **URL:** paste `mcp_url` (`<BASE>/mcp`). **Advanced settings:** paste `client_id`
   and `client_secret`. **Add**, then **Connect**.
3. The worker shows a small consent page. Enter your `OPERATOR_TOKEN` and click
   **Allow** (for an unbound client, also pick or mint the agent here). The connector
   now shows as connected.
4. Enable it per-conversation via **+ → Connectors**.

To revoke a connector later: **curl** `DELETE "$BASE/admin/oauth-clients/$CLIENT_ID"`
(handles both bound and unbound), or delete it from the agent's OAuth-clients section
in the console.

> **Gemini / scripts use the other door.** Anything that *can* hold a static bearer
> just uses an `awh_` key (the [Agents and keys](#agents-and-keys) flow) — no OAuth.

## Connect a CLI or IDE (native client)

A **native** client — the Claude Code CLI, or an IDE like VS Code / Cursor / Antigravity
— runs on your machine and OAuths through a loopback (`http://localhost:<port>`) or
custom-scheme callback. Unlike a hosted connector, **you don't mint anything**: it
self-registers via DCR (no `client_id` to paste), and you get a tool-name prefix you
choose (`mcp__slopcafe__…` instead of the account connector's UUID).

Claude Code, end to end:

```sh
claude mcp add -s user --transport http slopcafe https://slopcafe.com/mcp
# then in a session:  /mcp → slopcafe → Authenticate → Allow (in the browser)
```

At the consent screen, **mint a fresh agent** (e.g. "Claude Code") — one OAuth client
binds to exactly one agent, so reusing an agent that already has a connector returns a
`409`. A locally-added server also **hides** the matching `claude.ai` account connector,
so you won't see duplicate tools.

If a native connect misbehaves — *"Public client registration is not allowed"*, a
`409 already bound`, or the browser **302s and nothing happens** — those are the three
known failure modes, each with a one-line cause/fix in
[`../skills/connector-guide.md` → Troubleshooting](../skills/connector-guide.md#troubleshooting-the-oauth-connect).

## Browse and search documents

**Console.** **Documents** lists the whole fleet, newest first, each row tagged with a
**Public/Private** badge. The search box runs hybrid keyword + semantic search; you
can also filter with `?q=`, `?tag=`, `?slug=`, and (issue #57) **Visibility** /
**Publication** dropdowns — the same `visibility`/`publication` filters the API takes,
wired to `<select>`s instead of a raw query string. Composing `visibility=public` +
`publication=pending` is the **review queue** — the public documents whose readers
are seeing older bytes than the fleet has written — and there's a one-click
**Review queue →** link above the filters (and on the Dashboard) that jumps straight
there.

**curl** — list (cursor-paginated, newest first):

```sh
curl -s "$BASE/admin/documents" -H "authorization: $OP" | jq .
# add ?limit=N (1–200, default 50) and ?cursor=<opaque> to page;
# the response's next_cursor (or null) drives the next page.
```

**curl** — one document, by id. The detail twin of the list: same row, same
fields, no paging wrapper.

```sh
curl -s "$BASE/admin/documents/<public_id>" -H "authorization: $OP" | jq .
# The row comes back BARE (not wrapped in a "documents" array). REVOKED documents
# are returned here too, exactly as the list reports them — revoked_at set, and
# current_ver/published_ver/slug/title/sizes all null — so a list→detail drill-down
# never dead-ends on a row the list just showed you.
```

**curl** — "what changed lately?" The list has a second ordering: `?order=updated`
walks `updated_at` instead of `created_at`, so a row moves to the top on **any**
change — a new version, a retag/rename/visibility/status edit that bumps no
version, or a revoke. `?updated_since=<ISO-8601>` windows it (inclusive), which
together make the list a change feed you can poll:

```sh
curl -s "$BASE/admin/documents?order=updated&updated_since=2026-07-01T00:00:00Z&limit=200" \
  -H "authorization: $OP" | jq '.documents[] | {slug, updated_at, current_version_at}'
# hand the newest updated_at you saw back as updated_since on the next poll.
```

Two gotchas worth knowing before you script it. A **cursor remembers the ordering
that minted it**: paging an `order=updated` walk without repeating `order=updated`
fails loudly with `bad_cursor` rather than silently walking a different sort. And
documents that existed before the `updated_at` column shipped were backfilled from
their current version's write time, so a *classification* change made before that
migration under-reports — the first change after it corrects the row for good.

**curl** — hybrid search (keyword + semantic, ranked, not paginated):

```sh
curl -s "$BASE/admin/documents/search?q=onboarding+checklist" -H "authorization: $OP" | jq .
# &mode=hybrid (default) | keyword | semantic ; &tag= &slug= &limit= also apply
# &updated_since= applies too; there's no &order= — relevance IS the ordering.
```

Inspect one document's storage and version sizes straight from D1:

```sh
npx wrangler d1 execute META --remote --command \
  "SELECT d.public_id, d.current_ver, d.revoked_at,
          (SELECT json_group_array(json_object('v',version_no,'size',size_bytes))
             FROM versions WHERE document_id = d.id) AS versions
     FROM documents d WHERE d.public_id = '<id>'"
```

## Publish a document yourself

Usually documents come from agents. But you can author one **as the operator** — it's
recorded with `created_by_kind: "operator"`, not as a fake agent.

> **This one is curl-only.** The console doesn't have an operator publish form —
> browser-based authoring is the agent/MCP path. Operator authoring is the JSON admin
> door.

**Publish** (`POST /admin/documents`) — JSON body, `format` required:

```sh
curl -s -X POST "$BASE/admin/documents" \
  -H "authorization: $OP" -H 'content-type: application/json' \
  -d '{"content":"# Hello\n\nFrom the operator.","format":"markdown","title":"Hello","visibility":"public"}'
# → 201 { public_id, url, version: 1, ... }
```

`format` is `"html"` or `"markdown"` (required). `title`/`description`/`tags`/`slug`
are optional; `visibility` is **birth-only** here (omit it and the doc is born at your
`DEFAULT_DOCUMENT_VISIBILITY`, normally `private` — see
[Manage a single document](#manage-a-single-document) to flip it later).

**Update** (`PUT /admin/documents/:public_id`) — same fields minus `visibility`; an
omitted field inherits the prior value, `""` clears it. `If-Match` is **optional**
here (last-write-wins if omitted — the app-friendly divergence from the agent
`PUT /d/:id`, which requires it):

```sh
curl -s -X PUT "$BASE/admin/documents/$PUBLIC_ID" \
  -H "authorization: $OP" -H 'content-type: application/json' \
  -d '{"content":"# Hello (v2)","format":"markdown"}'
```

> **Big files? Use the byte-exact path.** Regenerating a large body (tens of KB) as a
> JSON `content` argument is slow and truncation-prone. For exact-bytes publishing of
> a file on disk, mint a short-lived key and `PUT` it raw with an integrity hash —
> see the recipe in [the docs index](README.md#published-copy-read-it-on-slopcafe) and
> the rationale in
> [`design/byte-exact-publish-design.md`](design/byte-exact-publish-design.md).

## Manage a single document

The per-document **manage page** folds every per-document operator action onto one
screen. Open it at `<BASE>/d/<public_id>/manage` (or click **Manage…** in a
document's topbar while signed in). A logged-out visitor gets a sign-in prompt
rendered without touching the database, so it reveals nothing about the document —
not even whether it exists.

Its sections, in page order — and their curl twins:

### Visibility (public / private)

Controls whether anonymous browsers can see the document **at all**. Private docs
`404` to the public web but still serve to you and to agent keys. No version bump.

Visibility is only half the story: it decides *whether* a document is reachable,
while **publication** (below) decides *which version* a reachable one serves.
Making a document public does not hand agents the ability to publish — they can
write new versions, and none of them reach readers until you promote one.

Flipping to public publishes what is current, unless you staged a version first
(`published_ver = published_ver ?? current_ver`). If you did stage one earlier
and the document has moved on since, the Manage page warns you before the flip,
naming the version that is about to go live.

**Console.** Manage page → **Visibility** → toggle.

**curl:**

```sh
curl -s -X POST "$BASE/admin/documents/$PUBLIC_ID/visibility" \
  -H "authorization: $OP" -H 'content-type: application/json' \
  -d '{"visibility":"public"}'
# → { public_id, visibility: "public" }
```

### Custom link (slug)

Add, rename, or clear the pretty `/s/<slug>` handle. A **rename auto-forwards** the
old name; a **clear** retires it (slugs are never reused — see
[Retired links](#retired-links-and-redirects)). No version bump.

**Console.** Manage page → **Custom link** → set / rename / clear.

**curl:**

```sh
curl -s -X POST "$BASE/admin/documents/$PUBLIC_ID/slug" \
  -H "authorization: $OP" -H 'content-type: application/json' \
  -d '{"slug":"north-island-report"}'      # "" clears it
# → { public_id, slug, retired, redirected }
```

### Lifecycle status (deprecate / reactivate)

Mark a document **deprecated** when it's superseded but shouldn't be killed: it
keeps rendering and keeps ranking in search (marked in each hit), but **context
packs skip it by default**, so it can't brief an agent on stale truth. The
optional `superseded_by` names the replacement document (readers are pointed at
it loudly — nothing auto-follows). No version bump; reversible.

**Console.** Manage page → **Status** → *Mark deprecated* (optionally fill in
the replacement's public_id) / *Mark active*.

**curl:**

```sh
curl -s -X POST "$BASE/admin/documents/$PUBLIC_ID/status" \
  -H "authorization: $OP" -H 'content-type: application/json' \
  -d '{"status":"deprecated","superseded_by":"<replacement public_id>"}'
# → { public_id, status: "deprecated", superseded_by }
# reactivate (clears superseded_by):
#   -d '{"status":"active"}'
```

### Tags

Full-replace the document's tags (classification, document-level). The supplied set
becomes the tags outright; `[]` clears them. No version bump.

**Console.** Manage page → **Tags** → comma-separated list → save.

**curl** (note: the API takes a JSON **array**):

```sh
curl -s -X POST "$BASE/admin/documents/$PUBLIC_ID/tags" \
  -H "authorization: $OP" -H 'content-type: application/json' \
  -d '{"tags":["metrics","q2"]}'
# → { public_id, tags: ["metrics","q2"] }
```

> **Agents can do these two themselves.** Tags and status also sit on the agent
> door as `PUT /d/<public_id>/tags` and `PUT /d/<public_id>/status` — same body,
> same core, same response, reachable with an agent key (or your operator token)
> — and over MCP as the `set_document_tags` / `set_document_status` tools, so a
> connector agent can reclassify its own work without dropping to HTTP.
> That's not a widening: an agent key already replaces any document's entire
> content, so reclassifying one grants strictly less. **Visibility and revoke stay
> operator-only** — visibility is the line between "private to the fleet" and
> "readable by the anonymous internet", and revoke is irreversible. So an agent
> maintaining its own corpus can deprecate its superseded work without waiting on
> you, and you keep the two decisions that leave the fleet.

### Link graph (backlinks + broken links)

The manage page's **Link graph** panel shows both directions of the document's
wiki neighborhood: **Referenced by** (live documents whose current version links
here) and **Outbound** (this document's own on-platform links, each resolved to
what it serves *now* — a live target, a loud redirect after a rename, or a dead
link: retired / revoked / missing). It's read-only — fixing a broken link means
editing the *source* document.

**curl** (agent keys work here too — it's a credentialed read, like `/text`):

```sh
curl -s "$BASE/d/$PUBLIC_ID/links" -H "authorization: $OP"
# → { public_id, backlinks: [DocumentListing…], outbound: [{kind, value, state, …}…] }
```

Documents published before the link graph shipped have no rows until you run the
[link-graph backfill](#maintenance-link-graph-backfill).

### Version history + restore

Every version's bytes are retained until the document is revoked, so you can view any
past version and **restore** it. Restore re-publishes that version's content as a
**new** version (it never rewinds the version counter), keeping the current slug.

**Console.** Manage page → **Version history** → **View** a version, or **Restore** any
non-current one. (Restore is operator-only — there's no agent restore; agents can read
history via MCP but not roll back.)

**curl** — both have JSON twins, so a scripted operator client never has to scrape
the page:

```sh
# History: newest first, capped at the 200 most recent, no cursor.
curl -s "$BASE/admin/documents/$PUBLIC_ID/versions" -H "authorization: $OP" | jq .
# → { public_id, current_ver, versions: [ { version_no, created_at, size_bytes,
#      source_present, author_kind, author_name, author_client_id, is_current,
#      is_published, source_sha256, … } ] }
#   is_published marks the version a PUBLIC document actually renders;
#   source_sha256 lets a script find the version matching a local file;
#   author_client_id names the OAuth client that authorized the write (null for
#   your own writes, a static awh_ key, or a version predating the column) — it
#   is the only way to tell two connectors bound to one agent apart, and it is
#   also the Client column on the Manage page's history table.

# Restore version 2 AS A NEW VERSION (never a rewind of the counter):
curl -s -X POST "$BASE/admin/documents/$PUBLIC_ID/restore" \
  -H "authorization: $OP" -H 'content-type: application/json' \
  -d '{"version":2}'
# → the ordinary write response plus restored_from: 2
```

A pre-retention legacy version with no retained source shows "no source" instead of a
Restore button (`source_present: false` in the JSON), and restoring it fails with
`source_unavailable` — deliberately, with no fall-back to its rendered HTML. Such a
doc is revoke-and-republish, not restore.

### Publication (which version the public sees)

A **public** document renders the version you **published**, not the newest one an
agent wrote. Agents write freely; nothing they write reaches anonymous readers
until you promote it. This is the control that makes "only the operator decides
what the world reads" true in effect and not just of the visibility flag — see
[security-model.md](security-model.md).

Private documents ignore this entirely and always render their newest version, so
your own drafting loop never needs a promote step.

**Finding the backlog across the whole fleet** (issue #57) — promote itself is
per-document (below), but knowing *which* documents owe you one used to mean
walking the whole corpus and comparing pointers by hand. `visibility=public` +
`publication=pending` composed is the **review queue**; the Dashboard's
**pending promotion** count and the Documents page's **Review queue →** link
(both under [Browse and search documents](#browse-and-search-documents)) both
land on it in one click, or reach it directly with:

```sh
curl -s "$BASE/admin/documents?visibility=public&publication=pending" \
  -H "authorization: $OP" | jq '.documents[] | {public_id, slug, current_ver, published_ver}'
```

**Console.** Manage page → **Version history** → **Publish** on the row you want.
The publish status line above the table names the currently published version and
flags when newer work is waiting.

**curl:**

```sh
# Publish version 3 — what /d/:id, /d/:id/raw and /s/:slug will serve.
curl -s -X POST "$BASE/admin/documents/$PUBLIC_ID/promote" \
  -H "authorization: $OP" -H 'content-type: application/json' \
  -d '{"version":3}'
# → { public_id, published_ver: 3 }
# 404 with a `version` field in the body = no such version (vs. no such document).

# Is anything waiting for THIS document? Compare the two pointers on its listing row:
curl -s "$BASE/d?slug=$SLUG" -H "authorization: $OP" \
  | jq '.documents[0] | {current_ver, published_ver, visibility}'
```

No version bump, and it stamps `updated_at` so a change feed sees it. Promoting a
**private** document is allowed and is how you stage a choice before making it
public. There is deliberately **no agent-reachable promote** — it is the verb that
expands what the anonymous internet can read, so it sits with visibility and
revoke rather than with tags and status.

Version history is an **operator** axis, not a visibility one: a public document's
history is exactly as operator-only as a private one's, and everyone else gets the
same opaque `404`.

### Revoke (delete)

Irreversible: flips `revoked_at`, purges the R2 bytes (both the render and its
retained source), and retires the slug forever. Subsequent reads `404` within
milliseconds — the kill lands in the database *before* the purge starts, so it's
real even if R2 is having a bad day.

**Console.** Manage page → **Revoke**.

**curl:**

```sh
curl -s -X DELETE "$BASE/d/$PUBLIC_ID" -H "authorization: $OP"
# → { revoked: true, r2_objects_purged: N }
```

> **Revoke is idempotent — and that's the recovery path.** If the purge fails
> partway (it's chunked under R2's 1000-keys-per-call limit and a failure throws),
> just issue the same `DELETE` again: an already-revoked document answers `200` and
> **re-runs the purge**, without re-stamping `revoked_at`. It used to answer `404`,
> which told you a retry was pointless while unsanitized source bytes stayed
> resident forever. Only an unknown `public_id` is a `404` now.

## Retired links and redirects

When a slug is renamed away from or a document is revoked, that slug is **retired** —
reserved forever so a shared `/s/<slug>` link can never silently start serving
unrelated content. A retired slug normally returns **410 Gone**. Two operator escape
hatches let you change that — **curl-only** (no console UI):

**Redirect a retired slug** to a live document (the "this name moved" case — a rename
or consolidation, without *reusing* the name):

```sh
curl -s -X POST "$BASE/admin/slugs/$SLUG/redirect" \
  -H "authorization: $OP" -H 'content-type: application/json' \
  -d '{"target_public_id":"<22-char public_id>"}'
# → { slug, redirect_to, target_slug, target_title }
```

`/s/<slug>` then forwards **loudly** (a browser interstitial; agents must opt in with
`follow_redirects`) instead of `410`ing.

**Drop a redirect** (back to a plain `410`, slug stays retired):

```sh
curl -s -X DELETE "$BASE/admin/slugs/$SLUG/redirect" -H "authorization: $OP"
```

**Force-release a retired slug** (the *only* un-retire path — returns the name to the
pool so a future publish can claim it again; for the genuine "revoked by mistake"
case):

```sh
curl -s -X DELETE "$BASE/admin/slugs/$SLUG" -H "authorization: $OP"
# → { released: true, slug }
```

## Maintenance: semantic-search backfill

Semantic search relies on a vector index that's synced **best-effort** after each
write. Most of the time it self-heals on the next write, but for write-once content a
dropped sync can linger — so there's a manual backfill. Run it after a bulk import, or
once if you enabled semantic search on an already-populated deployment.

**Console.** **Maintenance** → **Vectorize backfill** → pick a mode → **Run backfill**.
On a large fleet it runs page-by-page; a **Continue** button appears when there's more.

- **Missing** (incremental) — embeds only documents not yet in the index. The usual
  heal.
- **Rebuild** (all) — re-embeds every live document. Use after a model/chunk change,
  or to repair suspected staleness.

**curl** (resumable — re-invoke with the returned `next_cursor` until it's `null`):

```sh
curl -s -X POST "$BASE/admin/vectors/backfill?mode=missing" -H "authorization: $OP"
# → { mode, scanned, embedded, vectors, skipped, next_cursor }
# more pages? re-run with &cursor=<next_cursor>.  mode=rebuild re-embeds everything.
```

## Maintenance: link-graph backfill

The link graph (backlinks, broken-link states, orphan detection) is synced
atomically on every write, so it never lags — but documents published **before**
the graph shipped have no rows. Run the backfill once after deploying the
feature, or any time to reconcile; it's idempotent (it re-extracts every live
document's links from the stored render).

**Console.** **Maintenance** → **Link-graph backfill** → **Run links backfill**.
Page-by-page with a **Continue** button, like the Vectorize backfill.

**curl** (resumable — re-invoke with the returned `next_cursor` until it's `null`):

```sh
curl -s -X POST "$BASE/admin/links/backfill" -H "authorization: $OP"
# → { scanned, updated, links, next_cursor }
```

**Orphans** — live documents nothing links to (a curation worklist, not an error
list; a doc you only share by URL is a fine orphan). curl-only:

```sh
curl -s "$BASE/admin/links/orphans" -H "authorization: $OP"
# → { documents: [DocumentListing…] }   (newest first, capped at 200)
```

## Maintenance: pruning expired/revoked agent keys

Two classes of `agent_keys` rows linger forever unless you clean them up (issue
#13): short-lived publish credentials (`create_publish_credential`, ≤60 min
TTL) once they lapse, and keys you've revoked. **Neither authenticates** —
`authenticateAgent` already rejects an expired or revoked key — so this is
housekeeping against table growth, not a correctness fix. Nothing else
references `agent_keys` by foreign key, so pruning is a plain, safe delete.

The two classes are pruned by different rules, on purpose — they don't carry
the same audit value:

- **Expired** — machine-minted, self-revoking, fungible. Deleted the moment
  `expires_at` is in the past. **No age gate.**
- **Revoked** — a deliberate operator security action, kept as audit trail on
  purpose. Only pruned once older than a number of days **you** choose
  (`older_than_days`, required, minimum 1) — there's no sane default for "how
  long should a revoke stay explainable in an incident review."

**Console.** **Maintenance** → **Prune agent keys** → pick a mode → (for
`revoked`, set "Older than (days)") → optionally check **Dry run** to see the
count first → **Run prune**.

**curl:**

```sh
# Dry run first — see how many would go, without deleting anything:
curl -s -X POST "$BASE/admin/keys/prune" \
  -H "authorization: $OP" -H 'content-type: application/json' \
  -d '{"mode":"expired","dry_run":true}'
# → { mode: "expired", dry_run: true, matched: 42, deleted: 0 }

# Then the real run:
curl -s -X POST "$BASE/admin/keys/prune" \
  -H "authorization: $OP" -H 'content-type: application/json' \
  -d '{"mode":"expired"}'
# → { mode: "expired", dry_run: false, matched: 42, deleted: 42 }

# Revoked keys need an age gate:
curl -s -X POST "$BASE/admin/keys/prune" \
  -H "authorization: $OP" -H 'content-type: application/json' \
  -d '{"mode":"revoked","older_than_days":90}'
```

No cursor and no pages — a prune is a single `DELETE … WHERE …` statement, so
one call handles the whole match.

## Maintenance: is the on-platform doc mirror fresh?

*(Only relevant if your deployment mirrors this repo's documentation onto itself —
the Slopcafe instance does. Skip this section if you don't publish repo docs as
documents.)*

The reference corpus in `docs/` (plus `skills/publishing.md`) needs no operating
at all: it is **compiled into the Worker** and served at `/docs/<name>`, so the
pages on your deployment are built from the commit your deployment is running
([issue #4](https://github.com/Skylled/slopcafe/issues/4)). There is no second
copy, so there is nothing to re-publish, promote, or check for drift — the old
mirror and drift detector are both gone, replaced by `scripts/build-docs.mjs`.
Editing a doc means editing the file and deploying; `npm test` fails if the
committed bundle is stale, and `predeploy` rebuilds it either way.

Two of those docs — the publishing guide and the HTTP quickstart — are *also*
published into the corpus as documents, because MCP tool descriptions tell agents
to read them and an agent has no way to fetch an HTTP route. That seeding is
automatic and idempotent. To run it immediately and see what happened:

```sh
curl -X POST -H "Authorization: Bearer $OPERATOR_TOKEN" \
  https://slopcafe.com/admin/docs/seed
```

Each doc reports `created`, `updated`, `unchanged`, `blocked` or `failed`. The
one that needs you is **`blocked`**: it means the reserved slug is retired (a
tombstone), and the seeder will not release one on its own — slugs are never
silently reclaimed. Release it deliberately and re-run:

```sh
curl -X DELETE -H "Authorization: Bearer $OPERATOR_TOKEN" \
  https://slopcafe.com/admin/slugs/slopcafe-docs-publishing-guide
```

Nothing is down while a doc is blocked: `/docs/<name>` serves it either way.
Only the corpus copy an MCP agent reads is missing.

**Upgrading from the old mirror.** If your deployment published the docs corpus
as documents before this change, those rows are still there, still public, and
now unmaintained — nothing updates them, and an agent searching the corpus finds
both them and the bundled pages. Revoke each one, then release its tombstone if
you want the name free again:

```sh
curl -X DELETE -H "Authorization: Bearer $OPERATOR_TOKEN" https://slopcafe.com/d/<public_id>
curl -X DELETE -H "Authorization: Bearer $OPERATOR_TOKEN" https://slopcafe.com/admin/slugs/<slug>
```

Do the homepage (or any other page linking to those slugs) first, or it will
point at 404s in between.

Which docs are bundled, and under what route names, is
[`../scripts/platform-docs.json`](../scripts/platform-docs.json);
[the docs index](README.md#reading-these-docs-on-the-deployed-instance) has the
full description.

## Maintenance: rate limiting the credential-guessing surfaces

*(A Cloudflare-dashboard task, not a Slopcafe one — there's no `/admin/*` route
or console panel for this. The Worker keeps no durable per-IP state to throttle
`POST /login` guesses in code, so the control lives at Cloudflare's edge
instead of in `src/`.)*

Set up once during
[provisioning](cloudflare-setup.md#13-rate-limiting-the-credential-guessing-surfaces-recommended)
— one WAF rate limiting rule throttling `POST /login` (and, if DCR is on,
`POST /register`) by source IP. Re-check it after anything that touches your
zone: a Cloudflare plan change (the free tier's one-rule quota grows on
upgrade — see the setup guide for what each tier unlocks), a zone recreation,
or moving to a new custom domain — a WAF rule doesn't follow you to a new
zone, and it never covers `*.workers.dev` at all.

**Verify it's actually blocking**, from a machine that isn't your own operator
session (a false positive here just costs you re-typing your token):

```sh
for i in $(seq 1 8); do
  curl -s -o /dev/null -w '%{http_code}\n' -X POST "$BASE/login" \
    -d 'operator_token=deliberately-wrong&csrf_token=x'
done
# expect: the first several return 200/302 (the sign-in page re-rendering with
# an error), then Cloudflare starts answering itself — typically 429 or a
# challenge page — well before the free plan's 6th request in the same
# 10-second window.
```

If every request keeps reaching the Worker (all `200`/`302`, nothing
short-circuited), either you're testing against `*.workers.dev` — no WAF rule
ever sees that traffic, only your custom domain — or the rule was never
created; re-run the
[setup steps](cloudflare-setup.md#13-rate-limiting-the-credential-guessing-surfaces-recommended).

## Maintenance: edge rules for the MCP surface (SEP-2243 headers)

*(Another Cloudflare-dashboard task, not a Slopcafe one — same reason as the
rate-limiting section above: there's no `/admin/*` route or console panel for
this, and there couldn't be, since the Worker's own route dispatch never
looks at these headers — see below.)*

MCP 2026-07-28 (SEP-2243) added **header-based routing hints**: a modern
Streamable HTTP client sends `Mcp-Method` (the JSON-RPC method, e.g.
`tools/call`) and, on name-addressed calls, `Mcp-Name` (the tool or resource
name, e.g. `search_documents`) as plain HTTP headers alongside the JSON-RPC
body — so a gateway can filter or rate-limit traffic *before* it has to parse
a body. Slopcafe's own `/mcp` dispatch is indifferent to them on purpose:
`innerHandler`'s route table (`src/index.ts`) matches on `path === "/mcp"`
only, the OAuth wrap's `apiRoute` (`src/oauth.ts`) is the same literal
string, and the JSON-RPC method the server actually executes always comes
from the body — never the header. `test/e2e/mcp-apps.sh` sends both on every
call and proves the server routes on the body regardless of what the headers
say. That split is exactly what makes the headers useful for edge rules:
Cloudflare can act on them without the Worker's cooperation or any code
change here.

> **Load-bearing** (issue #48's own caveat, worth repeating here): these
> headers are client-supplied hints, never an auth input. A client that sends
> `Mcp-Method: tools/call` / `Mcp-Name: read_document` while its JSON-RPC body
> actually calls `publish_document` still gets routed, by the Worker, to
> `publish_document` — the body remains the source of truth and the server
> re-dispatches on it regardless. An edge rule keyed on these headers can only
> shape *traffic* (rate-limit or block requests claiming to be a given tool
> call); it is never a substitute for the server's own dispatch or
> authorization.

### A custom rule that can see the header — works on every plan, including Free

Unlike rate limiting rules (Path-only on Free — see above), Cloudflare's
**custom rules** support the full request-header field set at every plan
tier, and a Free zone gets 5 of them. Verified against the live docs
(2026-09-03): [rules-language
fields](https://developers.cloudflare.com/ruleset-engine/rules-language/fields/),
the [header-matching worked
example](https://developers.cloudflare.com/waf/custom-rules/use-cases/require-specific-headers/),
and the [actions
reference](https://developers.cloudflare.com/ruleset-engine/rules-language/actions/).
`http.request.headers` is typed `Map<Array<String>>` — index it by the
**lowercased** header name and use `any(…[*] eq "…")` to compare a value
(header *values* stay case-sensitive):

```
(http.request.uri.path eq "/mcp" and
 any(http.request.headers["mcp-method"][*] eq "tools/call") and
 any(http.request.headers["mcp-name"][*] eq "search_documents"))
```

That expression, with action **Block**, kills calls to `search_documents` at
the edge before the Worker — and its D1/Vectorize round trips — ever runs,
which is the second bullet of issue #48. Swap the header value, or `and` in
another `any(…)` clause, to cover a different or additional tool.

### Observe before you block

There's no free lunch here the way there almost is with `/login`. Custom
rules' **`Log`** action — match-and-record with no effect on traffic, the
natural dry run — is **Enterprise-only**; Free/Pro/Business don't get it.
`Skip` doesn't fill in for it either: it exists to exempt matching traffic
from *other* security features, not to log a match with no effect. And
**Managed Challenge**, a useful softer first step on a page a browser loads,
doesn't help here at all — an MCP client is a JSON-RPC caller with no browser
to solve a challenge, so pointing it at a rule on this surface behaves
exactly like Block for that call. There's no interactive-vs-bot split to
exploit on `/mcp`.

So the safe rollout on Free/Pro/Business is to test the *expression*, not
live *traffic*: stage the rule with a header value nothing legitimate ever
sends (a scratch `Mcp-Name` you invent, never a real tool name) and action
Block, fire one manual call at it from a machine that isn't a real agent, and
confirm it's blocked — Security → Events on the zone shows the match
regardless of which action fired, same as the `/login` recipe above. Once the
expression and the header casing behave as expected, edit the match value to
the real tool name and go live. Don't deploy straight to the real value and
watch for collateral damage after the fact — below Enterprise there's no
reversible half-step to fall back on.

### Header-keyed rate limiting needs Enterprise, not Business

The rate-limiting section above tops out at Business
(`http.request.method` plus a response-aware counting expression — still no
headers). Counting **by** header value — e.g. throttling `search_documents`
calls per caller independently of writes — is a rate limiting
[`characteristics`](https://developers.cloudflare.com/waf/rate-limiting-rules/parameters/)
entry, and it's gated at the same place the plan-availability table gates
every other header field: Cloudflare's own [plan-availability
table](https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/partials/waf/rate-limiting-availability-by-plan.mdx)
(verified 2026-09-03, the same source §13 above cites) lists "request header
fields" first appearing at **Enterprise** — with the application-security
bundle or the Advanced Rate Limiting add-on — not at Business. If you're on
that tier, the characteristic is `http.request.headers["mcp-name"]`
(lowercased header name, same casing rule as the custom-rule expression
above) alongside `ip.src`, so the count is per-(IP, tool) instead of just
per-IP. Below Enterprise, the custom rule above is the only edge-level lever
on these headers — it can kill a tool outright, but it can't rate-limit by
header value.

### Cheap traffic visibility without any of this: Workers Logs

If all you want is "is `/mcp` getting hit more than usual", the commented
`[observability]` block in `wrangler.toml.example` turns on per-request
Workers Logs (method, URL, status, outcome) in the dashboard with zero WAF
setup. It does **not** break traffic down by tool, though: Workers Logs
record the automatic request line, not custom headers — reading `Mcp-Name`
into a log needs an explicit `console.log()` in code, which isn't part of
this change. Per-tool visibility is the edge-rule job above, not a logging
one.

## At a glance: the dashboard

**Console.** The **Dashboard** (the console landing page) shows live-document and
agent counts plus a storage bar — how much of your `STORAGE_CAP_BYTES` budget is used
(counting both the sanitized render and the retained source across live documents).
It's the same accounting the write path enforces, so the number can't drift from the
cap check. A third stat, **pending promotion** (issue #57), counts public documents
whose `published_ver` doesn't match `current_ver` — the review queue's size — and
links straight to it; see [Publication](#publication-which-version-the-public-sees).

**curl.** The health endpoint surfaces the same counts and the cap without auth,
plus the three in-band discovery pointers an agent needs to go from "I have a base
URL" to "I know the calls":

```sh
curl -s "$BASE/healthz" | jq .
# → { ok, service, sanitizer_version, storage_cap_bytes,
#     openapi: "<BASE>/openapi.json",           ← the machine contract
#     docs:    "<BASE>/docs/http-api-quickstart",
#     mcp:     "<BASE>/mcp",
#     d1: { documents, agents }, r2: { ... } }
```

`storage_cap_bytes` is reported through the same reader the write path enforces,
so a misconfigured `STORAGE_CAP_BYTES` shows you the fallback that's actually in
force (2 GiB) rather than the unusable value you set.

---

That's the whole operator surface. For the precise contract behind any of these — every
field, header, and status code — see [`http-api.md`](http-api.md) or the live
machine-readable spec at `<BASE>/openapi.json`.
