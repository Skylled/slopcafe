---
name: agent-web-host-publishing
description: Publish HTML documents to an unguessable URL via the agent-web-host service so a human can view rendered output (reports, dashboards, SVG diagrams) by clicking the link. Covers POST/PUT/GET, optimistic-concurrency updates with If-Match, and the strict sanitizer allowlist for what HTML/CSS/SVG is permitted vs. silently stripped. Trigger when asked to "publish", "host", "share as a webpage", "make a link to", "render", or "create a viewable page from" HTML you've generated, and any time you fetch back content you previously published.
---

# Publishing HTML to agent-web-host

## What this service does

You give it HTML. It sanitizes the bytes, stores them, and returns an unguessable URL. A human opens that URL and sees the document rendered inside a sandboxed iframe. You can fetch the same URL back with your API key and read the sanitized HTML directly for further processing.

**Use it when** you've generated HTML output (a report, a status page, an SVG chart, a formatted note) that's easier to share as a click-and-view link than as a raw string.

**Don't use it for** structured data exchange (use JSON), interactive applications (no JavaScript runs), or anything containing secrets meant for a single recipient (the URL is the capability — anyone with it can read).

## Configuration

Two values you need from the operator:

```
AGENT_WEB_HOST_URL    https://<worker-name>.<workers-subdomain>.workers.dev
AGENT_WEB_HOST_KEY    awh_<prefix>.<secret>     ← treat as a password
```

Send the key as `Authorization: Bearer ${AGENT_WEB_HOST_KEY}` on every request below. Never log the key or echo it back to the user.

---

## Publishing a new document

**Request:**

```
POST  ${AGENT_WEB_HOST_URL}/d
Authorization: Bearer ${AGENT_WEB_HOST_KEY}
Content-Type: text/html

<your sanitized-input-safe HTML here>
```

**Successful response (201):**

```json
{
  "public_id": "S43jW1wfIqlzaeWsYYLlMw",
  "url": "https://.../d/S43jW1wfIqlzaeWsYYLlMw",
  "version": 1,
  "size_bytes": 228,
  "sanitizer_v": "ammonia-v1",
  "modified": false
}
```

Response headers include `Location: <url>` and `ETag: "v1"`.

**Two things to act on from the response:**

- `url` is what you share with the human. The 22-character `public_id` is the capability — possession equals read access, so don't paste it into public channels you don't intend to be readable.
- `modified: true` means the sanitizer changed your input. Re-fetch `/d/${public_id}` with your key, diff against what you sent, and adjust on retry if the loss matters. `modified: false` means your input survived as-is.

---

## Updating a document

**Required:** an `If-Match` header. Without it the server returns **428 Precondition Required** — silent overwrites without a precondition are the wrong default and the API refuses to do them.

```
PUT  ${AGENT_WEB_HOST_URL}/d/${public_id}
Authorization: Bearer ${AGENT_WEB_HOST_KEY}
Content-Type: text/html
If-Match: "v3"

<new HTML>
```

`If-Match` values:

| Value | Meaning |
|---|---|
| `"v<n>"` | Strong ETag; PUT only succeeds if the current version is exactly `n`. Mismatched → **412**. |
| `*` | Wildcard; always succeeds (clobbers whatever's current). Use only when you genuinely don't care about lost updates. |

**Successful response (200):** same shape as POST, with `version` incremented and `ETag: "v<n+1>"` in the headers. The previous bytes stay in storage (append-only), but only the new version is what `GET` returns.

**Cross-agent writes are allowed.** Any agent key under the same operator can update any document. The document's "creator" attribution doesn't gate writes.

---

## Reading a document

The same URL serves humans and agents — what you get depends on your `Authorization` header.

```
GET  ${AGENT_WEB_HOST_URL}/d/${public_id}
Authorization: Bearer ${AGENT_WEB_HOST_KEY}
```

**With your key → raw sanitized HTML** (`Content-Type: text/html`, `ETag: "v<n>"`). This is exactly what the iframe loads — the same bytes a human would see, minus the shell + sandbox.

**Without auth → an HTML shell page with `<iframe sandbox>` pointing at `/raw`.** That's the human-rendering path. Don't follow it from an agent; just include your `Authorization` header.

**If your key is wrong → 401**, never silent fallback. A broken key is loud.

You can also fetch `/d/${public_id}/raw` directly with no auth and get the same bytes — that endpoint exists for the iframe to load. The auth-gated `/d/${public_id}` is the canonical agent path.

---

## What HTML is permitted

The sanitizer (Ammonia 4.x with a tuned allowlist) keeps a curated list of tags and attributes and **silently drops everything else**. Knowing the list saves you from authoring content that disappears.

### Block-level structure

`<p>`, `<div>`, `<section>`, `<article>`, `<aside>`, `<header>`, `<footer>`, `<nav>`, `<hgroup>`, `<figure>`, `<figcaption>`, `<blockquote>`, `<pre>`, `<hr>`, `<details>`, `<summary>`

**Not allowed (silently stripped, element only — text content survives):** `<main>`, `<address>`. Use `<section>` or `<div>` instead.

### Headings

`<h1>` through `<h6>`

### Inline text

`<a>` (see URL rules below), `<span>`, `<strong>`, `<em>`, `<b>`, `<i>`, `<u>`, `<s>`, `<small>`, `<sub>`, `<sup>`, `<code>`, `<kbd>`, `<samp>`, `<var>`, `<cite>`, `<q>`, `<abbr>`, `<dfn>`, `<mark>`, `<time>`, `<data>`, `<br>`, `<wbr>`, `<ins>`, `<del>`, `<bdi>`, `<bdo>`, `<ruby>`, `<rt>`, `<rp>`

### Lists

`<ul>`, `<ol>`, `<li>`, `<dl>`, `<dt>`, `<dd>`

### Tables

`<table>`, `<thead>`, `<tbody>`, `<tfoot>`, `<tr>`, `<th>`, `<td>`, `<caption>`, `<colgroup>`, `<col>`

(The HTML5 parser will auto-insert `<tbody>` if you omit it.)

### Document structure

`<html>`, `<head>`, `<title>`, `<body>` — accepted but **html5ever strips the structural wrappers** on output (`<title>` survives in the body). Don't rely on outer document structure; emit the document content directly and let the server's iframe shell handle framing.

### Common attributes (allowed on most tags)

- Layout: `id`, `class`, `style`, `title`, `lang`, `dir`
- Tabular: `colspan`, `rowspan`, `headers`, `scope`
- Lists: `start`, `reversed`, `value`, `type`
- Accessibility: `role` and any `aria-*` attribute (see exceptions below)

### Accessibility (ARIA)

`role` and the `aria-*` prefix are allowed on any element. Use them freely for screen-reader hints: `aria-label`, `aria-live`, `aria-hidden`, `aria-expanded`, `aria-current`, `aria-describedby`, `aria-labelledby`, `aria-busy`, `aria-pressed`, `aria-checked`, etc. — all ~40 string/token/boolean ARIA attributes work.

**Four ARIA attributes are denied** because they can re-parent or re-target elements in the accessibility tree, hiding content from or misdirecting screen-reader users in ways the sandbox + CSP can't catch:

- `aria-owns`
- `aria-controls`
- `aria-activedescendant`
- `aria-flowto`

(Background: [WICG/sanitizer-api#245](https://github.com/WICG/sanitizer-api/issues/245). The browser-native HTML Sanitizer API strips these by the same reasoning.)

Use the semantic alternatives — `<nav>`, `<article>`, `<header>`, `<main>` equivalents, plus `<h1>`-`<h6>` and `<figure>` — for structural relationships rather than ARIA references.

### Links

```html
<a href="https://example.com">link</a>
<a href="mailto:someone@example.com">email</a>
```

**Every `<a>` is forced to `rel="noopener noreferrer"`** — any `rel` you set is replaced (not merged). `target` is stripped entirely; clicks open in the same iframe.

### Permitted URL schemes for href / src

`http`, `https`, `mailto`, `tel`, `sms`, `ftp`, `ftps`, `irc`, `magnet`, `news`, `nntp`, `xmpp`, `geo`, plus a few other rare ones.

**Stripped: `javascript:`, `vbscript:`, `data:`, `file:`, `about:`, anything else not on the list.** When a scheme is stripped, the *whole attribute is dropped* — so an `<a>` whose only `href` was `javascript:...` becomes `<a rel="noopener noreferrer">link</a>` (text-only).

---

## CSS rules

| What | Status | Notes |
|---|---|---|
| `style="..."` on any element | **allowed** | The CSP allows inline styles. Use this for all visual formatting. |
| `<style>` blocks | **stripped** by the sanitizer | Author your CSS as inline `style=""` instead. |
| External stylesheets (`<link rel="stylesheet" href="...">`) | **stripped** | The `<link>` tag isn't in the allowlist. |
| Inline CSS `url(javascript:...)` | partially blocked | Inside an inline `style="..."` the sanitizer doesn't parse CSS, but the CSP blocks the load. Don't rely on it; just don't write it. |
| `@import` in stylesheets | n/a | No stylesheets survive. |
| External fonts via `@font-face` | not possible | No `<style>` blocks survive, and CSP `font-src` is `'self' data:`. |
| Inline data: fonts | not currently usable | `<style>` blocks where you'd put `@font-face src: url(data:...)` are stripped. |

**TL;DR:** every visual rule lives in a `style="..."` attribute. Keep it short — there's no `class`-driven theming because the supporting `<style>` block won't survive.

```html
<!-- ✓ works -->
<p style="color:#444; font-family:system-ui; line-height:1.5">Hello.</p>
<div style="border:1px solid #ddd; padding:1rem; border-radius:4px">…</div>

<!-- ✗ stripped silently -->
<style>p { color: #444; }</style>
<link rel="stylesheet" href="https://cdn.example.com/style.css">
```

---

## SVG support

SVG is the only way to render visual content (charts, diagrams, icons) since you can't ship images (see [Images](#images)). The sanitizer keeps SVG drawing primitives and their geometry/presentation attributes.

### Allowed SVG tags

`<svg>`, `<g>`, `<defs>`, `<symbol>`, `<use>`, `<marker>`, `<title>`, `<desc>`,
`<path>`, `<rect>`, `<circle>`, `<ellipse>`, `<line>`, `<polyline>`, `<polygon>`,
`<text>`, `<tspan>`, `<textPath>`,
`<linearGradient>`, `<radialGradient>`, `<stop>`,
`<pattern>`, `<clipPath>`, `<mask>`, `<filter>`,
`<feGaussianBlur>`, `<feOffset>`, `<feMerge>`, `<feMergeNode>`, `<feColorMatrix>`

### Stripped SVG tags

- `<foreignObject>` — re-enables HTML inside SVG; not allowed
- `<animate>`, `<animateTransform>`, `<animateMotion>`, `<set>` — can mutate attributes (e.g., retarget `href`); not allowed
- `<script>` inside SVG — stripped same as anywhere else
- `<a>` inside SVG, anchor tags within SVG — element kept (per ammonia default), but as elsewhere `target` is stripped

### Allowed attributes on any SVG element

`id`, `class`, `style`, `transform`,
`fill`, `fill-opacity`, `fill-rule`,
`stroke`, `stroke-width`, `stroke-opacity`, `stroke-linecap`, `stroke-linejoin`, `stroke-dasharray`, `stroke-dashoffset`, `stroke-miterlimit`,
`opacity`, `color`, `visibility`, `display`,
`x`, `y`, `x1`, `y1`, `x2`, `y2`, `cx`, `cy`, `r`, `rx`, `ry`,
`width`, `height`, `d`, `points`, `viewBox`, `preserveAspectRatio`,
`xmlns`, `xmlns:xlink`, `version`,
`offset`, `stop-color`, `stop-opacity`,
`gradientUnits`, `gradientTransform`, `spreadMethod`,
`patternUnits`, `patternContentUnits`,
`clip-path`, `mask`, `filter`,
`marker-start`, `marker-mid`, `marker-end`,
`text-anchor`, `dominant-baseline`, `font-size`, `font-family`, `font-weight`,
`dx`, `dy`, `rotate`, `lengthAdjust`, `textLength`

`xlink:href` and `href` allowed on `<use>`, `<textPath>`, `<a>`.

### Example: bar chart

```html
<svg viewBox="0 0 240 120" width="240" height="120" xmlns="http://www.w3.org/2000/svg">
  <rect x="10"  y="40" width="30" height="70" fill="#4a90e2"/>
  <rect x="50"  y="20" width="30" height="90" fill="#4a90e2"/>
  <rect x="90"  y="60" width="30" height="50" fill="#4a90e2"/>
  <rect x="130" y="30" width="30" height="80" fill="#4a90e2"/>
  <rect x="170" y="70" width="30" height="40" fill="#4a90e2"/>
  <line x1="0" y1="110" x2="240" y2="110" stroke="#888" stroke-width="1"/>
  <text x="120" y="15" text-anchor="middle" font-family="system-ui" font-size="12" fill="#222">Weekly</text>
</svg>
```

---

## Images

**You cannot publish working images in v1.** Two things conspire:

1. `<img src="data:image/...">` — the sanitizer drops `data:` URLs (it's not in the default URL-scheme allowlist). The `<img>` element survives but with the `src` attribute removed.
2. `<img src="https://...">` — the sanitizer keeps it, but the rendered iframe's CSP is `img-src 'self' data:`, which forbids external origins. The browser refuses the load (broken-image icon).

**Use SVG instead** for any visual content (charts, diagrams, icons, decorations). SVG is fully in-document — no separate resource fetch — and the sanitizer preserves the drawing primitives.

If you actually need a bitmap, future versions may relax `data:` URL handling. Don't rely on it today.

---

## What gets stripped silently

Knowing what disappears saves you from authoring content the user won't see.

| Input | Why stripped | What to use instead |
|---|---|---|
| `<script>` (anywhere, including inside SVG) | No JavaScript executes; CSP also blocks. | Pre-compute and emit static HTML. |
| `<style>` blocks | CSS-injection surface the sanitizer doesn't parse. | Inline `style="..."` attributes. |
| `<link rel="stylesheet">` | External CSS forbidden by sanitizer and CSP. | Inline styles. |
| `<meta>` (any) | `<meta http-equiv="refresh">` can redirect; CSP can't block it. | Don't try to redirect from rendered content. |
| `<base href>` | URL rewrites everything relative. CSP also blocks. | Use absolute URLs in your `href`/`src`. |
| `<iframe>`, `<object>`, `<embed>`, `<applet>`, `<frame>`, `<frameset>` | No embedded content allowed. | Pull the content's data and render it inline, possibly as SVG. |
| `<form>`, `<input>`, `<textarea>`, `<select>`, `<button>` | No user-input collection (this isn't an interactive surface). Element stripped; any text content inside survives. | Show data, don't request data. |
| `aria-owns`, `aria-controls`, `aria-activedescendant`, `aria-flowto` | Re-parent / re-target elements in the accessibility tree → AT-only content hijack. | Use semantic tags (`<nav>`, `<article>`, headings) for structure; other ARIA attributes are allowed. |
| Inline event handlers (`onclick`, `onerror`, `onload`, `onmouseover`, etc.) | Equivalent to scripts. | No interactive behavior is possible. |
| `javascript:`, `vbscript:`, `data:` URLs in `href`/`src` | Script-execution and content-injection vectors. | `http(s):` or `mailto:` URLs only. |
| `target="_blank"` on `<a>` | Stripped to prevent tabnapping; links open in the iframe. | Accept that links open in-frame. |
| Custom `rel` values on `<a>` | Replaced with `rel="noopener noreferrer"` on every link. | Don't bother setting `rel`. |
| HTML comments `<!-- ... -->` | Stripped entirely. | Don't ship them. |
| `<noscript>` | Not in the allowlist. | Not needed — JS doesn't run anyway. |
| `<input>`, `<textarea>`, `<select>` | No form controls. | Don't try to collect input. |

**Things the sanitizer keeps but the CSP blocks at render time** (different layer, same effect — the user sees nothing):

- `<img src="https://...">` to any external origin (CSP `img-src 'self' data:`)
- External fonts via any mechanism (CSP `font-src 'self' data:`)
- Forms posting to external origins (CSP `form-action 'none'`)

---

## Critical limitations to internalize

1. **No JavaScript, ever.** Don't try.
2. **No external images, fonts, or stylesheets.** All assets must be inline or absent.
3. **Links open in the same iframe** (sandbox forbids top-navigation and popups). A link to `https://example.com` will load that page inside the iframe — usually not what the user wants if it's a navigational link. Prefer linking to other agent-web-host docs or showing the URL as plain text.
4. **The URL is the secret.** Anyone with the `public_id` can read. Don't publish documents with PII or operator-internal data unless the URL itself is being shared deliberately.
5. **Revoking a doc is permanent.** If a human or the operator calls `DELETE /d/:id`, the R2 bytes are purged immediately. There is no undelete.

---

## Recipes

### A simple report

```html
<h1>Daily summary for 2026-05-26</h1>
<p style="color:#555">Generated by my-agent at 17:42 UTC</p>
<h2>Highlights</h2>
<ul>
  <li><strong>3</strong> new tickets opened</li>
  <li><strong>11</strong> resolved</li>
  <li><strong>0</strong> escalated</li>
</ul>
<h2>Notes</h2>
<p>Backlog is trending down for the third week running.</p>
```

### A table

```html
<table style="border-collapse:collapse; font-family:system-ui">
  <thead>
    <tr style="background:#f5f5f5">
      <th style="padding:8px; border:1px solid #ddd; text-align:left">Date</th>
      <th style="padding:8px; border:1px solid #ddd; text-align:right">Hits</th>
    </tr>
  </thead>
  <tbody>
    <tr><td style="padding:8px; border:1px solid #ddd">2026-05-24</td><td style="padding:8px; border:1px solid #ddd; text-align:right">1,204</td></tr>
    <tr><td style="padding:8px; border:1px solid #ddd">2026-05-25</td><td style="padding:8px; border:1px solid #ddd; text-align:right">1,388</td></tr>
  </tbody>
</table>
```

### A status indicator with SVG

```html
<p>System health:
  <svg viewBox="0 0 16 16" width="16" height="16" style="vertical-align:middle">
    <circle cx="8" cy="8" r="6" fill="#22c55e"/>
  </svg>
  <strong>green</strong>
</p>
```

### Updating an existing document

If your prior POST returned `public_id: "S43jW1wfIqlzaeWsYYLlMw"` and `ETag: "v1"`:

```
PUT  /d/S43jW1wfIqlzaeWsYYLlMw
Authorization: Bearer ${AGENT_WEB_HOST_KEY}
Content-Type: text/html
If-Match: "v1"

<h1>Updated content</h1>...
```

On success: 200 with `ETag: "v2"`. On version mismatch: 412 with `{ "current_version": N, "expected": M }` — refetch the current version and retry.

---

## Error responses

All errors are JSON: `{ "error": "<code>", "message": "...", ... }`.

| Status | When | What to do |
|---|---|---|
| 400 | Empty body, malformed JSON (admin), bad `If-Match` syntax | Fix the request |
| 401 | Missing or invalid `Authorization` | Check the key |
| 404 | Document missing, revoked, or `public_id` malformed | Don't retry; the doc is gone |
| 412 | `If-Match` version doesn't match `current_ver` | Re-fetch, see what's there, retry with the new version |
| 413 | Body > 5 MiB, or fleet storage cap would be exceeded | Trim the document; if the cap is the issue, ask the operator to revoke older docs |
| 415 | Wrong `Content-Type` | Set `Content-Type: text/html` |
| 428 | PUT without `If-Match` | Add `If-Match: "v<n>"` or `If-Match: *` |
| 500 | Unexpected server error | Retry once; if it persists, report to the operator |

---

## Detecting silent sanitizer modifications

When the response says `modified: true`, your input was changed. To find out what:

1. POST or PUT the document; capture the returned `public_id`.
2. GET `/d/${public_id}` with your `Authorization` header — you receive the stored sanitized bytes.
3. Diff against your input string.

If the diff loses something important (an attribute you needed, a tag that was central to your design), check the [What gets stripped](#what-gets-stripped-silently) table above and adjust your output. Most stripped things have an inline-friendly equivalent or are signals to switch approach (e.g., bitmap → SVG, `<style>` block → inline `style=""`).

`modified: false` means your input round-tripped exactly.
