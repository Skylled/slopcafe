---
name: agent-web-host-publishing
description: Publish HTML or Markdown documents to an unguessable URL via the agent-web-host service so a human can view rendered output (reports, dashboards, SVG diagrams) by clicking the link. Covers POST/PUT/GET, optimistic-concurrency updates with If-Match, the strict sanitizer allowlist for what HTML/CSS/SVG is permitted vs. silently stripped, and the Markdown-input path (CommonMark + GFM) that parses to HTML before sanitization. Trigger when asked to "publish", "host", "share as a webpage", "make a link to", "render", or "create a viewable page from" content you've generated, and any time you fetch back content you previously published.
---

# Publishing HTML to agent-web-host

## What this service does

You give it HTML — or Markdown, which we parse to HTML for you. It sanitizes the bytes, stores them, and returns an unguessable URL. A human opens that URL and sees the document rendered inside a sandboxed iframe. You can fetch the same URL back with your API key and read the sanitized HTML directly for further processing.

**Use it when** you've generated HTML output (a report, a status page, an SVG chart, a formatted note) that's easier to share as a click-and-view link than as a raw string.

**Don't use it for** structured data exchange (use JSON), interactive applications (no JavaScript runs), or anything containing secrets meant for a single recipient (the URL is the capability — anyone with it can read).

## Configuration

Two values you need from the operator:

```
AGENT_WEB_HOST_URL    https://slopcafe.com
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
  "sanitizer_v": "ammonia-v1.3",
  "modified": false,
  "stripped": [],
  "will_not_render": [],
  "title": "...",
  "description": null,
  "tags": [],
  "slug": null
}
```

Response headers include `Location: <url>` and `ETag: "v1"`. `title` / `description` / `tags` / `slug` echo whatever you sent (or what was derived/inherited); see [Document metadata](#document-metadata-title-description-tags-slug).

**Two things to act on from the response:**

- `url` is what you share with the human. The 22-character `public_id` is the capability — possession equals read access, so don't paste it into public channels you don't intend to be readable.
- `modified: true` means the sanitizer changed your input. Re-fetch `/d/${public_id}` with your key, diff against what you sent, and adjust on retry if the loss matters. `modified: false` means your input survived as-is.

### Publishing as Markdown

If authoring HTML directly is awkward, send Markdown and the server will parse it (CommonMark + GFM) into HTML before running the same sanitizer:

```
POST  ${AGENT_WEB_HOST_URL}/d
Authorization: Bearer ${AGENT_WEB_HOST_KEY}
Content-Type: text/markdown

# Daily summary

- Three things happened
- Two of them were good

| Date       | Hits  |
|------------|-------|
| 2026-05-25 | 1,388 |
```

The response shape is identical to the HTML path — `public_id`, `url`, `version`, `size_bytes`, `sanitizer_v`, `modified`, `stripped[]`, `will_not_render[]`. Same `modified` semantics, same advisory format.

**Storage is convert-and-discard.** Only the converted-and-sanitized HTML is stored — your Markdown source is not retained. `GET /d/${public_id}` returns the HTML; `GET /d/${public_id}/text` re-derives Markdown from that HTML, which may not match your original input exactly (round-tripping a Markdown table or a fenced code block produces *a* valid rendering, not necessarily *your* rendering).

**GFM extensions enabled:** tables, strikethrough (`~~text~~`), task lists (`- [ ]` / `- [x]`), footnotes. Other CommonMark extensions are off.

**Inline HTML in Markdown is allowed but sanitized.** CommonMark permits raw HTML, and we pass it through to the same sanitizer that handles `text/html` input — so a `<script>` block in your Markdown gets stripped exactly the same way it would from a pure-HTML POST, and shows up in `stripped[]` on the response. The full allowlist below applies to anything you embed.

**Task-list checkboxes don't render.** `- [ ] thing` and `- [x] thing` parse to `<li><input type="checkbox"> thing</li>`, and `<input>` isn't in the allowlist — the sanitizer strips the checkbox and the bullet survives with just "thing". You'll see one `<input>` entry in `stripped[]` per checkbox so the loss isn't silent. If you need a persistent visual marker, use unicode glyphs:

```markdown
- ☐ todo
- ☑ done
```

**Frontmatter is not parsed.** YAML front-matter (`---\ntitle: ...\n---`) renders as a literal horizontal rule + paragraph rather than being interpreted; either remove it or accept the visual.

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

**Markdown updates work the same way.** Send `Content-Type: text/markdown` and the body is parsed (CommonMark + GFM) before sanitization — see [Publishing as Markdown](#publishing-as-markdown). The two formats are interchangeable per-update: a document originally published as HTML can be updated with a Markdown body, and vice versa. The `versions.source_format` column records which path each version took, but the stored bytes are always sanitized HTML.

**Cross-agent writes are allowed.** Any agent key under the same operator can update any document. The document's "creator" attribution doesn't gate writes.

---

## Document metadata (title, description, tags, slug)

Four optional fields you can attach at publish/update time. None are required — sensible defaults apply when omitted. `title`, `description`, and `tags` are per-version (they evolve with content via inherit-on-omit). `slug` is per-document — a unique handle that survives version changes and is released when the doc is revoked.

### HTTP (custom headers, alongside the body)

```
POST  /d
Authorization: Bearer ${AGENT_WEB_HOST_KEY}
Content-Type: text/html
X-Doc-Title: Q2 metrics summary
X-Doc-Description: Three-week trend on tickets and resolution time.
X-Doc-Tags: metrics,q2,tickets
X-Doc-Slug: q2-metrics

<your HTML here>
```

| Header | When omitted (POST) | When omitted (PUT) | Empty value |
|---|---|---|---|
| `X-Doc-Title` | derived from the first `<h1>`, or the doc's first ~80 chars of text | inherits the prior version's title | re-derive from new content |
| `X-Doc-Description` | null | inherits prior | clear (stored as null) |
| `X-Doc-Tags` | empty array | inherits prior | clear (empty array) |
| `X-Doc-Slug` | null (no slug) | inherits current document slug | release the slug (back to null; available for reuse) |

**Limits:** title ≤300 chars, description ≤500 chars, max 10 tags × 32 chars each. Anything over the cap is silently truncated. Tag entries are restricted to `[A-Za-z0-9_-]` — any other character is **silently stripped** (so `metrics,q2 release!` becomes `["metrics", "q2release"]`). Duplicates are removed case-sensitively.

**Slug constraints:** 1–64 characters, lowercase URL-safe, must match `/^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/` — letters/digits/`_`/`-`, must start and end with a letter or digit. Unlike tags, **invalid slugs are rejected, not silently sanitized** — slug uniqueness means a mutated input could surprise-collide with another doc. Two error codes are specific to slug:

| Status | Error | When |
|---|---|---|
| 422 | `invalid_slug` | Charset / length / start-end-alphanumeric rule failed. Response includes a `reason` field. |
| 409 | `slug_taken` | Another live document already holds this slug. |

### MCP

The four write tools (`publish_document`, `publish_document_markdown`, `update_document`, `update_document_markdown`) take optional `title`, `description`, `tags`, and `slug` fields with the same semantics. On update, omitting a field inherits from the prior version (or current document, for slug); an explicit `""` or `[]` clears (and for title, re-derives; for slug, releases).

### Where each field surfaces

- **`title`** — rendered in the browser tab as `<title>{title} | Slopcafe</title>` on the shell page. It also powers the title of shared-link previews (Slack, Twitter/X, Discord, iMessage, etc.) via Open Graph and Twitter Card metadata tags. Anti-phishing normalization is applied at render time: Unicode bidi-override and zero-width characters are stripped so a malicious title can't reorder the brand suffix or preview card elements visually. The raw stored value (with whatever you sent) comes back through `list_documents` / `read_document_text`.
- **`description`** — emitted as `<meta name="description">` on the shell page and powers description text in shared-link previews (Slack, Twitter/X, etc.) via Open Graph and Twitter Card metadata tags. Like the title, it gets anti-phishing display normalization to strip dangerous bidi/zero-width characters at render time. It is also returned to agents via `list_documents` / `read_document_text` and doesn't render visibly in the document body.
- **`tags`** — agent-facing only in v1; returned in `list_documents` / `read_document_text`, and filterable on `list_documents` (AND semantics across multiple tags — see [Discovery and lookup](#discovery-and-lookup)).
- **`slug`** — agent-facing identity handle, distinct from `public_id`. `public_id` is the unguessable capability URL (possession = read access); `slug` is a typeable, unique, releaseable reference. Returned in `list_documents` and `read_document_text`. Three ways to use it once claimed: filter `list_documents` with `slug=…`, call the dedicated `find_document_by_slug` MCP tool (returns one row, no list envelope), or share the `GET /d/by-slug/${slug}` HTTP URL — anyone who lands on it is 302'd to `/d/${public_id}`. See [Discovery and lookup](#discovery-and-lookup).

### Slug lifecycle

- A slug is **unique across live documents.** Two live docs cannot hold the same slug at the same time.
- A slug is **released on revoke.** When `DELETE /d/${public_id}` (or the form-based revoke) clears a document, its slug is cleared too — immediately available for a future publish.
- A slug **survives updates** unless you actively change it. Omit `X-Doc-Slug` (or the MCP `slug` field) on update and the document keeps the slug it had.
- Setting a slug on update **atomically releases the old and claims the new** (both happen in one batch — no window where the slug is briefly unclaimed).
- Setting `X-Doc-Slug: ` (empty) on update **releases the slug** without revoking the document — the doc keeps its `public_id`, content, and history; only the slug column goes back to null.

### Response shape

Both POST and PUT responses include the resolved metadata under top-level `title`, `description`, `tags`, and `slug` keys so you can see exactly what got stored — important when title was derived or input was sanitized:

```json
{
  "public_id": "S43jW1wfIqlzaeWsYYLlMw",
  "url": "https://.../d/S43jW1wfIqlzaeWsYYLlMw",
  "version": 1,
  "size_bytes": 412,
  "sanitizer_v": "ammonia-v1.3",
  "modified": false,
  "stripped": [],
  "will_not_render": [],
  "title": "Q2 metrics summary",
  "description": "Three-week trend on tickets and resolution time.",
  "tags": ["metrics", "q2", "tickets"],
  "slug": "q2-metrics"
}
```

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

### Reading as context (Markdown form)

When you want to ingest a document for further reasoning — not render it — fetch the text derivation instead:

```
GET  ${AGENT_WEB_HOST_URL}/d/${public_id}/text
```

Returns the document as GitHub-Flavored Markdown (`Content-Type: text/markdown`), typically 20–40 % the size of the HTML form. Headings, lists, tables, code blocks, blockquotes, and links survive; inline styles, container `<div>` wrappers, and SVG path data are dropped — none of which carry meaning to an LLM reader.

The conversion runs on the **sanitized** bytes on each request, so the text view reflects exactly what the rendered HTML would show. Response headers `X-Sanitizer-Version` and `X-Converter-Version` identify the policies that produced the bytes; comparing them across reads tells you whether either policy has changed since you last looked.

**SVG handling:** inline SVGs collapse to a single `[Image: <alt>]` placeholder. Alt text is taken from the first `<title>` element, then the first `<desc>`, then the root `aria-label`. **SVGs with none of these are omitted from the text view entirely** — they carry no signal for an LLM reader, and a placeholder telling the agent "an image was here but I have no idea what it depicted" is worse than nothing. If an SVG carries meaning for the rendered page, give it a `<title>` so the text reader sees it too (this also helps screen-reader users):

```html
<svg viewBox="0 0 240 120" width="240" height="120">
  <title>Weekly hits — bar chart</title>
  <desc>Five bars increasing left to right, peaking on day four.</desc>
  <rect x="10" y="40" width="30" height="70" fill="#4a90e2"/>
  ...
</svg>
```

The MCP equivalent of this endpoint is the `read_document_text` tool — same content, JSON-wrapped with `version`, `sanitizer_v`, and `converter_v`.

---

## Discovery and lookup

You usually know a document's `public_id` because you just published it. When you need to find one back later, four patterns cover the cases: lookup by slug, filter the list by tag or slug, or full-text search by content.

### Find by slug (single document)

If you claimed a `slug` at publish time, the slug is your typeable lookup handle.

**MCP — preferred:**

```jsonc
// tool: find_document_by_slug
{ "slug": "q2-metrics" }
```

Returns the document's full listing row directly (not wrapped in a list envelope):

```json
{
  "public_id": "S43jW1wfIqlzaeWsYYLlMw",
  "current_ver": 3,
  "created_at": "2026-05-25T14:22:08.103Z",
  "created_by_id": "…",
  "created_by_name": "…",
  "current_size": 412,
  "revoked_at": null,
  "title": "Q2 metrics summary",
  "description": "Three-week trend on tickets and resolution time.",
  "tags": ["metrics", "q2", "tickets"],
  "slug": "q2-metrics"
}
```

Returns `not_found` when no live document holds that slug. A slug that resolved before may not now — slugs are released on revoke and a fresh publish can claim a released slug, so re-resolve before assuming a cached mapping still holds.

**HTTP (browser-shareable):**

```
GET  ${AGENT_WEB_HOST_URL}/d/by-slug/q2-metrics
→ 302 Found
  Location: /d/S43jW1wfIqlzaeWsYYLlMw
```

Public — no auth header needed. The slug itself is the capability; anyone with it lands on the same shell page they'd get at `/d/${public_id}`. Use this when you want a short URL to paste to a human (or to print on something physical).

### Filter `list_documents` by tag (multi-document)

```jsonc
// tool: list_documents
{ "tags": ["metrics", "q2"] }
```

AND semantics — the response contains only documents that carry **all** the listed tags. Pass one tag for a broad query, several to drill down. Tags are silently sanitized to `[A-Za-z0-9_-]` the same way as write-time, so `"foo!"` filters by `"foo"`; if every supplied tag sanitizes to empty, the filter is dropped (returns everything).

**HTTP:**

```
GET  ${AGENT_WEB_HOST_URL}/admin/documents?tag=metrics&tag=q2
Authorization: Bearer ${OPERATOR_TOKEN}
```

Repeated `?tag=` parameters AND together; `?tag=metrics,q2` (comma-separated) works as a shorthand too.

### Filter `list_documents` by slug

Equivalent to `find_document_by_slug` but inside the list envelope (zero or one row, with the standard `next_cursor: null`). Useful when your call site already iterates `documents[]` and you want one code path.

```jsonc
// tool: list_documents
{ "slug": "q2-metrics" }
```

Invalid slug shape rejects with `bad_slug`. (`find_document_by_slug` collapses invalid-shape and missing into one `not_found`, which is the right call for a lookup; the list endpoint surfaces the distinction so a programming error doesn't read as "no docs match.")

### Full-text search across the fleet

```jsonc
// tool: search_documents
{ "q": "quarterly revenue chart" }
```

Word-based search over the current version of every live document, ranked by BM25 relevance. The index covers four fields with descending weight: **title** (heaviest), **description**, **tags**, and **body**. The body is the Markdown form of the sanitized HTML — same projection you get from `read_document_text` — so inline-SVG `<title>` text becomes searchable content (one of several reasons to put `<title>` on every meaningful inline SVG you publish).

Query syntax is intentionally small:

- Space-separated terms are **implicit AND**. `quarterly revenue` returns docs that match both words.
- **Prefix match** with a trailing `*`: `publi*` matches publish, publishing, publication. ⚠ Prefix matches run against the **stemmed** form (see stemming below), so the prefix must be **short enough not to exceed the stem**. `engin*` matches "engineering"; `enginee*` does not (the stored stem is `engin`). When in doubt, use short prefixes.
- **Case and diacritics are folded.** `naive` matches `naïve`; `Math` matches `math`.
- **Light English stemming** (Porter): `publishing`, `published`, `publishes` collapse to a common stem at index time. This usually does the right thing — you rarely need prefix matches for English verbs/nouns — but it's the reason prefix queries can surprise you (above).
- Tokens shorter than 2 chars are dropped — a single letter would match almost everything.
- Phrase queries (`"…"`), Boolean operators (`AND` / `OR` / `NOT` / `NEAR`), and column filters (`title:foo`) are **not supported in v1**. Quotes, parens, and operators are silently stripped from the input — pass them, they just don't do anything.

Each hit carries the same row shape as a `list_documents` entry — `public_id`, `current_ver`, `created_at`, `created_by_*`, `current_size`, `revoked_at` (always null in search results — revoked docs leave the index), `title`, `description`, `tags`, `slug` — plus three search-specific fields:

| field           | meaning                                                                                                  |
|-----------------|----------------------------------------------------------------------------------------------------------|
| `score`         | positive float, **bigger = better match** (we negate FTS5's native lower-is-better)                      |
| `matched_field` | `"title"` \| `"description"` \| `"tags"` \| `"body"` — which column matched (priority: title > description > tags > body on multi-column hits) |
| `snippet`       | short excerpt of the matched column with `[bracketed]` match tokens                                     |

`tags` and `slug` filters compose with `q` — "find me docs about budget that carry the `finance` tag" is one call:

```jsonc
{ "q": "budget overrun", "tags": ["finance"] }
```

**HTTP (operator):**

```
GET  ${AGENT_WEB_HOST_URL}/admin/documents/search?q=quarterly+revenue&tag=finance
Authorization: Bearer ${OPERATOR_TOKEN}
```

Response shape is `{ "documents": [ ...hits ] }` — note the absence of `next_cursor`. Search results are capped at `limit` (default 50, max 200) with no pagination. BM25 rank is not a stable cursor key (a concurrent write can reorder ties), and in practice the top 200 hits either contain what you want or your query needs refining.

### When to use which

- One known slug, expecting a hit → `find_document_by_slug`. Cleanest object shape.
- "Find the doc that talks about X" → `search_documents`.
- Browse newest-first, optionally narrowed by tag/slug → `list_documents`.
- Both content and tag/slug constraints → `search_documents` with `tags` / `slug` filters.
- Need a URL a human can click → `GET /d/by-slug/${slug}`.

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

Use the semantic alternatives — `<nav>`, `<article>`, `<header>`, `<section>`, plus `<h1>`-`<h6>` and `<figure>` — for structural relationships rather than ARIA references.

### Links

```html
<a href="https://example.com">link</a>
<a href="mailto:someone@example.com">email</a>
```

**Every `<a>` is forced to `rel="noopener noreferrer"`** — any `rel` you set is replaced (not merged). **External `http`/`https` links automatically open in a new browser tab** — the server injects `target="_blank"`, so a click navigates to the linked site rather than trying (and usually failing) to load it inside the sandboxed frame. In-page anchors (`href="#section"`) and relative links keep the default in-frame behavior, so a table-of-contents jump still scrolls in place. Any `target` you set yourself is ignored — the server decides new-tab vs. in-frame from the URL.

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
| `target` on `<a>` (any value) | Ignored — the server sets it for you: external `http(s)` links get `target="_blank"` (new tab), in-page/relative links stay in-frame. | Don't set `target`; just write the `href`. |
| Custom `rel` values on `<a>` | Replaced with `rel="noopener noreferrer"` on every link. | Don't bother setting `rel`. |
| HTML comments `<!-- ... -->` | Stripped entirely. | Don't ship them. |
| `<noscript>` | Not in the allowlist. | Not needed — JS doesn't run anyway. |
| `<input>`, `<textarea>`, `<select>` | No form controls. | Don't try to collect input. |

**Things the sanitizer keeps but the CSP blocks at render time** (different layer, same effect — the user sees nothing):

- `<img src="https://...">` to any external origin (CSP `img-src 'self' data:`)
- External fonts via any mechanism (CSP `font-src 'self' data:`)
- Forms posting to external origins (CSP `form-action 'none'`)

**Any other element not in the allowlist is reported generically in `stripped[]`** — even one this guide doesn't enumerate above. For example, publishing a `<dialog>` or `<canvas>` yields an entry like `1 <dialog> (not in the allowlist; element removed, text kept)`. The element is unwrapped (its text content survives) and you get a line item, so an unsupported tag never disappears silently. Use [SVG](#svg-support) for visuals and the allowed [block-level](#block-level-structure) containers for structure.

---

## Critical limitations to internalize

1. **No JavaScript, ever.** Don't try.
2. **No external images, fonts, or stylesheets.** All assets must be inline or absent.
3. **External links open in a new tab; in-page anchors stay in-frame.** A link to `https://example.com` opens that site in a new browser tab — the server adds `target="_blank"`, the render frame's sandbox permits the popup, and `rel="noopener noreferrer"` is enforced so the new tab can't reach back into the document. Fragment links (`#section`) and relative links navigate within the frame, so a table of contents still works. You don't control this — the server picks new-tab vs. in-frame from the URL.
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
| 409 | `X-Doc-Slug` (or MCP `slug`) collides with another live doc's slug | Choose a different slug, or wait until the other doc is revoked |
| 412 | `If-Match` version doesn't match `current_ver` | Re-fetch, see what's there, retry with the new version |
| 413 | Body > 5 MiB, or fleet storage cap would be exceeded | Trim the document; if the cap is the issue, ask the operator to revoke older docs |
| 415 | Wrong `Content-Type` | Set `Content-Type: text/html` or `text/markdown` |
| 422 | `X-Doc-Slug` failed validation (charset/length/start-end-alnum) | Inspect the `reason` field and fix the slug shape |
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
