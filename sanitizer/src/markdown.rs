// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

//! HTML → Markdown emitter for sanitized agent-web-host bytes.
//!
//! Walks the `html5ever`-parsed DOM and emits GitHub-Flavored Markdown.
//! Called from `html_to_markdown()` in the parent module at read time, on
//! bytes that have already been through `sanitize()` — never on raw agent
//! input. Two reasons that order matters: (1) the text path reflects exactly
//! what the renderer would show; (2) anything the sanitizer strips can't
//! leak back through the text channel.
//!
//! The input space is bounded by Ammonia's allowlist (see `make_builder`
//! in the parent module), which lets us hand-roll a tight tag matcher
//! instead of pulling in a general-purpose HTML→Markdown crate. Unknown
//! or not-explicitly-handled tags fall through transparently — we recurse
//! into their children so text survives even when structure is lost.
//!
//! Design choices worth flagging:
//!  - Two parses (one in sanitize, one here) instead of one shared pass.
//!    Buys decoupling: the renderer and the text view operate on the same
//!    stored bytes, neither depends on the other's internals.
//!  - Per-line prefix stack rather than indent counters. Keeps list
//!    nesting and blockquote nesting composable with the same primitive.
//!  - Tables buffered into a row matrix before emit. GFM requires the
//!    header-divider row, which can't be written until the column count
//!    is known.
//!  - SVG collapses to `[Image: <alt>]` using `<title>` / `<desc>` /
//!    `aria-label` in that order. Agents reading text care that a visual
//!    was there and what it depicted — not the path data.

use std::cell::RefCell;

use html5ever::driver::{parse_document, ParseOpts};
use html5ever::interface::Attribute;
use html5ever::tendril::TendrilSink;
use markup5ever_rcdom::{Handle, NodeData, RcDom};

/// Public entry — convert a sanitized HTML string to GFM Markdown.
pub fn convert(html: &str) -> String {
    let dom = parse_document(RcDom::default(), ParseOpts::default()).one(html);
    let mut em = Emitter::new();
    em.walk(&dom.document);
    em.finish()
}

/// Maximum node-nesting depth of `html`'s parsed DOM.
///
/// Measured **iteratively** with an explicit work-stack — it never recurses, so
/// it cannot overflow on the very input it exists to screen. `convert()` above
/// (and the `search`/`collect_text` helpers) DO recurse, and the deployed WASM
/// build has a small (~1 MiB) stack, so a pathologically deep document hard-
/// aborts the isolate (GitHub issue #41). The write path calls this first and
/// REJECTS anything past `MAX_DOM_DEPTH` before `convert()` ever runs, so no
/// depth-bomb reaches storage (and thus no stored doc can crash a read).
///
/// `html5ever` wraps a fragment in `html`>`head`/`body`, so a bare top-level
/// element reports ~3; the cap has ~10× headroom over real content regardless.
pub fn max_depth(html: &str) -> u32 {
    let dom = parse_document(RcDom::default(), ParseOpts::default()).one(html);
    let mut max = 0u32;
    // (node, depth) work-stack — mirrors ammonia's own stack-safe `clean_dom`.
    // CLONE the root handle rather than moving `dom.document` out: `dom` must
    // stay fully alive for the whole traversal (it owns the tree), or the moved
    // root drops the rest of the DOM and we'd walk an empty document.
    let mut stack: Vec<(Handle, u32)> = vec![(dom.document.clone(), 0)];
    while let Some((node, depth)) = stack.pop() {
        if depth > max {
            max = depth;
        }
        for child in node.children.borrow().iter() {
            stack.push((child.clone(), depth + 1));
        }
    }
    max
}

#[derive(Clone, Copy, Debug)]
enum ListKind {
    Unordered,
    /// Ordered list; tracks the next item number (1-based).
    Ordered(u32),
}

struct Emitter {
    out: String,
    /// Re-emitted at the start of every line within the current context.
    /// Grows for nested blockquotes (`> `) and list continuations (spaces);
    /// shrinks back as we exit those scopes.
    line_prefix: String,
    /// Active list contexts, outermost first. `<li>` consults the inner-
    /// most entry to choose marker and (for ordered) the next number.
    list_stack: Vec<ListKind>,
    /// Suppress whitespace collapsing + Markdown escaping for the current
    /// text run. Set inside `<pre>` and inside SVG title/desc extraction.
    raw_text: bool,
    /// Schedules a paragraph break (`\n\n` + prefix) before the next visible
    /// content. Block-level entries set this; the next emit consumes it.
    pending_break: bool,
    /// True until any visible content has been emitted — suppresses the
    /// leading paragraph break that block boundaries would otherwise add.
    at_doc_start: bool,
    /// True while rendering inside a `<th>`/`<td>` sub-emitter. GFM splits a
    /// table row on `|` before inline/code parsing runs, so a literal pipe
    /// must be escaped (`\|`) even inside a code span. `emit_text` already
    /// escapes `|` universally; this flag extends that to the raw-text path
    /// (`emit_raw`, used by inline `<code>`/`<pre>`) so code-span pipes in a
    /// cell don't break the row.
    in_table_cell: bool,
}

impl Emitter {
    fn new() -> Self {
        Self {
            out: String::new(),
            line_prefix: String::new(),
            list_stack: Vec::new(),
            raw_text: false,
            pending_break: false,
            at_doc_start: true,
            in_table_cell: false,
        }
    }

    /// Trim trailing whitespace and end with exactly one newline.
    fn finish(mut self) -> String {
        while self.out.ends_with(|c: char| c.is_whitespace()) {
            self.out.pop();
        }
        if !self.out.is_empty() {
            self.out.push('\n');
        }
        self.out
    }

    fn walk(&mut self, node: &Handle) {
        match &node.data {
            NodeData::Document => self.walk_children(node),
            NodeData::Element { name, attrs, .. } => {
                let local = name.local.as_ref();
                match local {
                    // Structural wrappers: descend transparently.
                    "html" | "body" => self.walk_children(node),
                    // `<head>` carries no rendered content; drop wholesale.
                    "head" => {}
                    // `<title>` is metadata, not document content.
                    "title" => {}
                    // Shouldn't survive the sanitizer; never emit their
                    // contents if they somehow do.
                    "script" | "style" | "noscript" => {}

                    // Headings — `#` count matches the level.
                    "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
                        let level = local.as_bytes()[1] - b'0';
                        self.start_block();
                        self.flush_pending();
                        for _ in 0..level {
                            self.out.push('#');
                        }
                        self.out.push(' ');
                        self.walk_children(node);
                        self.end_block();
                    }

                    // Paragraph-ish blocks.
                    "p" | "div" | "section" | "article" | "aside" | "header"
                    | "footer" | "nav" | "hgroup" | "figure" | "figcaption"
                    | "details" | "summary" => {
                        self.start_block();
                        self.walk_children(node);
                        self.end_block();
                    }

                    "hr" => {
                        self.start_block();
                        self.flush_pending();
                        self.out.push_str("---");
                        self.end_block();
                    }

                    // Soft line break inside a paragraph.
                    "br" => self.emit_hard_break(),

                    // Code: fenced block inside `<pre>`, inline span otherwise.
                    "pre" => {
                        self.start_block();
                        self.flush_pending();
                        // The fence is sized to the CONTENT, so emit the
                        // content first and insert the opening fence after —
                        // measuring what we actually emitted (a link's URL, an
                        // inline `<code>` run) rather than re-deriving it from
                        // the text nodes. See `fence_len` for why a fixed
                        // ``` fence is a correctness bug, not a cosmetic one.
                        let fence_at = self.out.len();
                        self.out.push('\n');
                        self.write_indent();
                        let was = std::mem::replace(&mut self.raw_text, true);
                        self.walk_children(node);
                        self.raw_text = was;
                        let fence = "`".repeat(fence_len(&self.out[fence_at..]));
                        if !self.out.ends_with('\n') {
                            self.out.push('\n');
                            self.write_indent();
                        }
                        self.out.push_str(&fence);
                        // Only the block's own bytes move — `fence_at` is where
                        // this `<pre>` started and nothing has been appended
                        // past it, so the whole pass stays linear.
                        self.out.insert_str(fence_at, &fence);
                        self.end_block();
                    }
                    "code" => {
                        if self.raw_text {
                            // Already inside a fenced `<pre>`; render raw.
                            self.walk_children(node);
                        } else {
                            self.flush_pending();
                            self.at_doc_start = false;
                            self.out.push('`');
                            let was = std::mem::replace(&mut self.raw_text, true);
                            self.walk_children(node);
                            self.raw_text = was;
                            self.out.push('`');
                        }
                    }

                    // Inline emphasis.
                    "strong" | "b" => self.wrap_inline(node, "**", "**"),
                    "em" | "i" => self.wrap_inline(node, "*", "*"),
                    "s" | "del" => self.wrap_inline(node, "~~", "~~"),

                    // No Markdown analogue — emit text only.
                    "u" | "kbd" | "samp" | "var" | "cite" | "q" | "abbr"
                    | "dfn" | "mark" | "time" | "data" | "small" | "sub"
                    | "sup" | "ins" | "bdi" | "bdo" | "ruby" | "rt" | "rp"
                    | "span" => self.walk_children(node),

                    // Blockquote: extend line prefix with `> ` for nesting.
                    "blockquote" => {
                        self.start_block();
                        self.flush_pending();
                        let added = "> ";
                        self.line_prefix.push_str(added);
                        self.write_indent();
                        // Walking children will produce its own block breaks,
                        // which `flush_pending` will indent with the new prefix.
                        self.walk_children(node);
                        for _ in 0..added.len() {
                            self.line_prefix.pop();
                        }
                        self.end_block();
                    }

                    // Lists.
                    "ul" => self.walk_list(node, ListKind::Unordered),
                    "ol" => self.walk_list(node, ListKind::Ordered(1)),
                    "li" => self.walk_list_item(node),
                    "dl" => {
                        self.start_block();
                        self.walk_children(node);
                        self.end_block();
                    }
                    "dt" => {
                        self.start_block();
                        self.flush_pending();
                        self.out.push_str("**");
                        self.walk_children(node);
                        self.out.push_str("**");
                        self.end_block();
                    }
                    "dd" => {
                        self.start_block();
                        self.flush_pending();
                        self.out.push_str(": ");
                        self.walk_children(node);
                        self.end_block();
                    }

                    "a" => self.emit_link(node, attrs),

                    "table" => self.emit_table(node),
                    // Cells/rows are handled inside `emit_table`; if we
                    // land on one outside that context, just walk through.
                    "thead" | "tbody" | "tfoot" | "tr" | "th" | "td"
                    | "caption" | "colgroup" | "col" => self.walk_children(node),

                    "svg" => self.emit_svg(node, attrs),

                    // Unknown / not explicitly handled: walk through so text
                    // content survives even when structure is lost. Form
                    // controls land here — the sanitizer keeps their text
                    // but drops the elements per skills/publishing.md.
                    _ => self.walk_children(node),
                }
            }
            NodeData::Text { contents } => {
                let text = contents.borrow();
                if text.is_empty() {
                    return;
                }
                if self.raw_text {
                    self.emit_raw(&text);
                } else {
                    self.emit_text(&text);
                }
            }
            // Comments shouldn't survive the sanitizer; drop everything else.
            _ => {}
        }
    }

    fn walk_children(&mut self, node: &Handle) {
        for child in node.children.borrow().iter() {
            self.walk(child);
        }
    }

    /// Schedule a paragraph break before the next visible content. Idempotent
    /// — adjacent `start_block`/`end_block` calls collapse into one break.
    fn start_block(&mut self) {
        if !self.at_doc_start {
            self.pending_break = true;
        }
    }

    /// Mirror of `start_block` for the closing edge. Same effect; reads
    /// better at call sites that bracket a block.
    fn end_block(&mut self) {
        if !self.at_doc_start {
            self.pending_break = true;
        }
    }

    /// Flush a pending paragraph break: writes `\n\n` + `line_prefix` once.
    /// No-op at the document start or when there's nothing to flush.
    fn flush_pending(&mut self) {
        if !self.pending_break {
            return;
        }
        self.pending_break = false;
        if self.at_doc_start {
            return;
        }
        // Strip trailing inline whitespace before the break.
        while self.out.ends_with(' ') || self.out.ends_with('\t') {
            self.out.pop();
        }
        if !self.out.ends_with('\n') {
            self.out.push('\n');
        }
        self.out.push('\n');
        self.write_indent();
    }

    fn write_indent(&mut self) {
        self.out.push_str(&self.line_prefix);
    }

    /// GFM hard break (`  \n`) — used by `<br>` inside a paragraph.
    fn emit_hard_break(&mut self) {
        if self.out.is_empty() || self.out.ends_with('\n') {
            return;
        }
        self.out.push_str("  \n");
        self.write_indent();
    }

    /// Emit a text run with Markdown escaping and whitespace collapsing.
    /// Whitespace-only runs collapse to at most one inter-word space.
    fn emit_text(&mut self, s: &str) {
        if s.chars().all(|c| c.is_whitespace()) {
            // Inter-word whitespace inside an inline run — keep one space
            // unless the buffer already ends in whitespace or we're at the
            // start of a (pending) block.
            if self.pending_break {
                return;
            }
            if !self.out.is_empty() && !self.out.ends_with(|c: char| c.is_whitespace()) {
                self.out.push(' ');
            }
            return;
        }
        self.flush_pending();
        self.at_doc_start = false;
        let mut prev_space = self.out.is_empty()
            || self.out.ends_with(|c: char| c.is_whitespace());
        for c in s.chars() {
            if c.is_whitespace() {
                if !prev_space {
                    self.out.push(' ');
                    prev_space = true;
                }
                continue;
            }
            prev_space = false;
            // Conservative escape set: any of these can start a Markdown
            // construct in some position. Escaping universally is safer
            // than tracking line/inline context.
            match c {
                '\\' | '`' | '*' | '_' | '[' | ']' | '<' | '>' | '|' | '#' | '~' => {
                    self.out.push('\\');
                    self.out.push(c);
                }
                _ => self.out.push(c),
            }
        }
    }

    /// Raw text run (inside `<pre>` or SVG title/desc): no escaping,
    /// preserve whitespace, re-emit `line_prefix` on every newline so
    /// blockquote/list nesting stays intact.
    fn emit_raw(&mut self, s: &str) {
        self.flush_pending();
        self.at_doc_start = false;
        for c in s.chars() {
            if c == '\n' {
                self.out.push('\n');
                self.write_indent();
            } else {
                // A literal `|` inside a table cell splits the GFM row even
                // when it sits in a code span — the table parser runs before
                // inline/code parsing. Raw runs skip `emit_text`'s escaping,
                // so escape it here when we're rendering a cell.
                if c == '|' && self.in_table_cell {
                    self.out.push('\\');
                }
                self.out.push(c);
            }
        }
    }

    /// Wrap an inline element with prefix/suffix markers. If no content
    /// gets emitted, undo the markers so we don't leave bare `****` etc.
    fn wrap_inline(&mut self, node: &Handle, open: &str, close: &str) {
        self.flush_pending();
        let buf = self.out.len();
        self.out.push_str(open);
        let before = self.out.len();
        self.walk_children(node);
        if self.out.len() == before {
            self.out.truncate(buf);
            return;
        }
        self.out.push_str(close);
    }

    fn walk_list(&mut self, node: &Handle, kind: ListKind) {
        // Only the outermost list gets a paragraph break around it; nested
        // lists are part of their containing item and must stay attached
        // (a blank line would end the outer list in Markdown's eyes).
        let nested = !self.list_stack.is_empty();
        if !nested {
            self.start_block();
        }
        self.list_stack.push(kind);
        self.walk_children(node);
        self.list_stack.pop();
        if !nested {
            self.end_block();
        }
    }

    fn walk_list_item(&mut self, node: &Handle) {
        let marker = match self.list_stack.last_mut() {
            Some(ListKind::Ordered(n)) => {
                let m = format!("{}. ", *n);
                *n += 1;
                m
            }
            _ => "- ".to_string(),
        };

        // Nesting is already baked into `line_prefix`: each enclosing `<li>`
        // pushed its own continuation indent before recursing into us. We
        // just need a fresh line at that prefix, then the marker.
        if self.out.is_empty() {
            self.write_indent();
        } else if !self.out.ends_with('\n') {
            self.out.push('\n');
            self.write_indent();
        }
        self.out.push_str(&marker);

        // Continuation lines inside this item must align under the text
        // after the marker. Push that width onto the prefix stack for the
        // duration of the children walk — nested `<li>`s inherit it.
        let cont = " ".repeat(marker.chars().count());
        self.line_prefix.push_str(&cont);
        // A blank line inside a list item would terminate the list in
        // Markdown's grammar. Suppress any pending break and let the
        // item's content flow inline.
        self.pending_break = false;
        self.at_doc_start = false;
        self.walk_children(node);
        for _ in 0..cont.len() {
            self.line_prefix.pop();
        }
        // Items don't trigger paragraph breaks — the next `<li>` will
        // handle its own newline.
        self.pending_break = false;
    }

    fn emit_link(&mut self, node: &Handle, attrs: &RefCell<Vec<Attribute>>) {
        let href = attrs
            .borrow()
            .iter()
            .find(|a| a.name.local.as_ref() == "href")
            .map(|a| a.value.to_string());

        self.flush_pending();
        let buf_start = self.out.len();
        self.out.push('[');
        let text_start = self.out.len();
        self.walk_children(node);
        let text_end = self.out.len();

        let empty_text = text_end == text_start;
        match (href, empty_text) {
            (Some(h), true) => {
                // No inner text — fall back to the URL as visible text.
                for c in h.chars() {
                    match c {
                        '[' | ']' | '\\' => {
                            self.out.push('\\');
                            self.out.push(c);
                        }
                        _ => self.out.push(c),
                    }
                }
                self.out.push(']');
                self.out.push('(');
                self.push_url(&h);
                self.out.push(')');
            }
            (Some(h), false) => {
                self.out.push(']');
                self.out.push('(');
                self.push_url(&h);
                self.out.push(')');
            }
            (None, false) => {
                // Anchor with no href — strip the brackets, keep text.
                let inner = self.out[text_start..text_end].to_string();
                self.out.truncate(buf_start);
                self.out.push_str(&inner);
            }
            (None, true) => {
                // Contentless anchor — undo entirely.
                self.out.truncate(buf_start);
            }
        }
    }

    /// Emit a URL inside `(...)`. Escapes `(` and `)`; leaves URL-encoded
    /// content alone (don't double-escape).
    fn push_url(&mut self, url: &str) {
        for c in url.chars() {
            match c {
                '(' | ')' | '\\' => {
                    self.out.push('\\');
                    self.out.push(c);
                }
                _ => self.out.push(c),
            }
        }
    }

    fn emit_table(&mut self, node: &Handle) {
        let mut rows: Vec<Vec<String>> = Vec::new();
        let mut header_row: Option<usize> = None;

        // Inner walker: collect cell text into the current row. `<thead>`/
        // `<tbody>`/`<tfoot>` are transparent; each `<tr>` contributes one row.
        fn collect(
            node: &Handle,
            rows: &mut Vec<Vec<String>>,
            header_row: &mut Option<usize>,
        ) {
            if let NodeData::Element { name, .. } = &node.data {
                match name.local.as_ref() {
                    "thead" => {
                        let before = rows.len();
                        for c in node.children.borrow().iter() {
                            collect(c, rows, header_row);
                        }
                        // GFM tables have exactly one header row; if `<thead>`
                        // contained any rows, mark the last as the divider.
                        if rows.len() > before {
                            *header_row = Some(rows.len() - 1);
                        }
                        return;
                    }
                    "tbody" | "tfoot" => {
                        for c in node.children.borrow().iter() {
                            collect(c, rows, header_row);
                        }
                        return;
                    }
                    "tr" => {
                        let mut row: Vec<String> = Vec::new();
                        for c in node.children.borrow().iter() {
                            if let NodeData::Element { name, .. } = &c.data {
                                let n = name.local.as_ref();
                                if n == "th" || n == "td" {
                                    // Render via a sub-emitter, then flatten —
                                    // GFM table cells are single-line. The
                                    // `in_table_cell` flag makes both the text
                                    // and raw-text paths escape `|` as `\|`, so
                                    // a pipe survives the row split even inside
                                    // an inline-code span.
                                    let mut sub = Emitter::new();
                                    sub.at_doc_start = false;
                                    sub.in_table_cell = true;
                                    sub.walk_children(c);
                                    let mut t = sub.out;
                                    while t.ends_with(|c: char| c.is_whitespace()) {
                                        t.pop();
                                    }
                                    row.push(t.replace('\n', " "));
                                }
                            }
                        }
                        if !row.is_empty() {
                            rows.push(row);
                        }
                        return;
                    }
                    // Caption could be emitted above the table; skip for v1.
                    "caption" | "colgroup" => return,
                    _ => {}
                }
            }
            for c in node.children.borrow().iter() {
                collect(c, rows, header_row);
            }
        }

        collect(node, &mut rows, &mut header_row);
        if rows.is_empty() {
            return;
        }

        // Normalize to max column count.
        let cols = rows.iter().map(|r| r.len()).max().unwrap_or(0);
        if cols == 0 {
            return;
        }
        for row in rows.iter_mut() {
            while row.len() < cols {
                row.push(String::new());
            }
        }

        // GFM requires a header row. Default to the first row if no `<thead>`.
        let header_idx = header_row.unwrap_or(0);

        self.start_block();
        self.flush_pending();

        for (i, row) in rows.iter().enumerate() {
            if i > 0 {
                self.out.push('\n');
                self.write_indent();
            }
            self.out.push('|');
            for cell in row {
                self.out.push(' ');
                self.out.push_str(cell);
                self.out.push_str(" |");
            }
            if i == header_idx {
                self.out.push('\n');
                self.write_indent();
                self.out.push('|');
                for _ in 0..cols {
                    self.out.push_str(" --- |");
                }
            }
        }
        self.end_block();
    }

    /// SVG → `[Image: <alt>] `. Alt text comes from the first descendant
    /// `<title>`, then first `<desc>`, then the root `aria-label`. SVGs
    /// with none of those are *omitted entirely* — a bare `[Image]`
    /// placeholder tells the reader nothing, and the agent that authored
    /// it can fix it by adding a `<title>` (which also helps screen-reader
    /// users). The trailing space ensures `[Image: …]` doesn't concatenate
    /// against the next inline content when the source HTML had no
    /// whitespace between the SVG and its neighbor; `flush_pending` and
    /// `emit_text` strip/collapse it away in the cases where it'd matter.
    fn emit_svg(&mut self, node: &Handle, attrs: &RefCell<Vec<Attribute>>) {
        let mut title: Option<String> = None;
        let mut desc: Option<String> = None;
        fn search(node: &Handle, title: &mut Option<String>, desc: &mut Option<String>) {
            if let NodeData::Element { name, .. } = &node.data {
                let local = name.local.as_ref();
                if local == "title" && title.is_none() {
                    *title = Some(collect_text(node));
                    return;
                }
                if local == "desc" && desc.is_none() {
                    *desc = Some(collect_text(node));
                    return;
                }
            }
            for c in node.children.borrow().iter() {
                search(c, title, desc);
            }
        }
        for c in node.children.borrow().iter() {
            search(c, &mut title, &mut desc);
        }
        let aria_label = attrs
            .borrow()
            .iter()
            .find(|a| a.name.local.as_ref() == "aria-label")
            .map(|a| a.value.to_string());

        let alt: Option<String> = match (title, desc, aria_label) {
            (Some(t), Some(d), _) if !t.trim().is_empty() && !d.trim().is_empty() => {
                Some(format!("{} — {}", t.trim(), d.trim()))
            }
            (Some(t), _, _) if !t.trim().is_empty() => Some(t.trim().to_string()),
            (_, Some(d), _) if !d.trim().is_empty() => Some(d.trim().to_string()),
            (_, _, Some(a)) if !a.trim().is_empty() => Some(a.trim().to_string()),
            _ => None,
        };

        // No usable alt → drop the SVG entirely. Don't touch `pending_break`
        // or `at_doc_start`: the SVG is simply not part of the text view.
        let Some(s) = alt else { return };

        self.flush_pending();
        self.at_doc_start = false;
        self.out.push_str("[Image: ");
        for c in s.chars() {
            match c {
                '[' | ']' | '\\' => {
                    self.out.push('\\');
                    self.out.push(c);
                }
                _ => self.out.push(c),
            }
        }
        self.out.push(']');
        self.out.push(' ');
    }
}

/// Opening/closing fence length for a `<pre>` block: three backticks, or one
/// more than the longest backtick run in `content` when that's longer.
///
/// CommonMark closes a fenced block at the first run of **>= the opening
/// length**, so a fixed ``` fence lets any `<pre>` containing ``` terminate its
/// own block — the remainder is then re-read as document-level Markdown. That's
/// a round-trip amplification bug, not a cosmetic one: text the sanitizer had
/// safely escaped (`&lt;img …&gt;`) comes back out as a bare line and becomes a
/// LIVE element if the markdown is re-published. It also mangled the
/// on-platform authoring guide, whose ```pack manifest example read as an empty
/// code block plus loose prose to any agent reading it as markdown.
fn fence_len(content: &str) -> usize {
    let mut longest = 0usize;
    let mut run = 0usize;
    for c in content.chars() {
        if c == '`' {
            run += 1;
            longest = longest.max(run);
        } else {
            run = 0;
        }
    }
    (longest + 1).max(3)
}

/// Concatenate every descendant text node into a single string. Used by
/// SVG alt-text extraction where we want the raw text of `<title>`/`<desc>`,
/// not Markdown-formatted text.
fn collect_text(node: &Handle) -> String {
    let mut out = String::new();
    fn walk(node: &Handle, out: &mut String) {
        match &node.data {
            NodeData::Text { contents } => out.push_str(&contents.borrow()),
            _ => {
                for c in node.children.borrow().iter() {
                    walk(c, out);
                }
            }
        }
    }
    walk(node, &mut out);
    out
}

// ============================================================================
// Tests — input/output corpus for the converter.
//
// Mostly positive assertions ("given X, produces Y") — unlike the sanitizer
// tests, where negative assertions are the safety property. Here the safety
// property is "no script/style content leaks into text," and that's covered
// by the post-sanitization tests at the bottom.
// ============================================================================

#[cfg(test)]
mod tests {
    use super::{convert, max_depth};
    use crate::{markdown_to_html, sanitize};

    /// Assert exact equality. Most tests use this since the converter is
    /// deterministic and we want regressions to break loudly.
    fn assert_md(html: &str, want: &str) {
        let got = convert(html);
        assert_eq!(
            got, want,
            "\n  input:    {:?}\n  expected: {:?}\n  got:      {:?}",
            html, want, got
        );
    }

    /// Looser assertion when whitespace specifics aren't load-bearing.
    fn assert_contains(html: &str, needle: &str) {
        let got = convert(html);
        assert!(
            got.contains(needle),
            "\n  input:  {:?}\n  needle: {:?}\n  got:    {:?}",
            html, needle, got
        );
    }

    // ----- headings ---------------------------------------------------------

    #[test]
    fn headings_preserve_level() {
        assert_md("<h1>One</h1>", "# One\n");
        assert_md("<h2>Two</h2>", "## Two\n");
        assert_md("<h6>Six</h6>", "###### Six\n");
    }

    #[test]
    fn headings_separated_from_paragraph() {
        assert_md(
            "<h1>Title</h1><p>Body</p>",
            "# Title\n\nBody\n",
        );
    }

    // ----- paragraphs + inline ---------------------------------------------

    #[test]
    fn paragraphs_blank_line_separated() {
        assert_md("<p>A</p><p>B</p>", "A\n\nB\n");
    }

    #[test]
    fn strong_and_em() {
        assert_md(
            "<p><strong>bold</strong> and <em>italic</em></p>",
            "**bold** and *italic*\n",
        );
    }

    #[test]
    fn empty_inline_emitted_nothing() {
        // Bare `****` would be a parse problem for downstream consumers.
        assert_md("<p><strong></strong>after</p>", "after\n");
    }

    #[test]
    fn inline_code_uses_backticks() {
        assert_md("<p>see <code>foo()</code></p>", "see `foo()`\n");
    }

    #[test]
    fn strikethrough_uses_tilde() {
        assert_md("<p><del>gone</del></p>", "~~gone~~\n");
    }

    // ----- escaping --------------------------------------------------------

    #[test]
    fn escapes_markdown_specials_in_text() {
        // `*` `_` `[` `]` etc. would otherwise turn plain text into syntax.
        assert_md(
            r#"<p>use _name_ for [refs]</p>"#,
            "use \\_name\\_ for \\[refs\\]\n",
        );
    }

    #[test]
    fn collapses_internal_whitespace() {
        assert_md(
            "<p>a    b\n\tc</p>",
            "a b c\n",
        );
    }

    // ----- links ------------------------------------------------------------

    #[test]
    fn link_with_href_and_text() {
        assert_md(
            r#"<p><a href="https://example.com">site</a></p>"#,
            "[site](https://example.com)\n",
        );
    }

    #[test]
    fn link_without_text_falls_back_to_href() {
        assert_md(
            r#"<p><a href="https://example.com"></a></p>"#,
            "[https://example.com](https://example.com)\n",
        );
    }

    #[test]
    fn anchor_without_href_keeps_only_text() {
        assert_md(
            "<p><a>label</a></p>",
            "label\n",
        );
    }

    #[test]
    fn link_escapes_parens_in_url() {
        assert_md(
            r#"<p><a href="https://example.com/x(y)">x</a></p>"#,
            "[x](https://example.com/x\\(y\\))\n",
        );
    }

    // ----- lists ------------------------------------------------------------

    #[test]
    fn unordered_list_uses_dashes() {
        assert_md(
            "<ul><li>a</li><li>b</li></ul>",
            "- a\n- b\n",
        );
    }

    #[test]
    fn ordered_list_numbers_from_one() {
        assert_md(
            "<ol><li>a</li><li>b</li><li>c</li></ol>",
            "1. a\n2. b\n3. c\n",
        );
    }

    #[test]
    fn nested_unordered_list_indents() {
        // Nested lists must stay attached (no blank line between levels) or
        // GFM treats the inner as a separate list.
        assert_md(
            "<ul><li>top<ul><li>nested</li></ul></li></ul>",
            "- top\n  - nested\n",
        );
    }

    #[test]
    fn ordered_inside_unordered() {
        assert_md(
            "<ul><li>outer<ol><li>one</li><li>two</li></ol></li></ul>",
            "- outer\n  1. one\n  2. two\n",
        );
    }

    // ----- blockquote -------------------------------------------------------

    #[test]
    fn blockquote_prefixes_lines() {
        assert_md(
            "<blockquote><p>quoted</p></blockquote>",
            "> quoted\n",
        );
    }

    #[test]
    fn blockquote_paragraph_break_inside() {
        assert_contains(
            "<blockquote><p>one</p><p>two</p></blockquote>",
            "> one",
        );
        assert_contains(
            "<blockquote><p>one</p><p>two</p></blockquote>",
            "> two",
        );
    }

    // ----- code block -------------------------------------------------------

    #[test]
    fn pre_emits_fenced_block() {
        assert_md(
            "<pre>let x = 1;\nlet y = 2;</pre>",
            "```\nlet x = 1;\nlet y = 2;\n```\n",
        );
    }

    #[test]
    fn pre_with_code_doesnt_double_fence() {
        assert_md(
            "<pre><code>x</code></pre>",
            "```\nx\n```\n",
        );
    }

    #[test]
    fn pre_fence_widens_past_backticks_in_content() {
        // CommonMark closes a fenced block at the first run of >= the opening
        // length, so content containing ``` needs a longer fence or it escapes
        // the block and the rest re-reads as document-level Markdown.
        assert_md(
            "<pre>a\n```\nb</pre>",
            "````\na\n```\nb\n````\n",
        );
        assert_md(
            "<pre>a\n````\nb</pre>",
            "`````\na\n````\nb\n`````\n",
        );
    }

    #[test]
    fn pre_fence_floor_is_three_backticks() {
        // A short run doesn't shrink the fence below CommonMark's minimum.
        assert_md("<pre>x`y</pre>", "```\nx`y\n```\n");
        assert_md("<pre>x``y</pre>", "```\nx``y\n```\n");
    }

    #[test]
    fn pre_fence_survives_a_markdown_round_trip() {
        // The amplification the widened fence prevents: read a doc as markdown,
        // re-publish it as markdown. With a fixed ``` fence the escaped TEXT
        // `&lt;img …&gt;` broke out of the code block and came back as a live
        // <img> element (and the rest of the block was destroyed).
        let stored = sanitize("<pre>example:\n```\n&lt;img src=x&gt;\n```\nend</pre>");
        let md = convert(&stored);
        let republished = sanitize(&markdown_to_html(&md));
        assert!(
            !republished.contains("<img"),
            "inert text was promoted to live markup: {:?}",
            republished
        );
        assert!(
            republished.contains("&lt;img src=x&gt;"),
            "code-block content lost on round trip: {:?}",
            republished
        );
        assert!(republished.contains("end"), "block tail lost: {:?}", republished);
    }

    // ----- breaks -----------------------------------------------------------

    #[test]
    fn hr_emits_thematic_break() {
        assert_md("<p>a</p><hr><p>b</p>", "a\n\n---\n\nb\n");
    }

    #[test]
    fn br_emits_hard_break() {
        assert_md("<p>line one<br>line two</p>", "line one  \nline two\n");
    }

    // ----- SVG → [Image: …] -------------------------------------------------

    #[test]
    fn svg_with_title_becomes_alt() {
        assert_md(
            "<p>before <svg><title>chart</title><rect/></svg> after</p>",
            "before [Image: chart] after\n",
        );
    }

    #[test]
    fn svg_with_title_and_desc_joins_with_em_dash() {
        assert_contains(
            "<p><svg><title>Q4</title><desc>Revenue by quarter</desc></svg></p>",
            "[Image: Q4 — Revenue by quarter]",
        );
    }

    #[test]
    fn svg_with_aria_label_only() {
        assert_contains(
            r#"<p><svg aria-label="status indicator"><circle/></svg></p>"#,
            "[Image: status indicator]",
        );
    }

    #[test]
    fn svg_with_no_alt_info_is_dropped() {
        // No <title>, no <desc>, no aria-label → the SVG carries no signal
        // for a text reader, so we omit it entirely rather than leaving a
        // bare [Image] placeholder. Surrounding text closes up around it.
        assert_md(
            "<p>before<svg><circle cx=\"5\" cy=\"5\" r=\"4\"/></svg>after</p>",
            "beforeafter\n",
        );
    }

    #[test]
    fn svg_with_no_alt_at_paragraph_top_level_collapses_paragraph() {
        // An entire paragraph whose only content is a useless SVG produces
        // no markdown content. The block boundaries collapse against each
        // other since there's nothing inside to flush.
        assert_md(
            "<p>before</p><p><svg><circle/></svg></p><p>after</p>",
            "before\n\nafter\n",
        );
    }

    #[test]
    fn svg_adds_trailing_space_when_html_had_none() {
        // The source HTML doesn't separate the SVG from the next word, but
        // an LLM reading text shouldn't have to parse "][word" — emit a
        // space to keep the placeholder a distinct token.
        assert_md(
            "<p>chart<svg><title>q4</title></svg>continues</p>",
            "chart[Image: q4] continues\n",
        );
    }

    #[test]
    fn svg_trailing_space_does_not_double_when_html_had_one() {
        // If the source HTML already has whitespace after the SVG, our
        // trailing space gets collapsed by emit_text — no double space.
        assert_md(
            "<p>before <svg><title>q4</title></svg> after</p>",
            "before [Image: q4] after\n",
        );
    }

    #[test]
    fn svg_trailing_space_stripped_at_block_break() {
        // Block transitions strip trailing inline whitespace, so an SVG at
        // the end of a paragraph doesn't leave a hanging space before \n\n.
        assert_md(
            "<p>chart: <svg><title>q4</title></svg></p><p>next</p>",
            "chart: [Image: q4]\n\nnext\n",
        );
    }

    #[test]
    fn svg_path_data_does_not_leak() {
        // Critical: path d="..." attributes are visual noise for an agent
        // reading the doc as text. They must not appear in the output.
        let html = r#"<p><svg><title>arrow</title><path d="M10 10 L 90 90 Z"/></svg></p>"#;
        let got = convert(html);
        assert!(!got.contains("M10 10"), "path data leaked: {:?}", got);
        assert!(got.contains("[Image: arrow]"), "got: {:?}", got);
    }

    // ----- tables -----------------------------------------------------------

    #[test]
    fn table_with_thead_emits_header_divider() {
        assert_md(
            "<table><thead><tr><th>A</th><th>B</th></tr></thead>\
             <tbody><tr><td>1</td><td>2</td></tr></tbody></table>",
            "| A | B |\n| --- | --- |\n| 1 | 2 |\n",
        );
    }

    #[test]
    fn table_without_thead_treats_first_row_as_header() {
        assert_md(
            "<table><tr><td>A</td><td>B</td></tr><tr><td>1</td><td>2</td></tr></table>",
            "| A | B |\n| --- | --- |\n| 1 | 2 |\n",
        );
    }

    #[test]
    fn table_escapes_pipe_in_cell() {
        assert_md(
            "<table><tr><td>a|b</td><td>c</td></tr></table>",
            "| a\\|b | c |\n| --- | --- |\n",
        );
    }

    #[test]
    fn table_escapes_pipe_in_inline_code_cell() {
        // GFM splits a table row on `|` before parsing inline/code, so a pipe
        // inside a `<code>` span must still be escaped `\|` or the row gains a
        // phantom column on re-publish. This is the read→edit→re-publish
        // round-trip bug seen on type-union cells like `string | null`.
        assert_md(
            "<table><tr><td><code>a | b</code></td></tr></table>",
            "| `a \\| b` |\n| --- |\n",
        );
    }

    #[test]
    fn table_escapes_pipe_in_inline_code_alongside_text() {
        // Mixed plain-text and code-span pipes in one cell: both escape, via
        // `emit_text` and `emit_raw` respectively. Mirrors the real doc's
        // `"title" | "description"` row that started as `\|`-escaped source.
        assert_md(
            "<table><tr><td>x | <code>a | b</code></td></tr></table>",
            "| x \\| `a \\| b` |\n| --- |\n",
        );
    }

    // ----- drop/skip rules --------------------------------------------------

    #[test]
    fn head_and_title_dropped() {
        // Both the wrapping <head> and the <title> inside it should produce
        // no markdown content.
        assert_md(
            "<html><head><title>ignored</title></head><body><p>body</p></body></html>",
            "body\n",
        );
    }

    #[test]
    fn unknown_tag_text_content_survives() {
        // Form controls etc. fall here in production (sanitizer strips the
        // element, keeps the text). Mirror that with a made-up tag.
        assert_md("<p>before <made-up>middle</made-up> after</p>", "before middle after\n");
    }

    // ----- end-to-end through sanitize + convert ----------------------------
    // The text path always runs on sanitized bytes in production. These
    // tests guard against any path where a script or other stripped element
    // could leak into the text view.

    #[test]
    fn script_content_never_reaches_markdown() {
        let html = "<p>visible</p><script>alert(1)</script>";
        let md = convert(&sanitize(html));
        assert!(!md.contains("alert"), "script payload leaked: {:?}", md);
        assert!(md.contains("visible"), "lost visible content: {:?}", md);
    }

    #[test]
    fn style_block_never_reaches_markdown() {
        let html = "<style>body{color:red}</style><p>hi</p>";
        let md = convert(&sanitize(html));
        assert!(!md.contains("color:red"), "style content leaked: {:?}", md);
        assert!(md.contains("hi"), "got: {:?}", md);
    }

    #[test]
    fn end_to_end_report_shape() {
        // Composite of structures from skills/publishing.md's "simple report"
        // recipe — guards that the typical agent output round-trips usefully.
        let html = "<h1>Daily summary</h1>\
                    <p>Generated at <strong>17:42</strong></p>\
                    <h2>Highlights</h2>\
                    <ul><li><strong>3</strong> new</li><li><strong>11</strong> done</li></ul>";
        let md = convert(&sanitize(html));
        assert!(md.starts_with("# Daily summary"), "got: {:?}", md);
        assert!(md.contains("## Highlights"), "got: {:?}", md);
        assert!(md.contains("- **3** new"), "got: {:?}", md);
        assert!(md.contains("- **11** done"), "got: {:?}", md);
    }

    #[test]
    fn max_depth_is_stack_safe_and_accurate() {
        // max_depth is always fed SANITIZED H in production (it screens what the
        // converter will walk), so measure the same: sanitize, then depth.
        // Shallow sanity: depth grows one per node level (html>body>div>p>text).
        let shallow = max_depth(&sanitize("<div><p>hi</p></div>"));
        assert!((4..20).contains(&shallow), "unexpected shallow depth: {shallow}");

        // Regression for issue #41: measure a depth FAR beyond what the recursive
        // converter could survive (native ~40k, WASM ~10k) WITHOUT overflowing —
        // max_depth uses an explicit work-stack. Run on the raw deep nesting; we
        // deliberately never call convert() on it (rejecting it before convert()
        // runs is the whole point). parse_document is itself stack-safe
        // (html5ever's open-elements Vec). Not sanitized — ammonia's reserialize
        // is slow on absurd nesting, and the screen's safety doesn't depend on it.
        let deep = format!("{}{}", "<div>".repeat(12_000), "</div>".repeat(12_000));
        let d = max_depth(&deep);
        assert!(d >= 12_000, "deep nesting under-measured: {d}");
    }
}
