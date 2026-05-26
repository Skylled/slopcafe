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
    b.add_generic_attributes(generic);

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
    "ammonia-v1".to_string()
}
