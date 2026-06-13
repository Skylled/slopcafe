# Bypass corpus — sources, licensing, and the re-sync procedure

This directory feeds [`../bypass_corpus.rs`](../bypass_corpus.rs): a regression
test that runs the sanitizer against a curated **long-tail** of known
HTML-sanitizer bypass vectors (exotic event handlers, `javascript:`/`data:`
obfuscation, SVG/`xlink:href` surface, mutation-XSS / namespace confusion,
markup-mutation breakouts) and asserts no **script-execution sink** survives.

Read the doc-comment at the top of `bypass_corpus.rs` first — it states the
defense-in-depth framing (the sanitizer is the *second* wall behind the
iframe-sandbox + CSP render wall) and the exact predicate scope (and what's
deliberately out of scope: inline-`style` CSS, `<style>`-block CSS *content*
— the sanitizer doesn't CSS-parse it; only `<style>` *breakout* into a live
element is in scope — and ARIA-tree hijack).

## Why long-tail, not "thousands"

ammonia (allowlist + reserialize, on html5ever) plus the ~40 targeted negative
tests in `sanitizer/src/lib.rs` already own the core stripping contract. Bulk
generic `<script>`/`onerror` variants mostly re-test what ammonia guarantees.
The non-redundant value is in (a) **unknown-unknowns in *our* allowlist** — the
tags/attributes/schemes we add in `make_builder()` (SVG drawing primitives, the
`href`/`xlink:href` we grant on `<a>`/`<use>`/`textPath`, `role`/`aria-*`,
generic `style`) — and (b) a **regression tripwire across ammonia upgrades**.
So this corpus is sized to probe *our* surface, not to mirror an upstream dump.
(Duplicates and near-duplicates are fine — the test is cheap and runs rarely.)

## Files

| File | Purpose |
|------|---------|
| `bypasses.txt` | the vectors |
| `known_exceptions.txt` | reviewed-safe survivors (exact-payload quarantine) |
| `SOURCES.md` | this file |

### Line format (both `.txt` files)

The only reserved prefix is `>>>`. Everything else is a payload, taken
**verbatim** — so vectors that start with `#` or `//` paste in unchanged.

```
>>> source: <provenance label>     # sets the source for following vectors
>>> category: <bucket>             # sets the category for following vectors
>>> note: <free text>              # documentation, ignored by the loader
>>> reason: <free text>            # (exceptions file) why a survivor is accepted
<one payload per line>             # verbatim; blank lines skipped
```

`known_exceptions.txt` keys on the **exact** payload string; its `>>> reason:`
directive is mandatory documentation (the loader ignores it, human review does
not).

## Provenance

The vectors are **representative / adapted** canonical forms drawn from the
public collections below — short factual attack strings used as test inputs,
each tagged with a `>>> source:` label. This is not a verbatim mirror of any
single list.

| `source:` label | Origin | License / terms |
|-----------------|--------|-----------------|
| `owasp-xss-filter-evasion` | OWASP XSS Filter Evasion Cheat Sheet — <https://owasp.org/www-community/xss-filter-evasion-cheatsheet> | CC BY-SA 4.0 (attribution above) |
| `portswigger-cheatsheet` | PortSwigger Cross-site scripting cheat sheet — <https://portswigger.net/web-security/cross-site-scripting/cheat-sheet> | PortSwigger reference content |
| `cure53-dompurify-mxss` | Cure53 DOMPurify bypass history + Heiderich et al. mXSS research — <https://github.com/cure53/DOMPurify/tree/main/test> | DOMPurify is Apache-2.0 / MPL-2.0; research write-ups |
| `awh-*`, `svg-*` | Hand-authored probes of *our* `make_builder()` allowlist | this repo |
| `awh-style-surface` | Hand-authored probes of *our* v1.4 `<style>`-block allowance in `make_builder()` (RAWTEXT-breakout / namespace-confusion vectors; the inert `@import`/`position:fixed` cases) | this repo (no third-party license) |

If you vendor a whole upstream list later (e.g. `payloadbox/xss-payload-list`,
MIT), drop the raw `.txt` in this directory and add a one-line `(file, format)`
case — the loader already treats any non-`>>>` line as a verbatim payload, so a
plain one-per-line list needs no transformation. Note the new `source:`/license
here.

## Re-sync procedure (the whole loop)

1. **Refresh / extend** `bypasses.txt` — append vectors under a `>>> source:`
   header, or overwrite a vendored upstream `.txt` in place. No code change.
2. **Run** `npm run test:sanitizer` (or `cd sanitizer && cargo test --test
   bypass_corpus -- --nocapture`).
3. **Triage any survivor.** Each failure prints the payload, the sanitized
   output, and the exact sink. For each:
   - **Real sanitizer gap** → fix `sanitizer/src/lib.rs` (`make_builder()`),
     bump `sanitizer_version()`, keep `skills/publishing.md` in lockstep.
   - **Reviewed-safe** (neutralized only by the render wall, ammonia not
     contracted to strip it) → add the exact payload to `known_exceptions.txt`
     with a `>>> reason:` and the review date.
4. **Re-run** until green.

The `predicate_self_check` test guards the detector itself — if you edit the
predicate (`scan` / `dangerous_scheme` / the `DANGEROUS_*` / `URL_ATTRS` const
sets in `bypass_corpus.rs`), keep that test passing so the corpus can't go green
vacuously.

## Suggested cadence

Infrequent by design. Review on **every ammonia dependency bump** (the upgrade
tripwire is the main payoff) and roughly **quarterly** otherwise, pulling any
newly-published DOMPurify/ammonia advisory vectors into `bypasses.txt`.
