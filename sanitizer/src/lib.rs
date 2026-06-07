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
//! (see action-plan-v1.md, "The security model, stated plainly").
//!
//! What we deliberately strip even though CSP would also stop it:
//!   - `<script>`, `<iframe>`, `<object>`, `<embed>` — ammonia default
//!   - `<meta http-equiv="refresh">` — CSP cannot block this; we drop <meta>
//!   - `<style>` blocks — CSS-injection surface ammonia doesn't parse;
//!     inline `style="…"` attributes are still allowed
//!   - `javascript:` / `vbscript:` URLs — ammonia default url_schemes
//!   - `target` on links without `rel=noopener` — link_rel enforces it
//!
//! What we add on top of ammonia defaults:
//!   - Structural tags (`<html>`, `<head>`, `<title>`, `<body>`) so agents
//!     can emit full documents, not just fragments
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
    b.add_tags(extra);

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
    add_blank_target_to_external_links(&cleaned)
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
    "ammonia-v1.3".to_string()
}

// ---------------------------------------------------------------------------
// External-link new-tab pass (sanitizer v1.2).
//
// `sanitize()` runs this on the OUTPUT of `clean()`. External http(s) anchors
// get `target="_blank"` so a click opens a new browser tab; in-frame
// navigation to an off-origin URL is blocked by the render shell's own
// `frame-src 'self'` CSP (and most sites refuse framing), so without this a
// plain external link dead-ends. The render iframe's sandbox carries
// `allow-popups allow-popups-to-escape-sandbox` to let that tab open as a
// normal context (see src/serve.ts SANDBOX), and `link_rel` has already
// forced `rel="noopener noreferrer"` so the tab can't reach `window.opener`.
//
// Why a localized byte splice rather than a re-parse: the input is ammonia's
// normalized serialization (tag names lowercased, every attribute
// double-quoted, `target` already stripped — it's not in the <a> allowlist).
// So we only ever insert ` target="_blank"` into a matching `<a …>` start tag
// and copy every other byte through verbatim — no SVG/text re-serialization,
// and `modified` flips only for documents that actually gained a target.
//
// Scope is deliberately narrow:
//   - only `href="http://…"` / `href="https://…"` (scheme matched
//     case-insensitively); fragment (`#…`), relative, `mailto:`/`tel:` links
//     keep the in-frame default — a `#section` jump must stay a scroll.
//   - `href` is matched only at a whitespace boundary, so `xlink:href` on an
//     SVG anchor is left alone (v1 doesn't new-tab SVG links).
//
// Not a trust boundary: a miss merely leaves a link opening in-frame (the
// pre-v1.2 behavior). The security wall is the sandbox + CSP at render and the
// ammonia allowlist above; this pass only chooses where an already-allowed
// link opens.

const ASCII_WS: &[u8] = b" \t\n\r\x0c";

fn is_ascii_ws(b: u8) -> bool {
    ASCII_WS.contains(&b)
}

fn add_blank_target_to_external_links(html: &str) -> String {
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
        if b[i] == b'<' && is_anchor_start(&b[i..]) {
            if let Some(rel_gt) = find_unquoted_gt(&b[i..]) {
                let gt = i + rel_gt; // index of this tag's closing '>'
                let tag = &html[i..=gt];
                if let Some(rewritten) = tag_with_blank_target(tag) {
                    out.push_str(&html[copied..i]);
                    out.push_str(&rewritten);
                    copied = gt + 1;
                }
                i = gt + 1;
                continue;
            }
        }
        i += 1;
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

/// Offset of the first `>` not inside a quoted value, scanning a start tag.
/// Honors both quote styles (ammonia emits only double quotes); `None` if the
/// tag never closes.
fn find_unquoted_gt(s: &[u8]) -> Option<usize> {
    let mut quote: u8 = 0;
    for (i, &c) in s.iter().enumerate() {
        if quote == 0 {
            match c {
                b'"' | b'\'' => quote = c,
                b'>' => return Some(i),
                _ => {}
            }
        } else if c == quote {
            quote = 0;
        }
    }
    None
}

/// If `tag` (a full `<a …>` start tag) has an external http(s) `href` and no
/// `target`, return it with ` target="_blank"` spliced before the closing
/// `>`. Otherwise `None` (caller keeps the original bytes).
fn tag_with_blank_target(tag: &str) -> Option<String> {
    // `target` never survives ammonia today; check anyway so a future
    // allowlist change can't make us double-inject.
    if attr_at_boundary(tag, "target=") || !href_is_external(tag) {
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

/// True when `tag` has a whitespace-bounded `href="http://…"` / `https://…`.
/// The boundary check excludes `xlink:href`; the scheme is case-insensitive.
fn href_is_external(tag: &str) -> bool {
    let lower = tag.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    let mut from = 0;
    while let Some(rel) = lower[from..].find("href=\"") {
        let at = from + rel;
        if at == 0 || is_ascii_ws(bytes[at - 1]) {
            let val = &lower[at + 6..]; // 6 == "href=\"".len()
            if val.starts_with("http://") || val.starts_with("https://") {
                return true;
            }
        }
        from = at + 6;
    }
    false
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

/// Identifier of the active text-conversion policy. Bumped whenever output
/// shape changes in a way that an existing consumer might notice (new tag
/// support, different SVG alt-text format, list-style change, etc.).
/// Stamped on the read response alongside `sanitizer_version` so an agent
/// can compare across reads if confused.
#[wasm_bindgen]
pub fn converter_version() -> String {
    // v1 — initial GFM emitter (headings, lists, tables, code, blockquote,
    //      links, inline emphasis, [Image: …] for inline SVG)
    "awh-md-v1".to_string()
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
    use super::sanitize;

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

    // ----- <style> blocks (CSS attack surface) ------------------------------

    #[test]
    fn strips_style_block_with_js_url() {
        assert_strips_all(
            "<style>body{background:url(\"javascript:alert(1)\")}</style>",
            &["<style", "javascript:"],
        );
    }

    #[test]
    fn strips_style_block_with_import() {
        assert_strips_all(
            "<style>@import url(\"https://attacker.example/leak.css\");</style>",
            &["<style", "attacker"],
        );
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

    // ----- external-link new-tab injection (sanitizer v1.2) ---------------
    // External http(s) links get target="_blank" so a click opens a new tab
    // instead of dead-ending against the render shell's frame-src 'self' CSP.
    // Fragment / relative / mailto links keep the in-frame default, and
    // rel="noopener noreferrer" stays forced on every link.

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
        let out = sanitize("<a href=\"/other\">x</a>");
        assert!(!out.contains("target="), "relative link got a target: {}", out);
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
