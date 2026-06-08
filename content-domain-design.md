# Separate content domain (+ scripted documents) — design note

**Status:** **deferred — post-V1.** Not building now; this is the plan of record
for when it ships. The motivating feature is **scripted (JS) documents**, and
the separate content domain is the security prerequisite for them (§1). The
whole matter — domain split *and* JS support — is one feature, shipped in **one
push**: there is no intermediate "domain split but still static-only" milestone
worth cutting, because the split buys nothing a user notices until scripts turn
on. Two constraints are **locked** and shape the whole design:

1. **Single-domain must stay a supported deployment.** A deployer who wants one
   origin changes nothing; two-domain is opt-in and is *required only* for JS
   (§5). Static-only single-domain is the safe default and stays byte-identical
   to today.
2. **Scripted documents must NOT be forced-public.** Private docs are scriptable
   from day one of this feature. This is the constraint that pulls the
   **content-origin capability token** (§6) into the core design rather than a
   follow-up — without it, the cookie boundary would make "private + scripted"
   impossible and JS would be a public-only tier, which we explicitly reject.

This note follows the shape of `vector-search-design.md`: problem → decisions →
mechanics → threat model → deferred. It builds on the three-plane reframing in
**GitHub issue #26** and promotes the "single separate content domain … the
planned next layer" already named in `agent-knowledge-host-spec-SOLO-v1.md` §5.

Throughout, the worked example uses `slopcafe.com` as the **app origin** and the
arbitrary (not-yet-claimed) `slopcafecontent.com` as the **content origin**.

---

## 1. Problem & goal

Documents render today under `<iframe sandbox>` with **no** `allow-scripts` and
**no** `allow-same-origin`, behind a strict CSP (`src/serve.ts`). That static
tier is safe *same-origin* only because there is no script: the sandbox gives
the frame an opaque origin, so even though the bytes come from `slopcafe.com`,
there is no script to reach `slopcafe.com`'s cookies, session, or DOM.

The moment we want **scripted documents** (issue #3, "Consider supporting
JavaScript"), same-origin stops being safe. A doc with `allow-scripts` served
from `slopcafe.com` could script the app origin — read the operator session
cookie surface, call same-origin admin endpoints, etc. CSP narrows this but the
**origin** is the real boundary, and same-origin throws it away.

The fix is the long-named **separate content domain**: serve document bytes from
a *different registrable domain* (`slopcafecontent.com`) so a scripted doc runs
on an origin with **no relationship** to the app — no app cookies, no app DOM,
and (with `connect-src 'none'`) no network back. Then `allow-scripts` grants the
doc interactivity over *its own* inert DOM and nothing else.

**Goal:** make scripted documents possible *without* forcing them public,
*without* breaking single-domain deployments, and *without* moving the
load-bearing CSP/sanitize wall (plane 2 in §2) somewhere a deployer can replace
it.

## 2. Scope — which plane moves (and which must not)

From issue #26's taxonomy, the codebase has three planes. This feature touches
exactly one of them, and the discipline is in **not** touching the others:

- **Plane 1 — control/data plane** (`/mcp`, `/admin/*` JSON, write API). Stays
  wholly on the app origin. Untouched.
- **Plane 2 — render wall** (`/raw` bytes + CSP + sanitize). *Its bytes* relocate
  to the content origin. It stays **authoritative and non-optional** — this is
  not "frontend a deployer can swap," it is security infrastructure that now
  lives on a second origin. The *shells* (the outer chrome at `/d/:id`) stay on
  the app origin and point *at* the content origin.
- **Plane 3 / plane-4 chrome** (consent, login, console, manage UI, homepage
  branding). Stays on the app origin. Untouched.

The single most important non-goal: **the content origin must never become a
swappable/forkable surface.** It is the same authoritative Worker code, reached
via a second hostname. Issue #26's "let people roll a custom frontend" applies
to plane 4 only — never to plane 2's byte path.

## 3. Decisions (locked for when this ships)

1. **One Worker, two custom domains** — not two Workers (§4). Origin isolation
   comes from the *hostname the browser sees*, not from separate compute.
2. **`CONTENT_ORIGIN` is the master switch.** Unset → single-domain, static-only,
   byte-identical to today. Set → two-domain, JS-eligible (§5).
3. **In two-domain mode, the app origin emits NO document bytes to a browser.**
   The content origin becomes the *sole* browser byte surface for both public
   and private docs. (Agent byte surfaces — `/text`, `/source`, MCP — stay on
   the app origin, agent-key gated, unchanged.)
4. **Private docs render on the content origin via a short-lived capability
   token** minted by the app-origin shell after `canRead` passes (§6). This is
   what keeps "private + scripted" possible across the cookie boundary.
5. **`allow-scripts` is per-document opt-in**, never `allow-same-origin` (§9).
   Static docs keep the maximal sandbox even in two-domain mode.
6. **The token substitutes for the principal/visibility check only** — never for
   the existence/revoked gate, which the content branch still runs against D1
   (§6, §13). A leaked token cannot outlive a revoke.

## 4. Topology — one Worker, two custom domains

A Cloudflare Worker can bind to multiple custom domains. Bind the same Worker to
both `slopcafe.com` and `slopcafecontent.com`; branch on `url.host` at the very
top of `innerHandler`:

```
   slopcafe.com  ─────────► ┌─ one Worker, one set of bindings ─────────┐
   (app origin)             │  host == app origin                       │
                            │    → full dispatch (planes 1, 3, 4) +     │
                            │      plane-2 *shells* pointing at content  │
                            │                                           │
   slopcafecontent.com ───► │  host == content origin                   │
   (content origin)         │    → ONLY raw byte routes, anonymous,     │
                            │      no cookies ever, 404 everything else  │
                            └───────────────────────────────────────────┘
                                       │                  │
                                  D1 (META)            R2 (DOCS)
```

**Why one Worker, not two.** Serving a `/raw` requires a D1 lookup (resolve
`public_id` → `revoked_at` / `visibility` / `current_ver` → R2 key) and an R2
GET. A "thin proxy" content Worker would still need both bindings — it is not
thin. A second Worker buys *code* blast-radius isolation (a minimal content
codebase an admin/MCP bug can't reach) but **zero** extra *origin* isolation —
that is already won by the second hostname. Start with one Worker; revisit only
if the threat model later demands code isolation. The two-Worker variant, if
ever taken, shares this note's seams verbatim — only the deploy unit changes.

## 5. Configuration — the switch and the ladder

Three `[vars]`, following the `DEFAULT_DOCUMENT_VISIBILITY` / `SESSION_EPOCH`
precedent (non-secret config in `wrangler.toml`, plumbed through `src/env.ts`):

```toml
[vars]
APP_ORIGIN     = "https://slopcafe.com"          # always set; named exactly for frame-ancestors
CONTENT_ORIGIN = "https://slopcafecontent.com"   # UNSET = single-domain mode (master switch)
ALLOW_DOCUMENT_SCRIPTS = "false"                  # JS opt-in; only honorable when CONTENT_ORIGIN is set
```

The config **ladder** — each rung gated on the one below, so misconfiguration
fails safe:

1. **`CONTENT_ORIGIN` unset → single-domain, static-only.** Byte-serving is
   same-origin `/d/:id/raw`, shell CSP `frame-ancestors 'self'`, scripts off.
   Unchanged from today. `ALLOW_DOCUMENT_SCRIPTS` is **inert** here — a
   single-domain deploy *cannot* enable scripts (there is no isolated origin to
   run them on), and the code must refuse to honor it.
2. **`CONTENT_ORIGIN` set → two-domain, isolated rendering.** All browser doc
   bytes serve from the content origin; private ones carry a capability token.
   Still static unless rung 3.
3. **`ALLOW_DOCUMENT_SCRIPTS=true` (requires rung 2) → scripts eligible.**
   Per-doc opt-in then decides which docs actually get `allow-scripts` (§9).

`APP_ORIGIN` is explicit (not derived from the request) because the content
branch must name it *exactly* in a `frame-ancestors` directive (§8), and the
content request's own `Host` is the content origin, not the app.

## 6. The content-origin capability token (the private-scripted bridge)

This is the mechanism that makes constraint #2 (no forced-public) hold. The
content origin is a different registrable domain, so the operator's host-only
`SameSite=Lax` `awh_session` cookie **structurally cannot reach it** — the
content origin's principal is *always anonymous by construction*. For public
docs that is exactly right. For private docs we need to authorize a read without
the cookie following. A **short-lived signed capability token** does it.

**Minted** by the app-origin **shell** handler, only for a **private** doc,
**after** `canRead(principal, doc)` returns true (so the mint is itself
authorization-gated on the app origin where the cookie/bearer works):

```
payload = base64url(JSON{ d: public_id, v: version_no, exp: nowMs + TTL })
token   = payload + "." + HMAC_SHA256(payload, capSigningKey)
```

- **`capSigningKey`** derives from a *server* secret, **not** `OPERATOR_TOKEN`:
  `hmacSha256Hex("awh-content-cap/v" + CAP_EPOCH, HMAC_PEPPER)`. The token is a
  doc-read grant available to any `canRead`-passing principal, not the operator
  *principal*, so it must not ride the session-rotation key. `CAP_EPOCH` is the
  cheap "invalidate all outstanding caps" knob; rotating `HMAC_PEPPER` also
  invalidates them. Same Worker serves both origins, so the key is in scope on
  the content branch with no extra plumbing. Never log the token (same
  discipline as the OAuth token / minted keys / session signing key).
- **TTL** short (~5 min). The iframe loads once on shell render, so a short life
  is ample; a stale token just means the operator reloads the top-level shell,
  which re-mints. Bounds the capability-URL exposure window (§13).
- **Scope is doc + version** (`d`, `v`), so it authorizes exactly the bytes the
  shell was rendering — this also covers the operator version-history raw route
  (`/d/:id/v/:n/raw`) for historical *private* versions.

**Verified** on the content branch's `/raw` handler, in this order (the ordering
is the no-oracle guarantee):

1. D1 lookup by `public_id` **always**. Missing or `revoked_at` set → opaque
   `404`. *(The token never bypasses this — revoke kills a leaked token instantly.)*
2. `visibility === "public"` → serve, **no token required** (public docs stay
   directly shareable on the content origin; a token, if present, is ignored).
3. Private → require `?t`. Constant-time-verify the HMAC, check `exp > now`,
   check `d === public_id`, serve version `v`'s bytes. Any failure → the **same
   opaque `404`** a missing/private-to-anonymous doc gives. **Never `401`, no
   existence oracle** — identical discipline to the visibility gate today.

What the token does **not** grant: no write, no operator authority, no bypass of
existence/revoked. It is strictly a time-boxed read capability for one
doc-version's bytes on the content origin — a capability URL, exactly the model
`agent-knowledge-host-spec-SOLO-v1.md` §4 already describes for `public_id`/`slug`.

## 7. Render flow, end to end

Two-domain mode, operator viewing a **private** scripted doc:

1. Browser → `GET https://slopcafe.com/d/:id` (top-level shell, app origin).
   Operator's `awh_session` cookie present → `resolvePrincipal` → operator.
2. `canRead(operator, doc)` → true. Shell handler mints a capability token (§6)
   because `doc.visibility === "private"`.
3. Shell HTML returned with `<iframe src="https://slopcafecontent.com/d/:id/raw?t=<token>">`
   and a CSP allowing `frame-src https://slopcafecontent.com` (§8). Sandbox flags
   include `allow-scripts` iff this doc opted in and rung 3 is on (§9).
4. Browser loads the iframe → `GET https://slopcafecontent.com/d/:id/raw?t=…`
   (content origin; **no cookie** flows here). Content branch verifies the token
   (§6), serves the bytes with `frame-ancestors https://slopcafe.com` + the full
   locked CSP.
5. The scripted doc runs on an opaque-origin frame on `slopcafecontent.com`: no
   app cookies, no app DOM, `connect-src 'none'` so no network, sandboxed so no
   break-out.

Public doc is identical minus steps 2's mint and the `?t=` (tokenless content
URL). Single-domain mode collapses steps 2–4 to today's same-origin `/raw`.

## 8. The two-sided CSP handshake

Cross-origin embedding requires *both* origins to opt in, so two CSP edits move
together and only in two-domain mode:

- **Shell page (app origin)** must permit framing the content origin:
  `frame-src https://slopcafecontent.com` (was effectively `'self'`).
- **Content `/raw` (content origin)** must permit *only* the app origin to frame
  it: `frame-ancestors https://slopcafe.com` (was `'self'`) — built from
  `APP_ORIGIN`, exact, no wildcard.

Everything else in `RAW_CSP` stays maximally locked: `default-src 'none'`,
`connect-src 'none'`, `base-uri 'none'`, `form-action 'none'`, external-origin-
free `img/font/style-src`, `Cache-Control: no-store`, plus `Referrer-Policy:
no-referrer` so the `?t=` token can't leak via a referer header. In single-domain
mode both directives collapse back to `'self'` and nothing changes.

## 9. The JS-support gate (sandbox flags)

Scripts ride one sandbox flag: **`allow-scripts`, added but `allow-same-origin`
never is.** That combination is the whole point — the script runs but the frame
keeps an *opaque* origin: no storage, no cookies (there are none on the content
origin anyway), and with `connect-src 'none'` no network. The doc gets
interactivity over its own inert DOM (canvas, animation, local UI state) and
nothing else. We never combine `allow-scripts` with `allow-same-origin`.

**Per-document opt-in (recommended).** Rather than a fleet-wide flip, a document
declares it wants scripts — a `documents.allow_scripts` boolean (new migration)
or a richer `kind` enum. Least privilege: the static majority keep the maximal
sandbox even with the feature on, and a doc only gets `allow-scripts` when (rung
3 on) **and** (this doc opted in). The sanitizer allowlist also widens for these
docs to permit `<script>` of the intended shape — a substantial separate design
(out of scope here; this note covers the *origin/serving* layer, issue #3 covers
the *authoring/sanitizer* layer they depend on).

## 10. Cookie / principal boundary (why this is sound)

The content origin is **anonymous by construction**: a different registrable
domain, so no app cookie reaches it, so it cannot accidentally serve a private
doc on the strength of a session. Authorization for private bytes is *only* ever
the capability token, which is *only* minted after an app-origin `canRead` pass.
The two facts compose: the content origin can't authorize on its own, and the
only thing that authorizes it is a prior app-origin check. There is no path by
which the content origin over-discloses relative to the app origin.

Agent byte surfaces (`/text`, `/source`, MCP read) are unaffected — agents never
use the browser iframe path, so they stay on the app origin under agent-key auth.

## 11. wrangler / DNS / TLS

```toml
routes = [
  { pattern = "slopcafe.com",        custom_domain = true },
  { pattern = "slopcafecontent.com", custom_domain = true },
]
```

`slopcafecontent.com`'s zone goes on Cloudflare; **apex record only, no wildcard
DNS.** This is the SOLO model, which deliberately dropped PLATFORM's per-document
subdomains (`agent-knowledge-host-spec-PLATFORM-v2.md` §7.1) — a single flat
content apex, one edge cert auto-issued on the custom-domain bind. Local
`wrangler dev` can't bind two real domains; two-domain mode is exercised by
setting `CONTENT_ORIGIN` to a second local host (or a `*.workers.dev` pair) in a
staging deploy.

## 12. Seams summary (files this touches when built)

- `src/env.ts` + `wrangler.toml` — `APP_ORIGIN`, `CONTENT_ORIGIN`,
  `ALLOW_DOCUMENT_SCRIPTS`, `CAP_EPOCH` vars.
- `src/index.ts` — hostname-dispatch branch at the top of `innerHandler`; the
  content branch allows only the raw byte routes and 404s the rest.
- `src/serve.ts` — `rawSrc(env, doc)` helper (same-origin vs content-origin +
  `?t=`); shell CSP `frame-src`; content `/raw` CSP `frame-ancestors`; sandbox
  `allow-scripts` gating; `serveRaw` / `serveVersionRaw` token verification on
  the content branch.
- A new `src/content-cap.ts` (pure mint/verify, unit-tested like
  `src/conditional.ts` / `src/session.ts`'s crypto core): `mintContentCap`,
  `verifyContentCap`, taking explicit `nowMs` / `pepper` / `epoch`.
- A migration for per-doc `allow_scripts` (§9), if that opt-in shape is chosen.
- Docs sync at build time: `docs/http-api.md`, the SOLO spec §5/§7 (promote the
  "planned next layer" to as-built), `README.md`, and this note's status flip.

## 13. Threat model

- **Capability-URL exposure.** The `?t=` token is a bearer capability for its
  TTL — anyone who obtains it reads that doc-version until it expires. Bounded by
  the short TTL, `Referrer-Policy: no-referrer` (no referer leak), and the token
  living in an iframe `src` (not the address-bar top-level URL). This is the same
  capability-URL posture the SOLO spec already accepts for `public_id`/`slug`.
- **Revocation still gates.** The content branch runs the D1 existence/`revoked_at`
  check *before* honoring any token (§6 step 1), so a revoke kills a leaked token
  immediately — the token authorizes *visibility*, never *existence*.
- **No existence oracle.** Every private-doc failure on the content origin (no
  token, bad token, expired, wrong doc) returns the same opaque `404` as a
  missing doc — identical to the app-origin visibility gate.
- **What the isolation buys.** A scripted doc on `slopcafecontent.com` has an
  opaque origin, no app cookies, no app DOM, no network (`connect-src 'none'`),
  and no break-out (sandbox). The worst a malicious scripted doc can do is
  misbehave inside its own inert frame.
- **What it does not buy.** Browser 0-days in the sandbox/CSP implementation
  remain out of scope (same non-guarantee as `docs/security-model.md`). The
  content domain is defense-in-depth on top of the sandbox, not a replacement.

## 14. Single-domain degradation (the default)

With `CONTENT_ORIGIN` unset every branch above collapses: `rawSrc` returns the
same-origin path, both CSP directives are `'self'`, no token is ever minted or
checked, the hostname-dispatch branch is dead (there is no content host), and
`ALLOW_DOCUMENT_SCRIPTS` is refused. The deploy is byte-identical to today's
static, single-origin build. A deployer who never wants JS never touches any of
this — that is the §3 constraint #1 guarantee.

## 15. Relationship to issue #26 and the specs

- **Issue #26 (FE/BE split).** Complementary, not the same work. #26 makes
  **plane 4** (operator/brand UI) optional/forkable; this note relocates **plane
  2**'s bytes and keeps them authoritative. The shared discipline is the
  three-plane taxonomy: never let "frontend" leak into the content byte path.
- **SOLO spec §5/§7.** Promotes the already-named "single separate content
  domain … the planned next layer" from aspirational to as-built *when this
  ships*. Until then the spec's current-build sentences stay accurate (same-
  origin under sandbox+CSP is the load-bearing wall).
- **PLATFORM spec §7.** This deliberately does **not** adopt PLATFORM's
  per-document origins — flat content apex, doc-vs-doc isolation is a non-goal in
  SOLO (the agents aren't adversarial to each other). The only isolation is
  document-bytes-from-the-app-origin.

## 16. Deferred / open questions

- **Sanitizer/authoring layer for scripts (issue #3).** This note is the
  *origin/serving* half. Allowing `<script>` of a safe shape through the
  ammonia allowlist — and what "safe shape" even means — is a separate, larger
  design that this one unblocks but does not contain.
- **Per-doc opt-in shape.** `documents.allow_scripts` boolean vs a richer `kind`
  enum (§9) — decide at build, alongside the authoring design.
- **Token TTL / re-mint UX.** If long-lived open shells with stale iframes prove
  annoying, a tiny same-origin re-mint endpoint (app origin, cookie-gated) could
  refresh the token without a full shell reload. Not needed for v1 of the feature.
- **Two-Worker split.** Only if code blast-radius isolation on the content origin
  is later judged worth the duplicated bindings + deploy coordination (§4).
