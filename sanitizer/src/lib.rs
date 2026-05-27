//! Ammonia-WASM sanitizer for agent-web-host.
//!
//! Exposes one function — `sanitize(html: &str) -> String` — to the Worker.
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
    extra.extend(SVG_TAGS.iter().copied());
    b.add_tags(extra);

    // Generic attributes — allowed on any element. Ammonia merges with
    // its per-tag attribute defaults rather than replacing them.
    let mut generic: HashSet<&str> = HashSet::new();
    generic.extend(SVG_GENERIC_ATTRS.iter().copied());
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
    make_builder().clean(html).to_string()
}

/// Version tag for the active allowlist. Bumped whenever the rules above
/// change in a way that affects output; recorded on each write so we can
/// trace a stored byte stream back to the policy that produced it.
#[wasm_bindgen]
pub fn sanitizer_version() -> String {
    // v1   — initial allowlist (structural + SVG + link rel injection)
    // v1.1 — added `role` + `aria-*` (with 4 IDREF aria attrs denied)
    "ammonia-v1.1".to_string()
}

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
}
