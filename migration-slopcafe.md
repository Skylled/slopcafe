# Migrating to slopcafe.com

Cutover plan for moving the Worker from `agent-web-host.skylled.workers.dev` to
`slopcafe.com`. The wrangler.toml change is already in place — this is the
operational runbook.

## What's already done in the repo

- `wrangler.toml` declares `routes = [{ pattern = "slopcafe.com", custom_domain = true }, { pattern = "www.slopcafe.com", custom_domain = true }]`.
- `workers_dev` is **left enabled**. The old `*.skylled.workers.dev` URL keeps
  responding until you flip it off in step 6 below. That window is what makes
  this a soft cutover instead of a hard one — every existing token, link, and
  connector keeps working while you verify the new domain.
- README, `skills/publishing.md`, and `skills/connector-guide.md` now reference
  `https://slopcafe.com`.

## Cutover order

1. Add the zone to Cloudflare
2. Move nameservers at Namecheap
3. Wait for Cloudflare to mark the zone Active
4. `npm run deploy` — Cloudflare provisions the custom-domain cert
5. Smoke-test slopcafe.com
6. Update the Claude connector and the Antigravity MCP config
7. (Optional, later) flip `workers_dev = false` and re-deploy to retire the old URL

Each step below is annotated with what success looks like and how to roll back.

---

## 1. Add slopcafe.com as a zone in Cloudflare

Cloudflare dashboard → **Websites** → **Add a site** → `slopcafe.com` → pick the
**Free** plan (Workers Custom Domains work on every plan, including Free).

Cloudflare will scan for existing DNS records. There are none worth keeping
(the domain is brand new from Namecheap), so accept the empty record set.

At the end Cloudflare gives you **two nameserver hostnames**, something like:

```
gabe.ns.cloudflare.com
xena.ns.cloudflare.com
```

Copy both. They're different for every zone.

## 2. Change nameservers at Namecheap

Namecheap → **Domain List** → **Manage** next to `slopcafe.com` →
**Nameservers** dropdown → switch from `Namecheap BasicDNS` to
**Custom DNS** → paste the two Cloudflare nameservers → green checkmark.

Namecheap usually applies the change within a couple of minutes, but
worldwide propagation can take up to 24 hours. Realistically, for a
brand-new domain that nothing else has cached, it's 10–30 minutes.

You can watch propagation at <https://www.whatsmydns.net/#NS/slopcafe.com>
or with `dig +short NS slopcafe.com @8.8.8.8`.

## 3. Wait for Cloudflare to mark the zone Active

Cloudflare polls for the nameserver change every few minutes. When it sees the
new nameservers, the zone moves from **Pending Nameserver Update** to
**Active** and you get an email. Don't proceed to step 4 until then — the
custom-domain provisioning needs the zone to be active so it can write DNS
records and request an SSL cert.

If it's still pending after an hour, double-check the Namecheap side: a
typo in either nameserver hostname blocks the switch silently.

## 4. Deploy

```sh
cd ~/Repos/agent-web-host
npm run deploy
```

The `predeploy` hook rebuilds the WASM sanitizer; `wrangler deploy` then
pushes the Worker **and** sets up the two custom-domain bindings declared in
`wrangler.toml`. Wrangler will print something like:

```
Custom Domains:
  slopcafe.com (provisioning…)
  www.slopcafe.com (provisioning…)
```

Cloudflare provisions a free Universal SSL cert for both hostnames and
writes the routing records into the zone automatically. This takes a few
minutes; you don't need to do anything else for it.

If the deploy fails with `custom_domain_already_used` or similar, the zone
isn't fully active yet — wait a few more minutes and re-run.

## 5. Smoke-test slopcafe.com

Once the dashboard shows both custom domains as **Active**:

```sh
# 1. Health check returns 200, no secret leakage
curl -i https://slopcafe.com/

# 2. www variant resolves to the same Worker
curl -i https://www.slopcafe.com/

# 3. Cert chain is valid
echo | openssl s_client -connect slopcafe.com:443 -servername slopcafe.com 2>/dev/null \
  | openssl x509 -noout -subject -issuer -dates

# 4. Confirm the old URL also still works (soft cutover)
curl -i https://agent-web-host.skylled.workers.dev/
```

All four should succeed. If `https://slopcafe.com/` returns a Cloudflare error
page rather than your Worker's health response, the custom-domain binding
finished but the deploy didn't pick it up — re-run `npm run deploy`.

**Optional but recommended sanity check** — publish a doc through the new
host to confirm sanitizer + D1 + R2 all work end-to-end:

```sh
BASE=https://slopcafe.com
KEY=awh_<your-existing-key>    # the same awh_ keys keep working — they're not URL-scoped

curl -s -X POST "$BASE/d" \
  -H "authorization: Bearer $KEY" \
  -H 'content-type: text/html' \
  --data '<h1>slopcafe.com smoke test</h1>'
# → { public_id, url: "https://slopcafe.com/d/...", version: 1, ... }
```

Open the returned `url` in a browser; the iframe should render correctly under
the strict CSP. Once you've confirmed it works, revoke the test doc:

```sh
curl -s -X DELETE "$BASE/d/<public_id>" -H "authorization: Bearer $OPERATOR_TOKEN"
```

## 6. Update the Claude connector and Antigravity MCP

This is covered in detail in the next section because both need URL swaps and
the Claude OAuth client needs special handling.

## 7. (Later) Retire the workers.dev URL

Once everything is steady on `slopcafe.com` for a week or two — and you've
confirmed no inbound links, scheduled jobs, or third-party scripts still hit
the old URL — flip the `wrangler.toml` setting:

```toml
workers_dev = false
```

and re-deploy. Cloudflare immediately stops responding on the
`agent-web-host.skylled.workers.dev` host. There's no DNS to clean up; the
subdomain is yours indefinitely under that account and you can flip it back on
later if you need to.

You don't need a redirect from the old host to the new one. The workers.dev
URL is only known to your own connector configs (Cowork OAuth client,
Antigravity MCP) — once those are pointed at slopcafe.com, nothing else on
the public internet references the old URL.

---

# Updating the Claude connector

The Cowork / claude.ai connector was set up via OAuth (Door A), so the
recorded `mcp_url` inside the connector is the old `*.workers.dev` URL. Just
changing the URL field in Cowork's connector config is the simplest path —
the OAuth client ID and secret stay the same; only the server URL moves.

**Option A — edit the existing connector in place (preferred):**

1. Cowork → **Customize → Connectors** → find the slopcafe connector → **Edit**.
2. Change **Server URL** from `https://agent-web-host.skylled.workers.dev/mcp`
   to `https://slopcafe.com/mcp`. Leave `client_id` and `client_secret` alone.
3. Save. Cowork will re-run the OAuth handshake against the new URL — you'll
   see `/authorize` on slopcafe.com, enter `OPERATOR_TOKEN`, click **Allow**.
4. Confirm in a new conversation that the connector's tools (`publish_document`,
   `list_documents`, etc.) show up under the **+** menu.

If Cowork's UI doesn't expose an edit-URL flow (it varies), use Option B:

**Option B — re-create the connector:**

1. Delete the existing connector from Cowork's connector list. The OAuth client
   in D1 stays; you can reuse it.
2. **Customize → Connectors → + → Add custom connector** with:
   - Server URL: `https://slopcafe.com/mcp`
   - Client ID + Client Secret: the same values you originally got from
     `POST /admin/agents/<id>/oauth-clients`. If you don't have the secret
     anymore, rotate the client first (next paragraph).
3. Approve at the consent screen as in step 3 above.

**If you lost the OAuth client_secret**, rotate the OAuth client cleanly:

```sh
BASE=https://slopcafe.com
OP="Bearer $OPERATOR_TOKEN"
AGENT_ID=<your-cowork-agent-uuid>     # GET /admin/agents to find it

# Find the existing client_id for that agent
curl -s "$BASE/admin/agents" -H "authorization: $OP" | jq .
# Look at the agent row's oauth_clients

# Delete it
curl -s -X DELETE "$BASE/admin/oauth-clients/<client_id>" -H "authorization: $OP"

# Mint a fresh one
curl -s -X POST "$BASE/admin/agents/$AGENT_ID/oauth-clients" -H "authorization: $OP"
# → { client_id, client_secret, mcp_url: "https://slopcafe.com/mcp", ... }
```

`client_secret` is shown once — capture it immediately.

---

# Updating the Antigravity MCP setup

You said this one's on the static `awh_` bearer (Door B). The key itself
doesn't change — `awh_` keys are scoped to the agent, not the URL. Only the
`serverUrl` field in Antigravity's `mcp_config.json` needs to move.

Open `~/.gemini/config/mcp_config.json` (on macOS/Linux) or
`C:\Users\<USER>\.gemini\config\mcp_config.json` on Windows. Find the
slopcafe entry — it'll look something like:

```jsonc
{
  "mcpServers": {
    "slopcafe": {
      "serverUrl": "https://agent-web-host.skylled.workers.dev/mcp",
      "headers": {
        "Authorization": "Bearer awh_..."
      }
    }
  }
}
```

Change `serverUrl` to `https://slopcafe.com/mcp`. Save. Restart Antigravity.

That's it for the Antigravity side. Confirm in Antigravity that the slopcafe
tools list still loads, then publish a test doc through the connector.

**Reminder on the field name:** Antigravity uses `serverUrl`, *not* `url`.
This is the single most common copy-paste failure when porting an MCP config
from Cursor or VS Code, so worth double-checking after the edit.

---

# Rollback

If something breaks during the cutover, the soft-cutover design means you
have two safe rollback points:

- **Before step 4 (deploy):** delete the zone from Cloudflare and switch
  Namecheap nameservers back to `Namecheap BasicDNS`. The old workers.dev
  URL has been live the whole time; nothing was relying on slopcafe.com yet.
- **After step 4 but before step 6:** revert the `wrangler.toml` changes
  (drop the `routes` block, restore the original comments) and re-deploy.
  Cloudflare will unbind the custom domains. The old workers.dev URL is
  still live. Connectors that haven't been moved off the old URL keep working.
- **After step 6 (connectors moved):** point them back at the old URL with
  the same edit you used to move them. The old URL is still serving the
  same Worker code; nothing on the agent side has changed.

The only one-way step is step 7 (`workers_dev = false`), and you don't have
to take it until you're sure.
