//! Sanitizer bypass-corpus regression test.
//!
//! Runs `sanitize()` (and the `markdown_to_html → sanitize` ingress) against a
//! curated, *long-tail* body of known HTML-sanitizer bypass vectors — the
//! exotic / obfuscated / mutation-XSS (mXSS) cases that the targeted inline
//! corpus in `lib.rs` and ammonia's own suite don't specifically pin — and
//! asserts no **script-execution sink** survives in the cleaned output.
//!
//! ## What this is (and isn't)
//!
//! The sanitizer is the *second* wall. The load-bearing one is the
//! `<iframe sandbox>` + strict CSP at render (`src/serve.ts`, see
//! `action-plan-v1.md`). A corpus survivor here is a **defense-in-depth
//! erosion, not automatically a live XSS** — but we still treat it as a bug,
//! because the sanitizer's job is to be a clean wall on its own. There is no
//! browser in `cargo test`, so the assertion is *structural* (the dangerous
//! construct is absent from the parsed output), which is the correct bar for
//! a sanitizer.
//!
//! ## Scope of the predicate (deliberately narrow)
//!
//! We assert on the sanitizer's *core* contract: no script-execution sink in a
//! *live position*. Concretely, after re-parsing the cleaned output:
//!   - no dangerous **element** (`<script>`, `<iframe>`, `<foreignObject>`,
//!     `<animate>`, `<meta>`, `<base>`, … — see `DANGEROUS_TAGS`)
//!   - no **event-handler attribute** (`on*=`)
//!   - no **dangerous URL scheme** (`javascript:` / `vbscript:` / `data:`) in a
//!     **navigation/resource attribute** (`href`/`src`/`xlink:href`/… — see
//!     `URL_ATTRS`)
//!
//! Two things are intentionally OUT of scope here (each covered elsewhere, or
//! by architecture):
//!   - **Inline `style="…"` CSS.** Ammonia allowlists the `style` attribute but
//!     does NOT parse CSS, so a `url(javascript:…)` inside it survives the
//!     sanitizer by design. It is neutralized by the render wall's
//!     `default-src 'none'` CSP (and modern browsers don't run `javascript:`
//!     in CSS anyway). So we do not check attribute *values* of `style`.
//!   - **ARIA accessibility-tree hijack** (`aria-owns` & friends). That is a
//!     non-script-sink integrity threat, already pinned by the dedicated tests
//!     in `lib.rs`.
//!
//! ## Why a structural re-parse, not a substring scan
//!
//! Upstream vectors are full of *bare fragments* (`javascript:alert(1)`,
//! `onerror=alert(1)`) meant to be injected into an existing context. Run
//! standalone they sanitize to inert *text*, which a naive `output.contains(
//! "javascript:")` would false-positive on. Re-parsing and inspecting the
//! actual tree (element names, attribute names, URL-attribute values — all
//! entity-decoded by html5ever exactly as a browser would see them)
//! distinguishes a dangerous *construct in a live position* from an inert
//! *string*, so the predicate stays false-positive-free across noisy input.
//!
//! ## The data
//!
//! `tests/corpus/bypasses.txt` — the vectors, vendored statically (no network
//! at test time). `tests/corpus/known_exceptions.txt` — payloads we've reviewed
//! and explicitly accept as survivors (with a written reason in a `>>> reason:`
//! directive), so ingesting a noisy list never forces us to either over-curate
//! or silently suppress a real finding. `tests/corpus/SOURCES.md` — provenance,
//! licensing, and the one-line re-sync procedure. Both `.txt` files share the
//! same trivial directive format (see `parse_corpus_file`): paste raw vectors
//! under a `>>> source:` / `>>> category:` header — no JSON escaping, no code
//! change.

use std::fs;
use std::path::PathBuf;

use html5ever::driver::{parse_document, ParseOpts};
use html5ever::tendril::TendrilSink;
use markup5ever_rcdom::{Handle, NodeData, RcDom};

use sanitizer::{markdown_to_html, sanitize};

// --- danger sets: the single source of truth for "what counts as a sink" ---

/// Elements that must never survive sanitization — script hosts, navigation
/// hijacks, embedders, and the SVG/foreign-content animators that can retarget
/// an attribute to a `javascript:` URL. Lowercased; matched against the parsed
/// element's local name.
const DANGEROUS_TAGS: &[&str] = &[
    "script", "iframe", "object", "embed", "applet", "base", "meta", "style",
    "link", "form", "frame", "frameset", "foreignobject", "animate",
    "animatetransform", "animatemotion", "set", "noscript", "template",
    "noembed", "noframes", "xmp", "handler", "image",
];

/// Attributes that resolve to a navigable/loadable URL — the positions where a
/// surviving `javascript:`/`vbscript:`/`data:` scheme is an execution sink.
/// `xlink:href` matches here too: its html5ever local name is `href`.
const URL_ATTRS: &[&str] = &[
    "href", "src", "srcset", "action", "formaction", "data", "poster",
    "background", "cite", "ping", "longdesc", "usemap", "to", "from", "values",
];

/// URL schemes that must never reach a live navigation attribute.
const DANGEROUS_SCHEMES: &[&str] = &["javascript:", "vbscript:", "data:"];

struct Vector {
    name: String,
    payload: String,
    category: String,
    source: String,
}

/// Parse a corpus `.txt` file. Format is deliberately trivial so raw vectors
/// from an upstream list can be pasted in verbatim:
///   - a line `>>> key: value` is a DIRECTIVE; `category` / `source` set the
///     context for the vectors that follow. Any other key (`reason`, `note`,
///     `url`, …) is human documentation and ignored by the loader.
///   - a blank line is skipped.
///   - every other line is a PAYLOAD (taken verbatim — leading `#`, `//`, `<`
///     are all fine; only the `>>>` sentinel is reserved).
fn parse_corpus_file(text: &str, file_label: &str) -> Vec<Vector> {
    let mut out = Vec::new();
    let mut category = String::from("uncategorized");
    let mut source = String::from(file_label);
    let mut idx = 0usize;
    for raw in text.lines() {
        let line = raw.strip_suffix('\r').unwrap_or(raw); // tolerate CRLF
        if line.trim().is_empty() {
            continue;
        }
        if let Some(rest) = line.strip_prefix(">>>") {
            if let Some((k, v)) = rest.trim().split_once(':') {
                match k.trim().to_ascii_lowercase().as_str() {
                    "category" => category = v.trim().to_string(),
                    "source" => source = v.trim().to_string(),
                    _ => {} // reason / note / etc. — documentation only
                }
            }
            continue;
        }
        idx += 1;
        out.push(Vector {
            name: format!("{source}#{idx}"),
            payload: line.to_string(),
            category: category.clone(),
            source: source.clone(),
        });
    }
    out
}

fn corpus_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/corpus")
}

/// Read a corpus file, returning `""` if it's absent (an empty exceptions file
/// is the normal steady state).
fn read_corpus(name: &str) -> String {
    fs::read_to_string(corpus_dir().join(name)).unwrap_or_default()
}

/// Browsers strip TAB/LF/CR/FF from a URL and ignore leading C0 controls /
/// whitespace before matching the scheme. Mirror that, lowercase, then test the
/// scheme prefix — so `jav&#x09;ascript:` (decoded to `jav\tascript:` by the
/// parser) and `  JavaScript:` both resolve the same way a browser would.
fn dangerous_scheme(value: &str) -> Option<&'static str> {
    let mut norm = String::with_capacity(value.len());
    for c in value.chars() {
        if matches!(c, '\t' | '\n' | '\r' | '\u{0c}') {
            continue;
        }
        norm.push(c);
    }
    let trimmed =
        norm.trim_start_matches(|c: char| c.is_ascii_whitespace() || (c as u32) < 0x20);
    let lower = trimmed.to_ascii_lowercase();
    DANGEROUS_SCHEMES
        .iter()
        .copied()
        .find(|s| lower.starts_with(s))
}

/// Walk the parsed tree of sanitized output and collect any script-execution
/// sink. Empty result == clean.
fn scan(node: &Handle, hits: &mut Vec<String>) {
    if let NodeData::Element { name, attrs, .. } = &node.data {
        let local = name.local.as_ref().to_ascii_lowercase();
        if DANGEROUS_TAGS.contains(&local.as_str()) {
            hits.push(format!("dangerous element <{local}>"));
        }
        for attr in attrs.borrow().iter() {
            let an = attr.name.local.as_ref().to_ascii_lowercase();
            if an.starts_with("on") {
                hits.push(format!("event-handler attribute `{an}`"));
            }
            if URL_ATTRS.contains(&an.as_str()) {
                if let Some(scheme) = dangerous_scheme(&attr.value) {
                    hits.push(format!("`{an}` carries `{scheme}` scheme"));
                }
            }
        }
    }
    for child in node.children.borrow().iter() {
        scan(child, hits);
    }
}

/// Sink-scan a finished HTML string.
fn sinks(html: &str) -> Vec<String> {
    let dom = parse_document(RcDom::default(), ParseOpts::default()).one(html);
    let mut hits = Vec::new();
    scan(&dom.document, &mut hits);
    hits
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let mut t: String = s.chars().take(max).collect();
        t.push('…');
        t
    }
}

struct Failure {
    vector: Vector,
    /// Which ingress leaked: "html" (direct) or "markdown" (md→html→sanitize).
    ingress: &'static str,
    output: String,
    hits: Vec<String>,
}

#[test]
fn bypass_corpus_has_no_script_sinks() {
    let vectors = parse_corpus_file(&read_corpus("bypasses.txt"), "bypasses.txt");
    assert!(
        !vectors.is_empty(),
        "corpus is empty — expected tests/corpus/bypasses.txt to hold vectors"
    );

    // Exact-string quarantine of reviewed-safe survivors.
    let exceptions = parse_corpus_file(&read_corpus("known_exceptions.txt"), "known_exceptions");
    let exempt: std::collections::HashSet<&str> =
        exceptions.iter().map(|v| v.payload.as_str()).collect();

    let mut failures: Vec<Failure> = Vec::new();
    let mut idempotency_warnings: Vec<String> = Vec::new();
    let mut checked = 0usize;
    let mut skipped = 0usize;

    for v in vectors {
        if exempt.contains(v.payload.as_str()) {
            skipped += 1;
            continue;
        }
        checked += 1;

        // Ingress A: direct HTML.
        let out_html = sanitize(&v.payload);
        let hits_html = sinks(&out_html);

        // Ingress B: Markdown → HTML → sanitize (the second write path).
        let out_md = sanitize(&markdown_to_html(&v.payload));
        let hits_md = sinks(&out_md);

        // mXSS canary: a fixed point under re-sanitization. Reported, not
        // failed — benign entity/attribute renormalization is common and not a
        // sink on its own; the structural scan above is the real net.
        let twice = sanitize(&out_html);
        if twice != out_html {
            idempotency_warnings.push(v.name.clone());
        }

        if !hits_html.is_empty() {
            failures.push(Failure {
                output: truncate(&out_html, 200),
                hits: hits_html,
                ingress: "html",
                vector: clone_vector(&v),
            });
        }
        if !hits_md.is_empty() {
            failures.push(Failure {
                output: truncate(&out_md, 200),
                hits: hits_md,
                ingress: "markdown",
                vector: v,
            });
        }
    }

    eprintln!(
        "bypass corpus: {checked} checked, {skipped} quarantined, \
         {} idempotency note(s)",
        idempotency_warnings.len()
    );
    if !idempotency_warnings.is_empty() {
        eprintln!(
            "  not-a-fixed-point (informational): {}",
            truncate(&idempotency_warnings.join(", "), 400)
        );
    }

    if !failures.is_empty() {
        let mut msg = format!(
            "\n{} script-execution sink(s) survived sanitization \
             (see the test header for the defense-in-depth framing; a real \
             survivor is either a sanitizer bug to fix or a reviewed-safe entry \
             for tests/corpus/known_exceptions.txt):\n",
            failures.len()
        );
        for f in failures.iter().take(50) {
            msg.push_str(&format!(
                "\n  [{}] {} ({}, ingress={})\n    payload: {}\n    output:  {}\n    sinks:   {}\n",
                f.vector.source,
                f.vector.name,
                f.vector.category,
                f.ingress,
                truncate(&f.vector.payload, 200),
                f.output,
                f.hits.join("; "),
            ));
        }
        if failures.len() > 50 {
            msg.push_str(&format!("\n  … and {} more\n", failures.len() - 50));
        }
        panic!("{msg}");
    }
}

fn clone_vector(v: &Vector) -> Vector {
    Vector {
        name: v.name.clone(),
        payload: v.payload.clone(),
        category: v.category.clone(),
        source: v.source.clone(),
    }
}

/// Guards the predicate itself against a false-negative regression: a future
/// edit to `scan` / `dangerous_scheme` that quietly stops detecting sinks would
/// make the whole corpus pass vacuously. We assert `sinks()` fires on raw
/// (un-sanitized) dangerous HTML and stays silent on benign allowed output.
#[test]
fn predicate_self_check() {
    // Must DETECT (fed raw, pre-sanitization, dangerous markup):
    for bad in [
        "<script>alert(1)</script>",
        "<img src=x onerror=alert(1)>",
        "<a href=\"javascript:alert(1)\">x</a>",
        "<a href=\"jav&#x09;ascript:alert(1)\">x</a>", // entity-decoded tab
        "<svg><use href=\"javascript:alert(1)\"/></svg>",
        "<iframe src=\"data:text/html,x\"></iframe>",
        "<base href=\"javascript:\">",
    ] {
        assert!(
            !sinks(bad).is_empty(),
            "predicate FAILED to flag a real sink: {bad:?}"
        );
    }
    // Must STAY SILENT on benign, allowed output (no false positives):
    for ok in [
        "<p>hello</p>",
        "<a href=\"https://example.com\" rel=\"noopener noreferrer\" target=\"_blank\">x</a>",
        "<a href=\"#section\">x</a>",
        "<a href=\"mailto:a@b.com\">x</a>",
        "<div style=\"color:red\">x</div>",
        // Inert TEXT that merely mentions a scheme/handler must not trip it:
        "<p>use javascript:alert(1) carefully; onerror=foo</p>",
        "<svg><title>diagram</title><circle cx=\"5\" cy=\"5\" r=\"4\"/></svg>",
    ] {
        assert!(
            sinks(ok).is_empty(),
            "predicate FALSE-POSITIVED on benign output: {ok:?} -> {:?}",
            sinks(ok)
        );
    }
}
