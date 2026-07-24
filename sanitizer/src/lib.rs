// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

//! Ammonia-WASM sanitizer + Markdown ↔ HTML converters for agent-web-host.
//!
//! Exports four functions to the Worker:
//!   - `sanitize(html) -> String` — write-time allowlist enforcement
//!   - `markdown_to_html(md) -> String` — write-time Markdown input parser
//!     (CommonMark + GFM). Output flows straight into `sanitize()`; this
//!     function is NOT a trust boundary on its own.
//!   - `html_to_markdown(html) -> String` — read-time text conversion for
//!     agent context windows (see `markdown` submodule below)
//!   - version constants for each of the above so a stored byte stream can
//!     be traced back to the policy that produced it.
//!
//! All three run in the same WASM module so the Worker pays one load cost
//! and the `*_version()` triple tells the full story.
//!
//! The allowlist is tuned for the v1 use case: standalone agent-authored
//! documents, including SVG diagrams, served under a strict CSP. The CSP
//! is the load-bearing wall; this sanitizer is "cheap insurance behind it"
//! (see docs/design/action-plan-v1.md, "The security model, stated plainly").
//!
//! What we deliberately strip even though CSP would also stop it:
//!   - `<script>`, `<iframe>`, `<object>`, `<embed>` — ammonia default
//!   - `<meta http-equiv="refresh">` — CSP cannot block this; we drop <meta>
//!   - `javascript:` / `vbscript:` URLs — ammonia default url_schemes
//!   - `target` on links without `rel=noopener` — link_rel enforces it
//!
//! What we add on top of ammonia defaults:
//!   - Structural tags (`<html>`, `<head>`, `<title>`, `<body>`) so agents
//!     can emit full documents, not just fragments
//!   - `<style>` blocks (v1.4) — re-enabled by removing `style` from ammonia's
//!     default `clean_content_tags` and adding it to the tag allowlist, so a
//!     full class-based stylesheet (a class-based design system) can ship inline
//!     in one document. Its content is RAWTEXT: the HTML parser splits it at
//!     `</style>` and never re-parses it as HTML (a literal `<script>` inside a
//!     `<style>` is inert CSS, not an element), so there is no breakout. The
//!     CSS-load vectors that motivate stripping `<style>` are owned by the CSP,
//!     not the sanitizer: `style-src 'unsafe-inline' data:` / `img-src 'self'
//!     data:` / `font-src 'self' data:` carry NO external origin, so a remote
//!     `@import`, `background:url(https://…)` exfil, or external `@font-face`
//!     simply can't load; a `data:` `@import` is inline-equivalent CSS under the
//!     same CSP and cannot escalate. `expression()`/`-moz-binding` are dead in
//!     modern engines. We therefore do NOT CSS-parse `<style>` content (no
//!     `@import` regex pass) — it would risk corrupting valid CSS while adding
//!     nothing CSP doesn't already guarantee. Mutation-XSS via RAWTEXT/namespace
//!     confusion is closed generically by ammonia's `check_expected_namespace`.
//!   - SVG drawing primitives + their geometry/presentation attributes
//!   - `role` and `aria-*` attributes for accessibility, minus four
//!     IDREF-typed attributes that enable accessibility-tree hijack
//!     (see WICG/sanitizer-api#245). All other aria-* are name-only safe
//!     under our sandbox+CSP — DOMPurify allows them by the same logic.

use ammonia::Builder;
use std::collections::{HashMap, HashSet};
use wasm_bindgen::prelude::*;

/// Structural tags so an agent can POST a complete `<html>…</html>` document
/// rather than a body fragment. Ammonia defaults strip these.
const STRUCTURAL_TAGS: &[&str] = &["html", "head", "title", "body"];

/// `<style>` — re-enabled (v1.4) so a document can ship a single inline
/// stylesheet (a class-based design system: `:root` tokens, classes,
/// `:hover`/`:focus`, `@media (prefers-color-scheme)`, `@keyframes`). Ammonia's
/// default treats `style` as a *clean-content* tag (drops the element AND its
/// CSS text), so allowing it takes two steps in `make_builder`: add it to the
/// tag allowlist AND remove it from `clean_content_tags`. Safety lives in the
/// CSP, not here — see the module-level note. No `<style>` attributes are
/// allowed (ammonia drops unknown attrs), so it always serializes as a bare
/// `<style>…</style>`; the CSS round-trips verbatim as RAWTEXT.
const STYLESHEET_TAGS: &[&str] = &["style"];

/// Non-allowed elements whose *content* we DROP rather than keep as text
/// (added to ammonia's `clean_content_tags`, joining the default `script`).
/// These are parser-special containers: their inner content is RAWTEXT or
/// parsed in an insertion mode that turns nested markup into bare text, so the
/// usual "strip the tag, keep the text" behavior leaks their content as
/// *visible escaped/orphaned text* in the sanitized render (GitHub issue #41):
///   - `<noscript>` — a no-JS fallback we never want; its body is RAWTEXT, so
///     `<noscript><style>…</style></noscript>` would serialize the `<style>` as
///     escaped text.
///   - `<select>` / `<textarea>` — form controls (no input surface); a `<style>`
///     (or other markup) inside them is dropped/escaped by the parser into bare
///     text, which then survives as a visible run like `.x{color:red}`.
/// None are in the allowlist, so there is no `tags` ∩ `clean_content_tags`
/// overlap (which would panic). `<script>`/`<style>` are handled above.
const DROP_CONTENT_TAGS: &[&str] = &["noscript", "select", "textarea"];

/// Tags ammonia's default allowlist omits but our publishing contract treats
/// as allowed. Two gaps, both benign containers with no script/URL surface:
///   - `<section>` — block container. Ammonia ships its siblings
///     `article`/`aside`/`header`/`footer`/`nav`/`hgroup`/`figure`/`figcaption`
///     but not `section`; without it, `<section style="…">…</section>` is
///     unwrapped, dropping the wrapper *and* its inline styling.
///   - `<tfoot>` — table footer section. Ammonia ships `thead`/`tbody` but not
///     `tfoot`; without it the footer rows are reparented out of position (the
///     `<tfoot>` is unwrapped and its `<tr>`s float up under the body).
/// `<main>` and `<address>` are deliberately NOT re-added; skills/publishing.md
/// documents them as stripped (use `<section>`/`<div>` instead).
const EXTRA_TAGS: &[&str] = &["section", "tfoot"];

/// HTML attributes our publishing contract lists as broadly allowed but
/// ammonia's defaults don't grant generically (its generic set is only
/// `lang`/`title`). `dir` is enumerated (`ltr`/`rtl`/`auto`) — no URL or
/// script surface — so granting it on any element is safe and matches the
/// "Common attributes" table in skills/publishing.md.
const HTML_GENERIC_ATTRS: &[&str] = &["dir"];

/// SVG tags we permit. Drawing + grouping + text + gradients + clipping.
/// No `<foreignObject>` (re-enables HTML context inside SVG) and no
/// `<script>` (covered by tag stripping anyway).
const SVG_TAGS: &[&str] = &[
    "svg", "g", "defs", "symbol", "use", "marker", "title", "desc",
    "path", "rect", "circle", "ellipse", "line", "polyline", "polygon",
    "text", "tspan", "textPath",
    "linearGradient", "radialGradient", "stop",
    "pattern", "clipPath", "mask", "filter",
    "feGaussianBlur", "feOffset", "feMerge", "feMergeNode", "feColorMatrix",
];

/// IDREF/IDREFS-typed ARIA attributes deliberately *denied* even though we
/// otherwise allow the `aria-*` prefix. These re-parent or re-target
/// elements in the accessibility tree and can hide content (or make
/// content reference attacker-controlled IDs) for assistive-tech users
/// without changing the visible DOM. Documented in WICG/sanitizer-api#245
/// and stripped by the browser-native HTML Sanitizer API by default.
const DENIED_ARIA_ATTRS: &[&str] = &[
    "aria-owns",             // re-parents elements in the AT tree
    "aria-controls",         // asserts a control relationship between elements
    "aria-activedescendant", // mis-points AT focus
    "aria-flowto",           // overrides AT reading order
];

/// Attributes shared across many SVG elements (presentation + geometry).
/// Granted generically rather than per-tag so adding a new SVG tag above
/// doesn't require a matching attribute list.
const SVG_GENERIC_ATTRS: &[&str] = &[
    "id", "class", "style", "transform",
    "fill", "fill-opacity", "fill-rule",
    "stroke", "stroke-width", "stroke-opacity", "stroke-linecap",
    "stroke-linejoin", "stroke-dasharray", "stroke-dashoffset", "stroke-miterlimit",
    "opacity", "color", "visibility", "display",
    "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry",
    "width", "height", "d", "points", "viewBox", "preserveAspectRatio",
    "xmlns", "xmlns:xlink", "version",
    "offset", "stop-color", "stop-opacity",
    "gradientUnits", "gradientTransform", "spreadMethod",
    "patternUnits", "patternContentUnits",
    "clip-path", "mask", "filter",
    "marker-start", "marker-mid", "marker-end",
    "text-anchor", "dominant-baseline", "font-size", "font-family", "font-weight",
    "dx", "dy", "rotate", "lengthAdjust", "textLength",
];

/// Build a fresh `Builder`. Ammonia builders aren't `Send`, so we don't
/// memoize across calls — cheap to construct anyway.
fn make_builder() -> Builder<'static> {
    let mut b = Builder::default();

    // Additive: keeps ammonia's curated default tag list (a/p/h1/etc).
    let mut extra: HashSet<&str> = HashSet::new();
    extra.extend(STRUCTURAL_TAGS.iter().copied());
    extra.extend(EXTRA_TAGS.iter().copied());
    extra.extend(SVG_TAGS.iter().copied());
    extra.extend(STYLESHEET_TAGS.iter().copied());
    b.add_tags(extra);

    // `<style>` is in ammonia's default `clean_content_tags` (the element AND
    // its CSS text are dropped). Adding it to `tags` above only keeps the empty
    // element; removing it here keeps the CSS too. See STYLESHEET_TAGS and the
    // module-level note for why this is safe under the render CSP.
    b.rm_clean_content_tags(STYLESHEET_TAGS);

    // Drop the CONTENT of parser-special containers we don't allow, so their
    // RAWTEXT/orphaned text can't leak into the render + text channel as visible
    // escaped markup (issue #41). Additive — keeps the default `script`.
    b.add_clean_content_tags(DROP_CONTENT_TAGS.iter().copied());

    // Generic attributes — allowed on any element. Ammonia merges with
    // its per-tag attribute defaults rather than replacing them.
    let mut generic: HashSet<&str> = HashSet::new();
    generic.extend(SVG_GENERIC_ATTRS.iter().copied());
    generic.extend(HTML_GENERIC_ATTRS.iter().copied());
    generic.insert("role"); // single enumerated value; safe to allow globally
    b.add_generic_attributes(generic);

    // Forward-compatible `aria-*` allow via prefix matching. ARIA gains
    // attributes between spec versions (1.2 → 1.3 → …); a prefix matcher
    // tracks the spec without us touching the list. Values are plain
    // DOMStrings — no scheme/URL parsing risk — so name-only allow is
    // sufficient (matches DOMPurify's behavior).
    b.add_generic_attribute_prefixes(["aria-"]);

    // Belt: deny the four IDREF-typed ARIA attributes that the prefix
    // matcher would otherwise let through. These are the only ARIA
    // attributes with a documented integrity attack against assistive-tech
    // users that our sandbox+CSP can't defang.
    b.attribute_filter(|_element, attribute, value| {
        if DENIED_ARIA_ATTRS.contains(&attribute) {
            None
        } else {
            Some(value.into())
        }
    });

    // `xlink:href` on <use> and friends. ammonia's `add_tag_attributes`
    // takes a map of tag -> attrs.
    let mut per_tag: HashMap<&str, HashSet<&str>> = HashMap::new();
    for t in &["use", "textPath", "a"] {
        per_tag.entry(t).or_default().insert("xlink:href");
        per_tag.get_mut(t).unwrap().insert("href");
    }

    // List presentation attributes ammonia's defaults omit (it grants only
    // `start` on <ol>). The publishing contract lists start/reversed/value/type
    // as allowed; add the missing three on their elements. Presentational
    // only — enumerated/numeric values, no script or URL surface.
    per_tag.entry("ol").or_default().extend(["reversed", "type"]);
    per_tag.entry("ul").or_default().insert("type");
    per_tag.entry("li").or_default().extend(["value", "type"]);

    for (tag, attrs) in per_tag {
        b.add_tag_attributes(tag, attrs);
    }

    // Anti-tabnabbing: every <a target=...> gets rel="noopener noreferrer"
    // injected, so the secret URL doesn't leak via Referer / window.opener.
    b.link_rel(Some("noopener noreferrer"));

    b
}

/// Sanitize `html` and return the cleaned string.
///
/// Exposed to JS as `sanitize(html: string): string`.
#[wasm_bindgen]
pub fn sanitize(html: &str) -> String {
    let cleaned = make_builder().clean(html).to_string();
    add_new_tab_targets(&cleaned)
}

/// Version tag for the active allowlist. Bumped whenever the rules above
/// change in a way that affects output; recorded on each write so we can
/// trace a stored byte stream back to the policy that produced it.
#[wasm_bindgen]
pub fn sanitizer_version() -> String {
    // v1   — initial allowlist (structural + SVG + link rel injection)
    // v1.1 — added `role` + `aria-*` (with 4 IDREF aria attrs denied)
    // v1.2 — inject target="_blank" on external (http/https) <a> links so a
    //        click opens a new tab instead of dead-ending against frame-src
    // v1.3 — reconcile the allowlist with the published contract, which named
    //        several tags/attributes ammonia's defaults silently dropped:
    //        re-allow <section> and <tfoot> (omitted by ammonia, so unwrapped),
    //        grant `dir` generically, and grant `reversed`/`value`/`type` on
    //        list elements (ammonia granted only `start` on <ol>).
    // v1.4 — allow <style> blocks: remove `style` from ammonia's default
    //        `clean_content_tags` and add it to the tag allowlist so a full
    //        class-based stylesheet (a class-based design system) ships inline.
    //        CSS round-trips verbatim as RAWTEXT; external CSS loads (@import,
    //        url(), @font-face) stay blocked by the render CSP, not the parser.
    // v1.5 — drop the CONTENT of <noscript>/<select>/<textarea> (add them to
    //        clean_content_tags) so their RAWTEXT/orphaned text can't leak into
    //        the render + text channel as visible escaped markup (issue #41).
    // v1.6 — new-tab pass also fires on ON-PLATFORM document links
    //        (`href="/d/…"` / `href="/s/…"`), which dead-ended in the render
    //        frame exactly like external ones; and the pass itself is now
    //        raw-text aware and bounded, so `<style>` CSS that merely looks
    //        like an anchor can't be spliced into (or rescanned quadratically).
    "ammonia-v1.6".to_string()
}

// ---------------------------------------------------------------------------
// New-tab link pass (sanitizer v1.2; on-platform links added in v1.6).
//
// `sanitize()` runs this on the OUTPUT of `clean()`. Two kinds of link get
// `target="_blank"` so a click opens a new browser tab, because both dead-end
// when they navigate the render iframe itself:
//   - EXTERNAL `http://…` / `https://…` — in-frame navigation off-origin is
//     blocked by the render shell's `frame-src 'self'` CSP, and most sites
//     refuse framing anyway.
//   - ON-PLATFORM document links `href="/d/…"` / `href="/s/…"` (v1.6) — the
//     cross-document form this platform prescribes (skills/publishing.md
//     "Cross-referencing"; scripts/doc-web.mjs rewrites the whole mirrored
//     corpus into it). Both URLs serve the *shell* page, whose CSP carries
//     `frame-ancestors 'none'`, so the browser refuses to render it nested and
//     the frame goes blank. Before v1.6 every cross-document link in the corpus
//     died on click while the same target written as an absolute same-host URL
//     worked — a silently form-dependent break of the linking feature.
// The render iframe's sandbox carries `allow-popups
// allow-popups-to-escape-sandbox` so that tab opens as a normal context (see
// src/serve.ts SANDBOX; top navigation stays OFF by design), and `link_rel`
// has already forced `rel="noopener noreferrer"` on any anchor carrying a
// target, so the new tab can't reach `window.opener`.
//
// Scope is deliberately narrow:
//   - `href="http://…"` / `href="https://…"` (scheme matched case-insensitively
//     — schemes are), plus `href="/d/…"` / `href="/s/…"` (path matched
//     case-SENSITIVELY — paths are, and the routes are lowercase). Everything
//     else keeps the in-frame default: `#fragment` (a section jump must stay a
//     scroll), other relative paths, `mailto:`/`tel:`.
//   - The on-platform prefixes require a literal `d`/`s` immediately after a
//     single leading `/`, so a PROTOCOL-RELATIVE `//evil.example` (and the
//     `/\evil.example` browsers normalize into one) can never qualify as
//     on-platform — those are cross-origin, and only the http(s) rule opens
//     them.
//   - `href` is matched only at a whitespace boundary, so `xlink:href` on an
//     SVG anchor is left alone (v1 doesn't new-tab SVG links).
//
// Why a localized byte splice rather than a re-parse: re-serializing would
// churn SVG/text bytes we have no reason to touch, and `modified` should flip
// only for documents that actually gained a target.
//
// What makes the splice safe is NOT that the whole input is well-formed markup.
// It isn't, and hasn't been since v1.4: `<style>` content rides through
// verbatim as RAWTEXT, so CSS mentioning `<a href="…"` is plain *text* sitting
// in the byte stream (an earlier revision of this comment claimed ammonia's
// normalized serialization as the precondition — that stopped being true the
// day `<style>` was allowed, and the pass spliced ` target="_blank"` into
// whatever tag the CSS's quote parity landed on). The invariant we actually
// rely on is that a `<a` is only ever considered at a TEXT position:
//   - raw-text elements (RAW_TEXT_TAGS) are skipped content and all, and
//   - every other element's start-tag interior is jumped over, so a `<a` inside
//     an attribute value (`<` is not escaped there) isn't an anchor either.
// Tag scans are bounded (`find_unquoted_gt`), so a mis-read can never rescan to
// end-of-input and the pass stays O(n) — it used to be quadratic, ~2 s on a
// 120 KB document built to trip it. Bytes we don't rewrite are copied verbatim.
//
// Not a trust boundary: a miss merely leaves a link opening in-frame (the
// pre-v1.2 behavior). The security wall is the sandbox + CSP at render and the
// ammonia allowlist above; this pass only chooses where an already-allowed
// link opens.

const ASCII_WS: &[u8] = b" \t\n\r\x0c";

fn is_ascii_ws(b: u8) -> bool {
    ASCII_WS.contains(&b)
}

/// Elements whose content the HTML parser tokenizes as TEXT (RAWTEXT / RCDATA /
/// PLAINTEXT), so a `<…>` inside them is never an element. Mirrors the set
/// `src/depth.ts` skips for the same reason. `<style>` is the one that actually
/// reaches us (v1.4 allows it, and html5ever re-serializes its CSS unescaped);
/// the rest are cheap insurance against a future allowlist change. `<title>` is
/// the one that *does* survive `clean()` (it's in the structural allowlist), but
/// skipping it can't cost us an anchor: outside SVG the parser tokenizes its
/// content as RCDATA so a nested `<a>` comes back escaped as text, and inside
/// SVG ammonia drops the element outright.
const RAW_TEXT_TAGS: &[&str] = &[
    "style", "script", "textarea", "title", "xmp", "iframe", "noembed",
    "noframes", "plaintext",
];

/// Hard bound on a start-tag scan. Ammonia's own output never approaches it (a
/// start tag is a name plus quoted attributes), so the cap only fires on bytes
/// the scan mis-read — where "this isn't a tag" is the right answer anyway.
/// Without it, one unbalanced quote lets a single scan run to end-of-input.
const MAX_START_TAG_BYTES: usize = 8192;

fn add_new_tab_targets(html: &str) -> String {
    // Cheap bail-out: no `href="` at all ⇒ nothing to rewrite. Ammonia always
    // lowercases attribute names and double-quotes values, so this needle has
    // no false negatives. (`xlink:href="` contains it too — harmless: the loop
    // then finds no whitespace-bounded `href` to act on.)
    if !html.contains("href=\"") {
        return html.to_string();
    }

    let b = html.as_bytes();
    let mut out = String::with_capacity(html.len() + 24);
    let mut copied = 0usize; // bytes [0, copied) already flushed to `out`
    let mut i = 0usize;
    while i < b.len() {
        if b[i] != b'<' {
            i += 1;
            continue;
        }
        // A raw-text element's content is text, not markup: skip past the whole
        // element so CSS that merely looks like an anchor is never spliced into.
        if let Some(resume) = raw_text_element_end(b, i) {
            i = resume.max(i + 1);
            continue;
        }
        let Some(rel_gt) = find_unquoted_gt(&b[i..]) else {
            // No start tag closes here within the bound — a stray `<` in text,
            // or a truncated tag. Not something we rewrite; step over the `<`.
            i += 1;
            continue;
        };
        let gt = i + rel_gt; // index of this tag's closing '>'
        if is_anchor_start(&b[i..]) {
            let tag = &html[i..=gt];
            if let Some(rewritten) = tag_with_blank_target(tag) {
                out.push_str(&html[copied..i]);
                out.push_str(&rewritten);
                copied = gt + 1;
            }
        }
        // Resume AFTER the tag either way: its interior is attribute territory,
        // and `<` isn't escaped in an attribute value.
        i = gt + 1;
    }
    out.push_str(&html[copied..]);
    out
}

/// `s` starts an HTML anchor open tag: `<a` then a delimiter, so `<abbr>` /
/// `<article>` / `<aside>` don't match. Tag names are lowercase in ammonia's
/// output.
fn is_anchor_start(s: &[u8]) -> bool {
    s.len() >= 3 && s[1] == b'a' && (s[2] == b'>' || s[2] == b'/' || is_ascii_ws(s[2]))
}

/// If `b[at..]` opens a raw-text element, return the offset to resume scanning
/// at: the `<` of its matching close tag, or `b.len()` when it never closes
/// (everything after an unterminated `<style>` is CSS, not markup). `None` when
/// this isn't a raw-text open tag. The skipped bytes are still copied through
/// verbatim — the caller only stops *looking* at them.
fn raw_text_element_end(b: &[u8], at: usize) -> Option<usize> {
    let name = RAW_TEXT_TAGS.iter().find(|t| starts_tag(b, at, t))?;
    let content = match find_unquoted_gt(&b[at..]) {
        Some(rel) => at + rel + 1,
        // Malformed open tag: nothing after it is parseable as markup either.
        None => return Some(b.len()),
    };
    Some(find_close_tag(b, content, name).unwrap_or(b.len()))
}

/// `b[at..]` is `<name` followed by a tag-name delimiter. ASCII-case-insensitive
/// even though ammonia lowercases, so a hand-fed test string behaves the same.
fn starts_tag(b: &[u8], at: usize, name: &str) -> bool {
    let n = name.as_bytes();
    let end = at + 1 + n.len();
    b.len() > end
        && b[at] == b'<'
        && b[at + 1..end].eq_ignore_ascii_case(n)
        && (b[end] == b'>' || b[end] == b'/' || is_ascii_ws(b[end]))
}

/// Offset of the `</name` that ends a raw-text element's content — the HTML
/// tokenizer's rule, so the name must be followed by a delimiter (`</styles>`
/// does not close a `<style>`). `None` when the element never closes.
fn find_close_tag(b: &[u8], from: usize, name: &str) -> Option<usize> {
    let n = name.as_bytes();
    let mut i = from;
    while i + 2 + n.len() < b.len() {
        if b[i] == b'<'
            && b[i + 1] == b'/'
            && b[i + 2..i + 2 + n.len()].eq_ignore_ascii_case(n)
        {
            let after = b[i + 2 + n.len()];
            if after == b'>' || after == b'/' || is_ascii_ws(after) {
                return Some(i);
            }
        }
        i += 1;
    }
    None
}

/// Offset of the first `>` not inside a quoted value, scanning a start tag.
/// Honors both quote styles (ammonia emits only double quotes). `None` when the
/// tag doesn't close within `MAX_START_TAG_BYTES`, or when an UNQUOTED `<`
/// comes first — that byte can only open another tag, so whatever we were
/// scanning was never a start tag. Both exits keep one mis-read `<a` from
/// dragging the scan across the rest of the document.
fn find_unquoted_gt(s: &[u8]) -> Option<usize> {
    let mut quote: u8 = 0;
    for (i, &c) in s.iter().take(MAX_START_TAG_BYTES).enumerate() {
        if quote == 0 {
            match c {
                b'"' | b'\'' => quote = c,
                b'>' => return Some(i),
                b'<' if i > 0 => return None,
                _ => {}
            }
        } else if c == quote {
            quote = 0;
        }
    }
    None
}

/// If `tag` (a full `<a …>` start tag) has a new-tab-worthy `href` and no
/// `target`, return it with ` target="_blank"` spliced before the closing
/// `>`. Otherwise `None` (caller keeps the original bytes).
fn tag_with_blank_target(tag: &str) -> Option<String> {
    // `target` never survives ammonia today; check anyway so a future
    // allowlist change can't make us double-inject.
    if attr_at_boundary(tag, "target=") || !href_opens_new_tab(tag) {
        return None;
    }
    let bytes = tag.as_bytes();
    let gt = tag.rfind('>')?;
    // Anchors serialize as non-void `<a …>`; handle a stray `/>` defensively.
    let at = if gt > 0 && bytes[gt - 1] == b'/' { gt - 1 } else { gt };
    let mut out = String::with_capacity(tag.len() + 16);
    out.push_str(&tag[..at]);
    out.push_str(" target=\"_blank\"");
    out.push_str(&tag[at..]);
    Some(out)
}

/// True when `tag` has a whitespace-bounded `href="…"` that must open in a new
/// tab: an external `http(s)` URL, or an on-platform document path. The
/// boundary check excludes `xlink:href`.
fn href_opens_new_tab(tag: &str) -> bool {
    // `to_ascii_lowercase` maps only ASCII, so it's byte-length preserving:
    // an offset found in `lower` addresses the same char boundary in `tag`.
    // We match the *scheme* on the lowered copy (schemes are case-insensitive)
    // and the *path* on the original bytes (paths are not).
    let lower = tag.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    let mut from = 0;
    while let Some(rel) = lower[from..].find("href=\"") {
        let at = from + rel;
        if at == 0 || is_ascii_ws(bytes[at - 1]) {
            let val_at = at + 6; // 6 == "href=\"".len()
            let lower_val = &lower[val_at..];
            if lower_val.starts_with("http://")
                || lower_val.starts_with("https://")
                || is_on_platform_path(&tag[val_at..])
            {
                return true;
            }
        }
        from = at + 6;
    }
    false
}

/// True for the on-platform document namespaces, `/d/…` and `/s/…` (v1.6).
///
/// This is a PREFIX test, not a route matcher: it deliberately covers every
/// path under those two roots, so `/d/<id>`, `/d/<id>/raw` and `/s/<slug>` all
/// qualify. That is the intent — they are all same-origin document URLs a
/// reader may legitimately link to, and the new tab is what keeps them from
/// dead-ending against the shell's `frame-ancestors 'none'`. Narrowing this to
/// an exact id/slug shape would buy nothing: the target is same-origin either
/// way, and an unrecognized path just 404s.
///
/// The literal `d`/`s` right after a single leading `/` is
/// what keeps this same-origin-only: a protocol-relative `//evil.example` — or
/// the `/\evil.example` that browsers normalize into one — has a second `/`
/// or `\` there and never matches. Any other relative href (`#frag`, `/other`,
/// `page.html`) stays in-frame.
fn is_on_platform_path(val: &str) -> bool {
    val.starts_with("/d/") || val.starts_with("/s/")
}

/// True when `tag` contains `needle` (e.g. `"target="`) at a whitespace
/// boundary, so `data-target=` and similar don't count.
fn attr_at_boundary(tag: &str, needle: &str) -> bool {
    let lower = tag.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    let mut from = 0;
    while let Some(rel) = lower[from..].find(needle) {
        let at = from + rel;
        if at == 0 || is_ascii_ws(bytes[at - 1]) {
            return true;
        }
        from = at + needle.len();
    }
    false
}

/// Convert Markdown input to HTML.
///
/// Called at write time when the caller's `Content-Type` is `text/markdown`
/// (HTTP) or they used the `*_markdown` MCP tool. The output is plain HTML
/// — pulldown-cmark does no escaping of inline HTML the author included
/// (CommonMark allows it), and we don't either. The caller MUST run
/// `sanitize()` on the result before storing. Treating this function as a
/// trust boundary on its own would be wrong: a Markdown document with a
/// raw `<script>` block reaches `sanitize()` exactly the same way a pure-
/// HTML document with `<script>` does.
///
/// GFM extensions enabled: tables, strikethrough, task lists, footnotes.
/// (Smart-punctuation and heading-id-attributes are deliberately OFF —
/// they reinterpret the author's text without their say-so.) Task-list
/// `<input>` checkboxes survive the parser but get stripped by `sanitize()`
/// (form controls aren't in the allowlist); the surrounding `<li>` text
/// content remains, and the `stripped[]` advisory tells the agent what
/// happened on the response.
///
/// Exposed to JS as `markdown_to_html(md: string): string`.
#[wasm_bindgen]
pub fn markdown_to_html(md: &str) -> String {
    use pulldown_cmark::{html, Options, Parser};

    let mut opts = Options::empty();
    opts.insert(Options::ENABLE_TABLES);
    opts.insert(Options::ENABLE_STRIKETHROUGH);
    opts.insert(Options::ENABLE_TASKLISTS);
    opts.insert(Options::ENABLE_FOOTNOTES);

    let parser = Parser::new_ext(md, opts);
    let mut out = String::new();
    html::push_html(&mut out, parser);
    out
}

/// Identifier of the active Markdown-input parser configuration. Bumped
/// whenever the option set above changes in a way that could affect output
/// (new GFM extension turned on, parser upgrade with changed semantics).
/// Stamped on write responses so an agent that toggled formats can tell
/// which pipeline produced a given version.
#[wasm_bindgen]
pub fn md_input_version() -> String {
    // v1 — pulldown-cmark 0.13 + GFM (tables, strikethrough, tasklists, footnotes)
    "pulldown-cmark-v1".to_string()
}

/// Convert sanitized HTML to Markdown for agent context windows.
///
/// Called at read time on bytes that have already been through `sanitize()`
/// — never on raw agent input. Two reasons that order matters: (1) the text
/// path reflects exactly what the renderer would show, not what the agent
/// tried to ship; (2) anything the sanitizer strips can't leak back through
/// the text channel.
///
/// Output shape: GFM-flavored Markdown with the structures our allowlist
/// can produce (headings, lists, tables, code, blockquotes, links, inline
/// emphasis) plus `[Image: <alt>]` placeholders for inline SVG, where
/// `<alt>` comes from `<title>`/`<desc>`/root `aria-label` if present.
///
/// Exposed to JS as `html_to_markdown(html: string): string`.
#[wasm_bindgen]
pub fn html_to_markdown(html: &str) -> String {
    markdown::convert(html)
}

/// Maximum node-nesting depth of a sanitized HTML string, measured iteratively
/// (stack-safe). The write path screens documents with this and rejects deeply
/// nested input BEFORE the recursive `html_to_markdown` runs on it, so a
/// depth-bomb can't overflow the WASM stack (GitHub issue #41). Exposed to JS as
/// `max_dom_depth(html: string): number`.
#[wasm_bindgen]
pub fn max_dom_depth(html: &str) -> u32 {
    markdown::max_depth(html)
}

/// Identifier of the active text-conversion policy. Bumped whenever output
/// shape changes in a way that an existing consumer might notice (new tag
/// support, different SVG alt-text format, list-style change, etc.).
/// Stamped on the read response alongside `sanitizer_version` so an agent
/// can compare across reads if confused.
#[wasm_bindgen]
pub fn converter_version() -> String {
    // v1 — initial GFM emitter (headings, lists, tables, code, blockquote,
    //      links, inline emphasis, [Image: …] for inline SVG)
    // v2 — three accumulated output-shape changes stamped together. The first
    //      two shipped WITHOUT a bump (this constant sat at v1 from the day it
    //      was written), so a consumer following the documented "compare
    //      converter_v across reads" advice saw no signal when the bytes moved:
    //        · block-spacing/whitespace tweaks
    //        · `|` escaped as `\|` inside inline-code table cells, so a pipe in
    //          a code span no longer splits the row on re-publish
    //        · `<pre>` fences widened to max(3, longest backtick run + 1) per
    //          CommonMark, so ```-containing content can't escape the block
    //      Any future edit to markdown.rs that changes emitted bytes bumps this
    //      in the same commit — same discipline as `sanitizer_version()`.
    "awh-md-v2".to_string()
}

mod markdown;

// ============================================================================
// Tests — hostile-element stripping corpus.
//
// Negative assertions only: "given input X, output does not contain Y."
// These guard against silent allowlist widening (a future edit that
// accidentally permits a dangerous tag/attr/URL scheme will break a test).
//
// `cargo test -p sanitizer` runs the whole suite against the host build
// — much faster than going through the WASM bridge, and the underlying
// `make_builder()` is identical on both targets.
// ============================================================================

#[cfg(test)]
mod tests {
    // The new-tab pass is exercised directly (not just through `sanitize`) by
    // the linear-scan regression at the bottom, which times that pass alone.
    use super::{add_new_tab_targets, sanitize};

    /// Assert the sanitized output does NOT contain `forbidden`, case-insensitive.
    /// html5ever lowercases tag names, so case-insensitive matching avoids
    /// false negatives from tag normalization.
    fn assert_strips(input: &str, forbidden: &str) {
        let out = sanitize(input);
        let out_lc = out.to_lowercase();
        let bad_lc = forbidden.to_lowercase();
        assert!(
            !out_lc.contains(&bad_lc),
            "expected `{}` to be stripped\n  input:  {:?}\n  output: {:?}",
            forbidden,
            input,
            out,
        );
    }

    /// Same as `assert_strips`, but checks several forbidden tokens at once.
    fn assert_strips_all(input: &str, forbidden: &[&str]) {
        for bad in forbidden {
            assert_strips(input, bad);
        }
    }

    // ----- inline <script> --------------------------------------------------

    #[test]
    fn strips_inline_script() {
        assert_strips_all("<script>alert(1)</script>", &["<script", "alert(1)"]);
    }

    #[test]
    fn strips_script_with_external_src() {
        assert_strips_all(
            "<script src=\"https://attacker.example/x.js\" defer></script>",
            &["<script", "attacker"],
        );
    }

    #[test]
    fn strips_uppercase_script() {
        assert_strips_all("<SCRIPT>alert(1)</SCRIPT>", &["<script", "alert(1)"]);
    }

    #[test]
    fn strips_script_with_whitespace_in_attrs() {
        assert_strips(
            "<script   type = \"text/javascript\" >alert(1)</script>",
            "alert(1)",
        );
    }

    #[test]
    fn strips_noscript() {
        // <noscript> can carry content that renders when JS is off; not
        // dangerous by itself but not in our allowlist either.
        assert_strips("<noscript><img src=x onerror=alert(1)></noscript>", "<noscript");
    }

    // ----- inline event handlers --------------------------------------------

    #[test]
    fn strips_img_onerror() {
        assert_strips("<img src=x onerror=\"alert(1)\">", "onerror");
    }

    #[test]
    fn strips_anchor_onclick() {
        assert_strips(
            "<a href=\"https://example.com\" onclick=\"alert(1)\">x</a>",
            "onclick",
        );
    }

    #[test]
    fn strips_body_onload() {
        assert_strips("<body onload=\"alert(1)\">x</body>", "onload");
    }

    #[test]
    fn strips_uppercase_event_handler() {
        assert_strips("<img src=x ONERROR=alert(1)>", "onerror");
    }

    #[test]
    fn strips_mixed_case_event_handler() {
        assert_strips("<img src=x OnError=alert(1)>", "onerror");
    }

    #[test]
    fn strips_event_handler_on_svg_root() {
        assert_strips(
            "<svg onload=\"alert(1)\"><circle cx=5 cy=5 r=4/></svg>",
            "onload",
        );
    }

    #[test]
    fn strips_entity_encoded_event_handler_payload() {
        // The on* attribute itself is removed regardless of value.
        assert_strips(
            "<img src=x onerror=\"alert&#40;1&#41;\">",
            "onerror",
        );
    }

    // ----- javascript: / vbscript: / data: URLs -----------------------------

    #[test]
    fn strips_javascript_url_in_href() {
        assert_strips("<a href=\"javascript:alert(1)\">x</a>", "javascript:");
    }

    #[test]
    fn strips_javascript_url_uppercase() {
        assert_strips("<a href=\"JAVASCRIPT:alert(1)\">x</a>", "javascript:");
    }

    #[test]
    fn strips_javascript_url_with_leading_space() {
        // Browsers ignore leading whitespace in URL attributes.
        assert_strips("<a href=\" javascript:alert(1)\">x</a>", "javascript:");
    }

    #[test]
    fn strips_javascript_url_with_embedded_tab() {
        // Browsers strip tab/CR/LF from URLs before scheme matching.
        assert_strips("<a href=\"java\tscript:alert(1)\">x</a>", "javascript:");
    }

    #[test]
    fn strips_vbscript_url() {
        assert_strips("<a href=\"vbscript:msgbox(1)\">x</a>", "vbscript:");
    }

    #[test]
    fn strips_data_url_in_href() {
        // data:text/html lets a click navigate the iframe to attacker-served HTML.
        assert_strips(
            "<a href=\"data:text/html,<script>alert(1)</script>\">x</a>",
            "data:",
        );
    }

    #[test]
    fn strips_javascript_url_in_img_src() {
        assert_strips("<img src=\"javascript:alert(1)\">", "javascript:");
    }

    // ----- <meta http-equiv="refresh"> --------------------------------------

    #[test]
    fn strips_meta_refresh() {
        assert_strips_all(
            "<meta http-equiv=\"refresh\" content=\"0;url=https://attacker.example/\">",
            &["<meta", "attacker"],
        );
    }

    #[test]
    fn strips_meta_refresh_uppercase() {
        assert_strips_all(
            "<META HTTP-EQUIV=\"REFRESH\" CONTENT=\"0;url=https://attacker.example/\">",
            &["<meta", "attacker"],
        );
    }

    #[test]
    fn strips_meta_refresh_unquoted_attrs() {
        assert_strips(
            "<meta http-equiv=refresh content=0;url=https://attacker.example/>",
            "attacker",
        );
    }

    // ----- embedded content -------------------------------------------------

    #[test]
    fn strips_iframe() {
        assert_strips_all(
            "<iframe src=\"https://attacker.example/\"></iframe>",
            &["<iframe", "attacker"],
        );
    }

    #[test]
    fn strips_iframe_srcdoc() {
        // srcdoc carries arbitrary inline HTML; iframe itself is the kill.
        assert_strips(
            "<iframe srcdoc=\"<script>alert(1)</script>\"></iframe>",
            "<iframe",
        );
    }

    #[test]
    fn strips_object() {
        assert_strips("<object data=\"https://attacker.example/x.swf\"></object>", "<object");
    }

    #[test]
    fn strips_embed() {
        assert_strips("<embed src=\"https://attacker.example/x.swf\">", "<embed");
    }

    #[test]
    fn strips_applet() {
        assert_strips("<applet code=\"attacker.class\"></applet>", "<applet");
    }

    #[test]
    fn strips_frame_and_frameset() {
        assert_strips(
            "<frameset><frame src=\"https://attacker.example/\"></frameset>",
            "<frame",
        );
    }

    // ----- <base> hijack ----------------------------------------------------

    #[test]
    fn strips_base_tag() {
        assert_strips_all(
            "<base href=\"https://attacker.example/\">",
            &["<base", "attacker"],
        );
    }

    // ----- <style> blocks (v1.4: allowed; safety owned by the CSP) ----------

    #[test]
    fn keeps_style_block_and_its_css() {
        // The whole point of v1.4: a class-based stylesheet survives intact so
        // a class-based design system can ship inline in one document.
        let out = sanitize("<style>.fr-card{border-radius:16px;color:#222}</style>");
        assert!(out.contains("<style>"), "style element dropped: {out}");
        assert!(
            out.contains(".fr-card{border-radius:16px;color:#222}"),
            "CSS text mangled: {out}"
        );
    }

    #[test]
    fn keeps_style_block_with_at_rules_and_root_vars() {
        // :root custom properties, @media (prefers-color-scheme), and
        // pseudo-classes are the features that make the class-based system
        // worth enabling — they must round-trip verbatim (RAWTEXT, no escaping).
        let css = ":root{--fr-primary:#6750A4}\
                   .fr-btn:hover{opacity:.92}\
                   @media (prefers-color-scheme:dark){:root{--fr-surface:#1C1B1F}}";
        let out = sanitize(&format!("<style>{css}</style>"));
        assert!(out.contains(css), "at-rules/vars did not round-trip: {out}");
    }

    #[test]
    fn style_block_external_loads_are_left_to_the_csp() {
        // We deliberately do NOT CSS-parse <style> content. An external @import
        // is preserved as text but is inert at render time: the document CSP's
        // style-src has no external origin, so the load never happens. This test
        // pins the contract (style kept, CSS untouched) — the *enforcement* is
        // asserted in the serve-layer CSP tests, not here.
        let out = sanitize("<style>@import url(\"https://attacker.example/leak.css\");</style>");
        assert!(out.contains("<style>"), "style element dropped: {out}");
        assert!(out.contains("@import"), "CSS unexpectedly rewritten: {out}");
    }

    #[test]
    fn style_block_content_is_not_reparsed_as_html() {
        // <style> is RAWTEXT: a literal <script> inside it is CSS text, never an
        // element, so it cannot execute. The first </style> closes the block, so
        // a real (strippable) <script> after it is handled normally.
        let out = sanitize("<style>x{}</style><script>alert(1)</script>");
        assert!(!out.contains("<script"), "script after style survived: {out}");
        assert!(!out.contains("alert(1)"), "script payload survived: {out}");
    }

    // ----- content-drop containers (v1.5, issue #41) ------------------------
    // <noscript>/<select>/<textarea> are parser-special: their content is
    // RAWTEXT or insertion-mode-mangled, so the usual "strip tag, keep text"
    // would leak it as visible escaped/orphaned text. We drop the content.

    #[test]
    fn select_style_content_does_not_leak() {
        // The <style> is killed by in-select parsing; its CSS would otherwise
        // survive as the bare visible text ".x{color:red}".
        let out = sanitize("<select><style>.x{color:red}</style></select><p>after</p>");
        assert!(!out.contains(".x{"), "select CSS text leaked: {out}");
        assert!(!out.contains("color:red"), "select CSS text leaked: {out}");
        assert!(out.contains("<p>after</p>"), "sibling content dropped: {out}");
    }

    #[test]
    fn noscript_content_does_not_leak() {
        // <noscript> body is RAWTEXT — the <style> would serialize as the
        // escaped visible text "&lt;style&gt;…&lt;/style&gt;".
        let out = sanitize("<noscript><style>.y{color:blue}</style></noscript><p>after</p>");
        assert!(!out.contains(".y{"), "noscript content leaked: {out}");
        assert!(!out.contains("color:blue"), "noscript content leaked: {out}");
        assert!(!out.contains("style"), "noscript escaped markup leaked: {out}");
        assert!(out.contains("<p>after</p>"), "sibling content dropped: {out}");
    }

    #[test]
    fn textarea_content_does_not_leak() {
        let out = sanitize("<textarea><style>.z{x:1}</style>placeholder</textarea><p>after</p>");
        assert!(!out.contains(".z{"), "textarea CSS text leaked: {out}");
        assert!(!out.contains("placeholder"), "textarea text leaked: {out}");
        assert!(out.contains("<p>after</p>"), "sibling content dropped: {out}");
    }

    // ----- SVG-specific vectors --------------------------------------------

    #[test]
    fn strips_script_inside_svg() {
        assert_strips_all(
            "<svg><circle cx=5 cy=5 r=4/><script>alert(1)</script></svg>",
            &["<script", "alert(1)"],
        );
    }

    #[test]
    fn strips_foreign_object() {
        // <foreignObject> re-opens an HTML context inside SVG; deny entirely.
        assert_strips_all(
            "<svg><foreignObject><body onload=\"alert(1)\">x</body></foreignObject></svg>",
            &["foreignobject", "onload"],
        );
    }

    #[test]
    fn strips_svg_animate() {
        // <animate> can mutate attributes (e.g. retarget href to javascript:).
        assert_strips(
            "<svg><animate attributeName=\"href\" to=\"javascript:alert(1)\"/></svg>",
            "<animate",
        );
    }

    // ----- form-action and overrides ----------------------------------------

    #[test]
    fn strips_form_with_js_action() {
        assert_strips(
            "<form action=\"javascript:alert(1)\"><input></form>",
            "<form",
        );
    }

    #[test]
    fn strips_button_formaction() {
        // <button formaction> overrides the enclosing form's action.
        assert_strips(
            "<button formaction=\"javascript:alert(1)\">x</button>",
            "formaction",
        );
    }

    // ----- HTML comments + parser quirks ------------------------------------

    #[test]
    fn strips_html_comments_entirely() {
        // Even if browsers don't execute commented-out scripts, comments
        // can hide content from review and aren't in our allowed shape.
        let out = sanitize("<!-- <script>alert(1)</script> -->");
        let lc = out.to_lowercase();
        assert!(!lc.contains("<script"), "got: {:?}", out);
        assert!(!lc.contains("alert(1)"), "got: {:?}", out);
    }

    #[test]
    fn strips_script_inside_malformed_markup() {
        // Unclosed tags shouldn't change the outcome — html5ever tolerates,
        // ammonia still drops the script.
        assert_strips("<p><script>alert(1)</script>", "<script");
    }

    // ----- ARIA: the four IDREF-typed attrs we deliberately deny ----------
    // We allow `role` and the `aria-*` prefix generally (safe under our
    // sandbox+CSP per DOMPurify's analysis), but the four below enable
    // accessibility-tree hijack against assistive-tech users (WICG
    // sanitizer-api#245). Make sure the deny list stays effective.

    #[test]
    fn strips_aria_owns() {
        assert_strips("<div aria-owns=\"victim\">x</div>", "aria-owns");
    }

    #[test]
    fn strips_aria_controls() {
        assert_strips("<div aria-controls=\"victim\">x</div>", "aria-controls");
    }

    #[test]
    fn strips_aria_activedescendant() {
        assert_strips("<div aria-activedescendant=\"victim\">x</div>", "aria-activedescendant");
    }

    #[test]
    fn strips_aria_flowto() {
        assert_strips("<div aria-flowto=\"victim\">x</div>", "aria-flowto");
    }

    // ----- positive sanity: confirm we DO allow role + safe aria-* --------
    // The corpus is otherwise negative-assertion-only. This one positive
    // test exists so a future bug that over-strips (e.g. an attribute_filter
    // that drops everything) gets caught by the suite rather than by
    // production traffic.

    #[test]
    fn keeps_role_and_safe_aria_attrs() {
        let out = sanitize(
            "<div role=\"alert\" aria-label=\"warning\" aria-live=\"polite\" aria-hidden=\"false\">x</div>",
        );
        assert!(out.contains("role=\"alert\""), "got: {}", out);
        assert!(out.contains("aria-label=\"warning\""), "got: {}", out);
        assert!(out.contains("aria-live=\"polite\""), "got: {}", out);
        assert!(out.contains("aria-hidden=\"false\""), "got: {}", out);
    }

    // ----- publishing-contract audit -------------------------------------
    // Pins skills/publishing.md's "What HTML is permitted" tables against the
    // actually-built allowlist. These exist because the contract and the
    // allowlist drifted: ammonia's defaults silently omit <section>, <tfoot>,
    // `dir`, and most list attributes (re-added via EXTRA_TAGS /
    // HTML_GENERIC_ATTRS / the per-tag list attrs in make_builder). If an
    // ammonia upgrade or an allowlist edit drops a documented tag/attribute,
    // these fail loudly here instead of letting an agent discover it in
    // production. Keep in lockstep with skills/publishing.md.

    /// True if `<tag …>` survives sanitization of `input`. Case-folded because
    /// SVG foreign content keeps camelCase while HTML lowercases. Each test
    /// input below contains only the one tag under test, so the prefix match
    /// can't false-positive on a different surviving tag.
    fn tag_survives(input: &str, tag: &str) -> bool {
        sanitize(input)
            .to_lowercase()
            .contains(&format!("<{}", tag.to_lowercase()))
    }

    #[test]
    fn contract_block_heading_inline_list_tags_survive() {
        let tags = [
            // block-level
            "p", "div", "section", "article", "aside", "header", "footer", "nav",
            "hgroup", "figure", "figcaption", "blockquote", "pre", "details", "summary",
            // headings
            "h1", "h2", "h3", "h4", "h5", "h6",
            // inline text
            "span", "strong", "em", "b", "i", "u", "s", "small", "sub", "sup", "code",
            "kbd", "samp", "var", "cite", "q", "abbr", "dfn", "mark", "time", "data",
            "ins", "del", "bdi", "bdo", "ruby", "rt", "rp",
            // lists
            "ul", "ol", "li", "dl", "dt", "dd",
        ];
        for t in tags {
            let input = format!("<{t}>x</{t}>");
            assert!(tag_survives(&input, t), "documented-allowed <{t}> was stripped");
        }
    }

    #[test]
    fn contract_section_keeps_wrapper_and_inline_style() {
        // The exact regression that started this: <section> must survive WITH
        // its inline style, not be unwrapped (which drops the wrapper + style).
        let out =
            sanitize("<section style=\"background:#2B211A; padding:40px\"><p>hi</p></section>");
        assert!(out.contains("<section"), "section wrapper dropped: {}", out);
        assert!(out.contains("#2B211A"), "section lost its inline style: {}", out);
        assert!(out.contains("<p>hi</p>"), "section children dropped: {}", out);
    }

    #[test]
    fn contract_style_block_survives() {
        // Pins the v1.4 allowance: a <style> block must survive sanitization,
        // guarding against an accidental future re-strip (e.g. an ammonia
        // upgrade re-adding `style` to its clean_content_tags).
        let out = sanitize("<style>.x{color:#333}</style>");
        assert!(out.contains("<style"), "style block dropped: {}", out);
    }

    #[test]
    fn contract_table_tags_survive_in_table_context() {
        // Table sections only parse correctly inside <table> (html5ever drops a
        // bare <thead>/<tfoot>/etc.), so probe in context. <tfoot> is the gap
        // ammonia's defaults omit (added via EXTRA_TAGS) — without it the footer
        // rows are reparented out of position.
        let input = "<table><caption>c</caption><colgroup><col></colgroup>\
                     <thead><tr><th>H</th></tr></thead>\
                     <tbody><tr><td>B</td></tr></tbody>\
                     <tfoot><tr><td>F</td></tr></tfoot></table>";
        for t in [
            "table", "caption", "colgroup", "col", "thead", "tbody", "tfoot", "tr", "th", "td",
        ] {
            assert!(tag_survives(input, t), "documented-allowed <{t}> stripped in table context");
        }
        // Footer stays a footer (tfoot wraps its row), not floated up into tbody.
        let out = sanitize(input);
        assert!(out.contains("<tfoot><tr><td>F"), "tfoot footer row reparented: {}", out);
    }

    #[test]
    fn contract_svg_tags_survive_including_camelcase() {
        // camelCase SVG names rely on html5ever's foreign-content adjustment
        // restoring them before ammonia checks the allowlist; pin that it holds.
        let tags = [
            "svg", "g", "defs", "symbol", "use", "marker", "title", "desc", "path",
            "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "tspan",
            "textPath", "linearGradient", "radialGradient", "stop", "pattern", "clipPath",
            "mask", "filter", "feGaussianBlur", "feOffset", "feMerge", "feMergeNode",
            "feColorMatrix",
        ];
        for t in tags {
            let input = format!("<svg><{t}></{t}></svg>");
            assert!(tag_survives(&input, t), "documented-allowed SVG <{t}> was stripped");
        }
    }

    #[test]
    fn contract_structural_wrappers_unwrapped_title_survives() {
        // <html>/<head>/<body> are accepted but html5ever strips the wrappers;
        // <title> survives in the body (documented under "Document structure").
        let out =
            sanitize("<html><head><title>T</title></head><body><p>x</p></body></html>")
                .to_lowercase();
        for w in ["<html", "<head", "<body"] {
            assert!(!out.contains(w), "{} should be unwrapped: {}", w, out);
        }
        assert!(out.contains("<title"), "title should survive: {}", out);
        assert!(out.contains("<p>x</p>"), "body content should survive: {}", out);
    }

    #[test]
    fn contract_documented_attributes_survive() {
        // Common generic attributes — `dir` is the one ammonia omits (granted
        // via HTML_GENERIC_ATTRS); the rest are id/class/style from
        // SVG_GENERIC_ATTRS plus ammonia's default title/lang.
        let div = sanitize(
            "<div id=\"a\" class=\"b\" style=\"color:red\" title=\"t\" lang=\"en\" dir=\"rtl\">x</div>",
        );
        for a in ["id=", "class=", "style=", "title=", "lang=", "dir="] {
            assert!(div.contains(a), "generic attr {} stripped from <div>: {}", a, div);
        }
        // List attributes: `start` is an ammonia default; reversed/type (ol) and
        // value/type (li) are the per-tag additions in make_builder.
        let ol = sanitize("<ol start=\"3\" reversed type=\"a\"><li value=\"5\">x</li></ol>");
        for a in ["start=", "reversed", "type=", "value="] {
            assert!(ol.contains(a), "list attr {} stripped: {}", a, ol);
        }
        // Tabular attributes on th/td (ammonia defaults; pin they still pass).
        let tbl = sanitize(
            "<table><tr><th scope=\"col\" colspan=\"2\">H</th></tr>\
             <tr><td rowspan=\"2\" headers=\"x\">D</td></tr></table>",
        );
        for a in ["scope=", "colspan=", "rowspan=", "headers="] {
            assert!(tbl.contains(a), "tabular attr {} stripped: {}", a, tbl);
        }
    }

    #[test]
    fn contract_main_address_stripped_keep_children() {
        // Documented as stripped (element only, text survives). Not in ammonia's
        // defaults and deliberately NOT re-added, unlike <section>/<tfoot>.
        for t in ["main", "address"] {
            let out = sanitize(&format!("<{t}><p>kept</p></{t}>"));
            assert!(!out.contains(&format!("<{t}")), "<{t}> should be stripped: {}", out);
            assert!(out.contains("<p>kept</p>"), "<{t}> children dropped: {}", out);
        }
    }

    // ----- new-tab link injection (v1.2; on-platform links v1.6) ----------
    // External http(s) links AND on-platform document links (/d/…, /s/…) get
    // target="_blank" so a click opens a new tab instead of dead-ending inside
    // the render iframe (external: the shell's frame-src 'self'; on-platform:
    // the shell's own frame-ancestors 'none'). Fragment / other relative /
    // mailto links keep the in-frame default, and rel="noopener noreferrer"
    // stays forced on every link.

    #[test]
    fn external_https_link_gets_blank_target() {
        let out = sanitize("<a href=\"https://example.com\">x</a>");
        assert!(out.contains("target=\"_blank\""), "got: {}", out);
        assert!(out.contains("href=\"https://example.com\""), "got: {}", out);
    }

    #[test]
    fn external_http_link_gets_blank_target() {
        let out = sanitize("<a href=\"http://example.com\">x</a>");
        assert!(out.contains("target=\"_blank\""), "got: {}", out);
    }

    #[test]
    fn external_scheme_is_case_insensitive() {
        let out = sanitize("<a href=\"HTTPS://example.com\">x</a>");
        assert!(out.contains("target=\"_blank\""), "got: {}", out);
    }

    #[test]
    fn external_link_keeps_noopener_noreferrer() {
        // The escape-sandbox popup is only safe because the opener is severed.
        let out = sanitize("<a href=\"https://example.com\">x</a>");
        assert!(out.contains("noopener"), "got: {}", out);
        assert!(out.contains("noreferrer"), "got: {}", out);
    }

    #[test]
    fn fragment_link_stays_in_frame() {
        // A #section jump must scroll in-frame, not spawn a tab.
        let out = sanitize("<a href=\"#section\">x</a>");
        assert!(!out.contains("target="), "fragment link got a target: {}", out);
    }

    #[test]
    fn relative_link_stays_in_frame() {
        // A relative path that isn't one of the two document routes: nothing
        // on this origin serves it in a frameable way or otherwise, so leave
        // the default alone.
        let out = sanitize("<a href=\"/other\">x</a>");
        assert!(!out.contains("target="), "relative link got a target: {}", out);
    }

    #[test]
    fn on_platform_slug_link_gets_blank_target() {
        // The prescribed cross-document form (skills/publishing.md
        // "Cross-referencing"). Without a target it navigates the render
        // iframe to the shell, whose frame-ancestors 'none' blanks the frame.
        let out = sanitize("<a href=\"/s/q2-metrics\">Q2</a>");
        assert!(out.contains("target=\"_blank\""), "got: {}", out);
        assert!(out.contains("href=\"/s/q2-metrics\""), "href rewritten: {}", out);
    }

    #[test]
    fn on_platform_public_id_link_gets_blank_target() {
        let out = sanitize("<a href=\"/d/S43jW1wfIqlzaeWsYYLlMw\">doc</a>");
        assert!(out.contains("target=\"_blank\""), "got: {}", out);
    }

    #[test]
    fn on_platform_link_keeps_noopener_noreferrer() {
        // Same anti-tabnabbing guarantee as an external link — link_rel fires
        // on any anchor carrying a target, whatever the href.
        let out = sanitize("<a href=\"/s/q2-metrics\">Q2</a>");
        assert!(out.contains("noopener"), "got: {}", out);
        assert!(out.contains("noreferrer"), "got: {}", out);
    }

    #[test]
    fn protocol_relative_link_is_not_on_platform() {
        // `//evil.example` is CROSS-origin (scheme-relative), not a path on
        // this host — and `/\evil.example` is what browsers normalize into
        // one. Neither may qualify under the `/d/` `/s/` rule; both lack the
        // literal `d`/`s` after a single leading slash.
        for href in ["//evil.example/d/x", "/\\evil.example", "//d/x", "/\\d/x"] {
            let out = sanitize(&format!("<a href=\"{href}\">x</a>"));
            // The href survives sanitization (ammonia passes relative URLs
            // through), so "no target" is a real assertion, not a vacuous one.
            assert!(
                out.contains(&format!("href=\"{href}\"")),
                "href {:?} did not survive, test would be vacuous: {}",
                href,
                out
            );
            assert!(
                !out.contains("target="),
                "protocol-relative href {:?} was treated as on-platform: {}",
                href,
                out
            );
        }
    }

    #[test]
    fn on_platform_prefix_requires_the_route_shape() {
        // Near-misses: the prefix is exactly `/d/` or `/s/`, not any path
        // starting with those letters (`/docs/…` is not a document route).
        for href in ["/docs/x", "/summary", "/d", "/s", "/dx/y"] {
            let out = sanitize(&format!("<a href=\"{href}\">x</a>"));
            assert!(!out.contains("target="), "href {:?} got a target: {}", href, out);
        }
    }

    #[test]
    fn mailto_link_does_not_get_target() {
        let out = sanitize("<a href=\"mailto:a@b.com\">mail</a>");
        assert!(!out.contains("target="), "mailto got a target: {}", out);
    }

    #[test]
    fn author_target_blank_is_not_duplicated() {
        // ammonia strips the author's target (not in the allowlist); we re-add
        // exactly one. Guard against a double `target=` if the allowlist ever
        // starts keeping it.
        let out = sanitize("<a href=\"https://example.com\" target=\"_blank\">x</a>");
        assert_eq!(out.matches("target=").count(), 1, "got: {}", out);
    }

    #[test]
    fn external_target_does_not_disturb_sibling_content() {
        // Bytes outside the anchor tag (here an SVG sibling) are copied
        // verbatim; only the anchor gains a target.
        let input = "<svg><title>t</title><circle cx=\"5\" cy=\"5\" r=\"4\"/></svg>\
                     <a href=\"https://x.com\">go</a>";
        let out = sanitize(input);
        assert!(out.contains("<circle"), "svg disturbed: {}", out);
        assert!(out.contains("target=\"_blank\""), "got: {}", out);
    }

    #[test]
    fn svg_xlink_href_is_left_alone() {
        // SVG anchors use xlink:href; v1 doesn't new-tab them. The whitespace-
        // boundary rule on `href=` excludes `xlink:href`.
        let out = sanitize(
            "<svg><a xlink:href=\"https://x.com\"><circle cx=\"5\" cy=\"5\" r=\"4\"/></a></svg>",
        );
        assert!(!out.contains("target=\"_blank\""), "got: {}", out);
    }

    #[test]
    fn does_not_match_non_anchor_tags() {
        // <abbr>/<article>/<aside> start with `<a` but must not be treated as
        // anchors. They carry no href, so nothing should change.
        let out = sanitize("<article><abbr title=\"x\">y</abbr></article>");
        assert!(!out.contains("target="), "got: {}", out);
    }

    #[test]
    fn target_injection_is_idempotent() {
        // sanitize twice: the second clean() strips the target we added (not
        // in the allowlist), then the pass re-adds exactly one — stable.
        let once = sanitize("<a href=\"https://example.com\">x</a>");
        let twice = sanitize(&once);
        assert_eq!(twice.matches("target=").count(), 1, "got: {}", twice);
        assert!(twice.contains("noopener"), "lost rel: {}", twice);
    }

    // ----- the splice only ever reads TEXT-position `<a` (v1.6) ------------
    // <style> content rides through clean() verbatim as RAWTEXT (v1.4), and
    // `<` isn't escaped inside attribute values either — so both are places a
    // `<a href="…"` can appear without being an anchor. The pass used to read
    // them as markup and splice ` target="_blank"` into whatever tag the quote
    // parity landed on, mutating bytes downstream of the trust boundary.

    #[test]
    fn css_that_looks_like_an_anchor_is_left_alone() {
        let css = "/* <a href=\"http://e.com\" */ p{color:red}";
        let out = sanitize(&format!("<style>{css}</style><p>hi</p>"));
        assert!(out.contains(css), "CSS mutated by the splice: {}", out);
        assert!(!out.contains("target="), "splice fired inside CSS: {}", out);
    }

    #[test]
    fn css_with_an_unbalanced_quote_does_not_splice_downstream() {
        // The nastier half: an odd number of quotes in the CSS used to make the
        // scan run past </style> and land the splice on an arbitrary later tag.
        let out = sanitize(
            "<style>/* <a href=\"http://e.com\" q=' */ p{}</style>\
             <p>o'clock</p><b id=\"K\">y</b>",
        );
        assert!(!out.contains("target="), "splice fired downstream of CSS: {}", out);
        assert!(out.contains("<p>o'clock</p>"), "downstream markup mangled: {}", out);
        assert!(out.contains("<b id=\"K\">y</b>"), "downstream markup mangled: {}", out);
    }

    #[test]
    fn real_anchor_after_a_style_block_still_gets_its_target() {
        // Skipping the raw-text element must resume scanning at its close tag,
        // not swallow the rest of the document.
        let out = sanitize(
            "<style>.a{content:\"<a href=\\\"http://e.com\\\"\"}</style>\
             <a href=\"https://example.com\">x</a>",
        );
        assert_eq!(out.matches("target=").count(), 1, "got: {}", out);
    }

    #[test]
    fn anchor_lookalike_in_an_attribute_value_is_not_an_anchor() {
        // html5ever escapes `&` and `"` in attribute values but NOT `<`, so a
        // title can carry a literal `<a `. Start-tag interiors are skipped, so
        // only the real anchor is rewritten.
        let out = sanitize("<p title=\"<a \">x</p><a href=\"https://e.com\">y</a>");
        assert_eq!(out.matches("target=").count(), 1, "got: {}", out);
        assert!(out.contains("title=\"<a \""), "attribute value mutated: {}", out);
    }

    #[test]
    fn splice_scan_stays_linear_on_pathological_input() {
        // Regression for the quadratic blow-up: every mis-read `<a` inside a
        // <style> used to rescan to end-of-input (an unbalanced quote makes the
        // tag scan fail), so ~120 KB burned ~2 s and a 5 MiB document would
        // have burned ~an hour of CPU in one request. Time the pass ONLY —
        // ammonia's own parse is not what regressed, and this shape is exactly
        // what clean() emits for a <style> block (CSS verbatim).
        let doc = format!(
            "<a href=\"https://x.com\">y</a><style>{}\"</style><p>z</p>",
            "<a ".repeat(300_000), // ~900 KB of CSS that merely looks like markup
        );
        let started = std::time::Instant::now();
        let out = add_new_tab_targets(&doc);
        let took = started.elapsed();
        assert!(
            took < std::time::Duration::from_secs(5),
            "splice pass took {took:?} on {} bytes — the scan is unbounded again",
            doc.len(),
        );
        // …and the real anchor before the <style> still got its target, with
        // nothing spliced into (or after) the CSS.
        assert_eq!(out.matches("target=").count(), 1, "expected exactly one splice");
        assert!(out.ends_with("</style><p>z</p>"), "trailing bytes mangled");
    }

    #[test]
    fn an_oversized_start_tag_is_left_alone_and_the_scan_recovers() {
        // MAX_START_TAG_BYTES is a deliberate bound, not an accident: a tag
        // that doesn't close within it is treated as "not a tag", so the anchor
        // silently keeps the in-frame default rather than letting one mis-read
        // drag the scan across the document. Ammonia's own output never gets
        // near 8 KiB, so the only cost is a pathological author's new tab —
        // pinned here because the linear-scan test above never reaches the
        // bound (the raw-text skip short-circuits its <style> payload), so
        // nothing else would notice the bound being widened or dropped.
        let huge = format!("<a href=\"https://e.com\" title=\"{}\">x</a>", "A".repeat(9000));
        let out = sanitize(&huge);
        assert!(!out.contains("target="), "oversized start tag got a target");
        // …and the scan resumes: a normal anchor after it still gets its target.
        let out = sanitize(&format!("{huge}<a href=\"/s/y\">z</a>"));
        assert_eq!(out.matches("target=").count(), 1, "got: {}", out);
    }
}

// ============================================================================
// Markdown-input tests — markdown_to_html() shape + pass-through invariants.
//
// Two flavors:
//   - structural: confirm GFM features (tables, tasklists, strikethrough,
//     footnotes) emit the expected HTML constructs so a future option-set
//     change is loud.
//   - trust-boundary: confirm that raw HTML and dangerous content in the
//     Markdown source pass through UNCHANGED by markdown_to_html. The
//     sanitizer is the only trust boundary; if a future "harden the MD
//     parser" change tried to filter content here, the (md → html →
//     sanitize) contract would gain a second, less audited gate.
// ============================================================================

#[cfg(test)]
mod md_input_tests {
    use super::{markdown_to_html, sanitize};

    fn assert_contains(haystack: &str, needle: &str) {
        assert!(
            haystack.contains(needle),
            "expected `{}` in output\n  output: {:?}",
            needle,
            haystack,
        );
    }

    // ----- structural: heading levels, lists, emphasis ----------------------

    #[test]
    fn emits_heading_levels() {
        let out = markdown_to_html("# h1\n\n## h2\n\n### h3\n");
        assert_contains(&out, "<h1>h1</h1>");
        assert_contains(&out, "<h2>h2</h2>");
        assert_contains(&out, "<h3>h3</h3>");
    }

    #[test]
    fn emits_paragraphs_and_emphasis() {
        let out = markdown_to_html("This is **bold** and *italic*.\n");
        assert_contains(&out, "<p>");
        assert_contains(&out, "<strong>bold</strong>");
        assert_contains(&out, "<em>italic</em>");
    }

    #[test]
    fn emits_nested_lists() {
        let out = markdown_to_html("- a\n  - b\n  - c\n- d\n");
        // Outer ul, inner ul. Don't assert exact whitespace; pulldown-cmark
        // emits opinionated newlines we don't want to pin.
        assert_contains(&out, "<ul>");
        // The inner <ul> appears nested inside an <li>.
        assert!(
            out.matches("<ul>").count() >= 2,
            "expected nested <ul>, got: {}",
            out
        );
        assert_contains(&out, "<li>a");
        assert_contains(&out, "<li>b</li>");
    }

    #[test]
    fn emits_ordered_lists() {
        let out = markdown_to_html("1. first\n2. second\n");
        assert_contains(&out, "<ol>");
        assert_contains(&out, "<li>first</li>");
        assert_contains(&out, "<li>second</li>");
    }

    #[test]
    fn emits_links() {
        let out = markdown_to_html("[hi](https://example.com)\n");
        assert_contains(&out, "<a href=\"https://example.com\">hi</a>");
    }

    #[test]
    fn emits_fenced_code_block() {
        let out = markdown_to_html("```\nlet x = 1;\n```\n");
        assert_contains(&out, "<pre><code>");
        assert_contains(&out, "let x = 1;");
        assert_contains(&out, "</code></pre>");
    }

    #[test]
    fn emits_inline_code() {
        let out = markdown_to_html("Use `foo()` here.\n");
        assert_contains(&out, "<code>foo()</code>");
    }

    #[test]
    fn emits_blockquote() {
        let out = markdown_to_html("> quoted\n");
        assert_contains(&out, "<blockquote>");
        assert_contains(&out, "quoted");
    }

    // ----- GFM extensions ---------------------------------------------------

    #[test]
    fn emits_tables() {
        let out = markdown_to_html("| h1 | h2 |\n|----|----|\n| a  | b  |\n");
        assert_contains(&out, "<table>");
        assert_contains(&out, "<thead>");
        assert_contains(&out, "<th>h1</th>");
        assert_contains(&out, "<td>a</td>");
    }

    #[test]
    fn emits_strikethrough() {
        let out = markdown_to_html("~~gone~~\n");
        // pulldown-cmark emits <del>, which the sanitizer allowlist permits.
        assert_contains(&out, "<del>gone</del>");
    }

    #[test]
    fn emits_task_list_items() {
        let out = markdown_to_html("- [ ] todo\n- [x] done\n");
        // pulldown-cmark emits a disabled <input type=checkbox>. The
        // sanitizer will strip these (form controls aren't allowed), and
        // the existing advisory rule for <input> surfaces the loss to the
        // agent. The text content survives in both cases.
        assert_contains(&out, "type=\"checkbox\"");
        assert_contains(&out, "todo");
        assert_contains(&out, "done");
    }

    // ----- trust-boundary: parser is NOT a sanitizer ------------------------
    //
    // CommonMark allows raw inline HTML. Our pipeline is (md → html →
    // sanitize), and `sanitize()` is the only trust boundary. These tests
    // pin that invariant — if someone in the future adds HTML filtering
    // here, the architecture comment in `markdown_to_html` becomes a lie.

    #[test]
    fn passes_raw_script_through_unchanged() {
        // Raw <script> in MD source survives markdown_to_html. The downstream
        // sanitize() call is what strips it (and that's tested above).
        let md = "Before\n\n<script>alert(1)</script>\n\nAfter\n";
        let html = markdown_to_html(md);
        assert_contains(&html, "<script>alert(1)</script>");
    }

    #[test]
    fn passes_inline_event_handler_through_unchanged() {
        let md = "Before <span onclick=\"alert(1)\">click</span> after\n";
        let html = markdown_to_html(md);
        assert_contains(&html, "onclick=\"alert(1)\"");
    }

    #[test]
    fn passes_javascript_url_through_unchanged() {
        let md = "[click](javascript:alert(1))\n";
        let html = markdown_to_html(md);
        // pulldown-cmark does not enforce a URL allowlist; the sanitizer
        // does. We just confirm the dangerous URL survived this stage.
        assert_contains(&html, "javascript:alert(1)");
    }

    // ----- end-to-end: the (md → html → sanitize) contract ------------------

    #[test]
    fn full_pipeline_strips_raw_script_from_markdown() {
        // The combined invariant: even when an author writes raw <script>
        // inside a Markdown document, the sanitize() pass after parsing
        // removes it. This is the single test that proves the v1 MD input
        // path is no weaker than the v1 HTML input path.
        let md = "# Hello\n\n<script>alert('xss')</script>\n\nText.\n";
        let cleaned = sanitize(&markdown_to_html(md));
        let lc = cleaned.to_lowercase();
        assert!(!lc.contains("<script"), "got: {}", cleaned);
        assert!(!lc.contains("alert('xss')"), "got: {}", cleaned);
        // The legitimate content survives.
        assert_contains(&cleaned, "<h1>Hello</h1>");
        assert_contains(&cleaned, "Text.");
    }

    #[test]
    fn full_pipeline_strips_javascript_url_from_markdown() {
        let cleaned = sanitize(&markdown_to_html("[click](javascript:alert(1))\n"));
        let lc = cleaned.to_lowercase();
        assert!(!lc.contains("javascript:"), "got: {}", cleaned);
    }
}
