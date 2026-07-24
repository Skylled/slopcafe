// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/**
 * `maxNestingDepth(html)` — an O(n) maximum element-nesting depth of an HTML
 * string by a single left-to-right scan, building NO DOM.
 *
 * Why it exists (GitHub issue #42): `sanitize()` (html5ever tree-build +
 * markup5ever_rcdom drop) and the precise `maxDomDepth` are BOTH ~O(n²) in
 * nesting depth — a near-byte-cap depth-bomb (the 5 MiB input cap allows ~1M
 * nested `<div>`s) makes them spend seconds before the `too_deep` rejection
 * (issue #41) can fire. The write path runs THIS scan first, on the (cheaply,
 * O(n)) converted HTML, and rejects a depth-bomb BEFORE the quadratic parse
 * ever touches it — empirically ~1000× cheaper than the tree-build.
 *
 * It is an APPROXIMATE measure of open-tag nesting, NOT the exact parsed-DOM
 * depth — the precise `maxDomDepth` check downstream stays the authoritative
 * guard against the converter's stack overflow; this scan only refuses the
 * egregious cases early. Every approximation is deliberately biased to
 * OVER-count (refuse a pathological input early — a false `too_deep` at worst)
 * rather than UNDER-count (hand a bomb to the quadratic parse this screen
 * exists to keep it away from). Where it can still under-count, that is called
 * out below and bounded — every remaining case is capped at a constant, never
 * once per repeated unit, because only an ACCUMULATING under-count can hide a
 * bomb. The list, exhaustively:
 *   - EXACT. Void elements don't increment (they're leaves) and comments /
 *     doctype / CDATA / processing-instructions are skipped, as the parser
 *     does. Quoted attribute values are skipped when finding a tag's `>`, so
 *     `attr="a>b"` doesn't end the tag early.
 *   - EXACT, load-bearing. Tag NAMES are extracted the way the tokenizer
 *     extracts them — every character up to whitespace / `/` / `>` / EOF, so
 *     `<div=x>` is an element named `div=x`. A "name-shaped characters" scan
 *     truncates it to `div`, which makes `<div=x></div>` and `<div></div=x>`
 *     both look balanced while the real parser nests one level per repeat.
 *     See `tagNameEnd`.
 *   - EXACT, load-bearing. The self-closing flag is honoured ONLY inside
 *     foreign content (`<svg>`/`<math>`, minus HTML integration points). On an
 *     ordinary HTML element `/>` is a parse error the tree builder ignores, so
 *     `<div/>` OPENS a div — the cheapest bomb of all at 6 bytes per level, and
 *     `<b/>` at 4. Honouring it inside SVG is what keeps a legitimate
 *     `<svg><path/>×400</svg>` measuring 1 rather than 400.
 *   - OVER-counts. Raw-text/rcdata element CONTENT (script/style/textarea/
 *     title/…) is skipped, so `<` inside CSS/JS/text can't inflate the count.
 *     The set is a SUBSET of what html5ever treats as raw text in any scripting
 *     mode, so the scan never SKIPS content the real parser would nest.
 *   - OVER-counts. A start tag that the real parser would treat as implicitly
 *     closing an open sibling (`<li>` under an open `<li>`, `<p>` under `<p>`,
 *     a table cell under a cell) is pushed anyway — this scan tracks tags, not
 *     insertion modes, so a long run of unclosed siblings accumulates depth the
 *     real parse would not.
 *   - OVER-counts. Deeply-nested DISALLOWED tags (`<foo>…`) DO count — they
 *     cost the same to parse, which is exactly what we're bounding.
 *   - LOAD-BEARING, exact for the common shapes. End tags run against a real
 *     (bounded) open-element stack: `</name>` pops to the nearest matching open
 *     element, and an end tag matching nothing open is IGNORED — exactly as the
 *     parser ignores it. Getting this wrong is what re-opened the quadratic
 *     path: the first cut of this scan decremented on ANY end tag, so
 *     `<div></foo>` scanned as depth 1 while the real parse nests one `<div>`
 *     per repeat (measured: 176 KB → 2.3 s in `sanitize()`, 4× per doubling).
 *     `</br>` needs no special case for the same reason — `br` is void, so it
 *     is never on the stack, and HTML5 in fact turns `</br>` into an INSERTED
 *     `<br>` leaf rather than a close.
 *   - OVER-counts. The pop search stops at a barrier element (see
 *     `SEARCH_BARRIER_ELEMENTS`) or after `MAX_CLOSE_SEARCH` entries; either
 *     way the end tag is ignored, leaving depth where it was.
 *   - UNDER-counts by 1, non-accumulating. `</p>` with no `<p>` open inserts an
 *     empty `<p>` and immediately closes it, and `</br>` inserts a `<br>` leaf,
 *     so the true max is one deeper for that instant; this scan ignores both
 *     tags entirely. A single level, never stacked, so it can't become a bomb.
 *   - UNDER-counts, bounded by the same argument. The pop search crosses the
 *     elements every table/list end tag generates thoroughly (p/li/dd/dt and
 *     the table internals) where the spec's stricter "any other end tag" rule
 *     would stop at them — deliberate, because real documents leave exactly
 *     those unclosed. Those elements auto-close their own kind in the body
 *     insertion mode (a `<li>` cannot sit under a `<li>`, a cell under a cell),
 *     so they can't be piled up to hide depth under an unmatched end tag.
 *   - UNDER-counts by 2, constant. A fragment is parsed into the `html > body`
 *     the parser implies around it, which this tag scan doesn't model. Measured:
 *     `<div></foo>`×200 scans as 200, `maxDomDepth` of the sanitized bytes says
 *     202. Harmless against a 512 cap with ~20× headroom over the converter's
 *     ~10k-deep overflow.
 * The count saturates at `cap` — see `DEPTH_SCAN_CAP`.
 */

/**
 * The scan's own ceiling, and the bound on its open-element stack. Once the
 * count reaches this the verdict can no longer change — the caller rejects at
 * `MAX_DOM_DEPTH` (512, core.ts) and this is one past it — so the scan returns
 * immediately instead of walking (and stacking) the rest of a bomb. That keeps
 * both the time and the memory a depth-bomb can cost O(1) past this point, and
 * it means a reported depth of exactly `DEPTH_SCAN_CAP` means "at least this
 * deep", not "exactly this deep".
 *
 * Must stay > core.ts's `MAX_DOM_DEPTH`, or the pre-screen would saturate below
 * the reject threshold and pass every bomb. depth.ts is a leaf module (no core
 * import — that would be circular, and would drag D1/R2/WASM into the pure
 * unit tests), so the coupling is this comment plus the `cap` parameter: a
 * caller with a different threshold passes its own.
 */
export const DEPTH_SCAN_CAP = 513;

/**
 * How far down the open-element stack a `</name>` may look for its match.
 * The real parser's search is bounded by the barrier set below; this is the
 * belt-and-braces bound that keeps the scan O(n) when an adversary stacks a
 * long run of NON-barrier elements (`<b>`×N) under a stream of end tags.
 * Giving up means "ignore the end tag", i.e. it over-counts — the safe way.
 * 32 is well past what unclosed real markup needs and keeps that adversarial
 * shape at ~290 ms for a full 5 MiB input (vs ~1 ms for an actual depth-bomb,
 * which saturates the cap and returns almost immediately).
 */
const MAX_CLOSE_SEARCH = 32;

/** Elements with no end tag — count as leaves, never increment depth. */
const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

/**
 * Elements whose content the HTML parser tokenizes as TEXT (RAWTEXT / RCDATA /
 * PLAINTEXT), so nested-looking `<…>` inside them are never elements — skip
 * their content. Deliberately a subset of html5ever's raw-text set that holds
 * for EITHER scripting mode (so `<noscript>` is excluded — it's raw text only
 * when scripting is enabled; counting its content over-rejects a pathological
 * input rather than risk under-counting a real one).
 */
const RAWTEXT_ELEMENTS = new Set([
  "script", "style", "textarea", "title",
  "xmp", "iframe", "noembed", "noframes", "plaintext",
]);

/**
 * Elements a `</name>` search must NOT look past. This is the HTML spec's
 * *special* category — the parser's own barrier when it walks the stack for an
 * end tag that matches nothing above — narrowed twice: to names that can
 * actually BE on this scan's stack (void and raw-text elements never are), and
 * minus the ones every table/list end tag "generates thoroughly" anyway (p, li,
 * dd, dt, the table internals), which real documents routinely leave unclosed
 * and which the spec's own block end-tag rules cross freely.
 *
 * Hitting a barrier means the end tag is IGNORED and depth stays where it was —
 * the over-counting direction. This set is load-bearing, not decoration:
 * without `div` in it, `<foo><div></foo>` would find the `<foo>` past the open
 * `<div>` and pop, scanning flat at 2 while the real parse nests two levels per
 * repeat (measured: ×200 → `maxDomDepth` 202). Where the real parser instead
 * flattens what a barrier keeps open — foster parenting hoists a `<div>` out of
 * a `<table>`, so `<div><table></div>`×200 really is only 4 deep — this scan
 * over-counts, which is the direction it's allowed to be wrong in.
 */
const SEARCH_BARRIER_ELEMENTS = new Set([
  "address", "applet", "article", "aside", "blockquote", "body", "button",
  "center", "details", "dialog", "dir", "div", "dl", "fieldset", "figcaption",
  "figure", "footer", "form", "frameset", "h1", "h2", "h3", "h4", "h5", "h6",
  "head", "header", "hgroup", "html", "listing", "main", "marquee", "menu",
  "nav", "noscript", "object", "ol", "pre", "search", "section", "select",
  "summary", "table", "template", "ul",
]);

/**
 * Elements that open a foreign-content subtree, where `<path/>` genuinely
 * self-closes. Everywhere else `/>` is ignored — see the `inForeign` gate.
 */
const FOREIGN_ROOTS = new Set(["svg", "math"]);

/**
 * Points inside a foreign subtree where the parser switches back to HTML rules
 * (SVG's text-container elements, MathML's token elements + `annotation-xml`).
 * Content here is parsed as HTML, so `/>` stops being acknowledged again —
 * without this, `<svg><foreignObject><div/>…` would read every `<div/>` as a
 * leaf while the real parser nests one per tag, which is the same accumulating
 * under-count the foreign gate exists to prevent.
 */
const HTML_INTEGRATION_POINTS = new Set([
  "foreignobject", "desc", "title",
  "mi", "mo", "mn", "ms", "mtext", "annotation-xml",
]);

function isAsciiAlpha(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

/**
 * End index of the tag name starting at `from`, matching the HTML tokenizer's
 * tag-name state exactly: every character is APPENDED to the name until
 * whitespace, `/`, `>`, or EOF terminates it.
 *
 * This is deliberately NOT a "name-shaped characters" test. `<div=x>` is an
 * element named `div=x`, not a `div` — so a later `</div>` cannot close it.
 * Truncating the name at the first odd character would make the scan believe
 * those two tags pair up, and each `<div=x></div>` repetition would then read
 * as depth 1 while the real parser nests one level deeper every time. The same
 * confusion runs the other way for `</div=x>`, an end tag that matches nothing
 * and which the parser simply drops. Both are accumulating under-counts — the
 * one direction this scan must never err in — so the name has to be extracted
 * the way the tokenizer extracts it. It also fixes the VOID/RAWTEXT lookups for
 * free: `<br"x>` is an unknown element the parser pushes, not a void `br`.
 */
function tagNameEnd(html: string, from: number, n: number): number {
  let j = from;
  while (j < n) {
    const c = html.charCodeAt(j);
    if (isWhitespace(c) || c === 0x2f /* / */ || c === 0x3e /* > */) break;
    j++;
  }
  return j;
}

function isWhitespace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d;
}

function asciiLower(code: number): number {
  return code >= 0x41 && code <= 0x5a ? code + 0x20 : code;
}

/**
 * Find the `>` that closes the tag whose attributes start at `from`, skipping
 * over quoted attribute values so a `>` inside `attr="a>b"` doesn't end it
 * early. Returns the index of the `>` (or -1 if unterminated) and whether the
 * tag self-closes (`… />`).
 */
function findTagEnd(html: string, from: number): { gt: number; selfClosing: boolean } {
  const n = html.length;
  let i = from;
  while (i < n) {
    const code = html.charCodeAt(i);
    if (code === 0x22 /* " */ || code === 0x27 /* ' */) {
      const close = html.indexOf(html[i], i + 1);
      if (close < 0) return { gt: -1, selfClosing: false };
      i = close + 1;
      continue;
    }
    if (code === 0x3e /* > */) {
      return { gt: i, selfClosing: i > from && html.charCodeAt(i - 1) === 0x2f /* / */ };
    }
    i++;
  }
  return { gt: -1, selfClosing: false };
}

/**
 * From `from`, find the matching `</name…>` (ASCII-case-insensitive, the name
 * followed by whitespace / `/` / `>`) and return the index just past its `>`.
 * Unclosed raw text runs to EOF. No allocation — manual case-insensitive
 * compare keeps the whole scan O(n) even with many raw-text blocks.
 */
function findRawClose(html: string, from: number, lowerName: string): number {
  const n = html.length;
  const nameLen = lowerName.length;
  let i = from;
  while (i < n) {
    if (html.charCodeAt(i) === 0x3c /* < */ && html.charCodeAt(i + 1) === 0x2f /* / */) {
      let k = 0;
      while (k < nameLen && asciiLower(html.charCodeAt(i + 2 + k)) === lowerName.charCodeAt(k)) {
        k++;
      }
      if (k === nameLen) {
        const after = i + 2 + nameLen;
        const next = html.charCodeAt(after); // NaN past EOF
        if (Number.isNaN(next) || next === 0x3e || next === 0x2f || isWhitespace(next)) {
          const gt = html.indexOf(">", after);
          return gt < 0 ? n : gt + 1;
        }
      }
    }
    i++;
  }
  return n;
}

/**
 * Apply a `</name>` to the open-element stack, in place. Pops to the nearest
 * matching open element; an end tag that matches nothing — or whose match is
 * hidden behind a barrier / past the search bound — is IGNORED, exactly as the
 * parser ignores it, leaving the stack (and so the depth) untouched.
 */
function closeElement(open: string[], name: string): void {
  const floor = open.length > MAX_CLOSE_SEARCH ? open.length - MAX_CLOSE_SEARCH : 0;
  for (let k = open.length - 1; k >= floor; k--) {
    const openName = open[k]!;
    // Matched: this element and everything the parser would auto-close above
    // it come off together, so the new depth is this element's own index.
    if (openName === name) {
      open.length = k;
      return;
    }
    if (SEARCH_BARRIER_ELEMENTS.has(openName)) return;
  }
}

export function maxNestingDepth(html: string, cap: number = DEPTH_SCAN_CAP): number {
  const n = html.length;
  let i = 0;
  /** Names of the currently-open elements, outermost first; length == depth. */
  const open: string[] = [];
  let max = 0;
  /**
   * Stack depth at which the innermost `<svg>`/`<math>` subtree began, or -1
   * outside foreign content; `foreignAt >= 0 && open.length > foreignAt` means
   * "currently inside foreign content". `integrationAt` is the same marker for
   * an HTML integration point nested inside that subtree, where the parser
   * switches back to HTML rules. Both are plain indices rather than a parallel
   * stack because they only ever need the innermost value — a subtree ends
   * exactly when the stack shrinks back to or past its marker.
   */
  let foreignAt = -1;
  let integrationAt = -1;

  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt < 0) break;
    i = lt;
    const next = html.charCodeAt(i + 1); // NaN past EOF

    // <!-- comment -->  ·  <!doctype …>  ·  <![CDATA[ … ]]>
    if (next === 0x21 /* ! */) {
      if (html.startsWith("<!--", i)) {
        const end = html.indexOf("-->", i + 4);
        i = end < 0 ? n : end + 3;
      } else {
        const end = html.indexOf(">", i + 2);
        i = end < 0 ? n : end + 1;
      }
      continue;
    }

    // <? processing instruction (HTML5 parses as a bogus comment to `>`)
    if (next === 0x3f /* ? */) {
      const end = html.indexOf(">", i + 2);
      i = end < 0 ? n : end + 1;
      continue;
    }

    // </close>
    if (next === 0x2f /* / */) {
      if (isAsciiAlpha(html.charCodeAt(i + 2))) {
        const j = tagNameEnd(html, i + 2, n);
        const name = html.slice(i + 2, j).toLowerCase();
        // A void end tag (`</br>`, `</img>`) can never match: void elements are
        // leaves and are never pushed. Skipping the search is just the cheap
        // way to say so.
        if (!VOID_ELEMENTS.has(name)) closeElement(open, name);
        // A close can pop out of a foreign subtree (or out of an integration
        // point back into one), so re-check both markers against the new depth.
        if (integrationAt >= 0 && open.length <= integrationAt) integrationAt = -1;
        if (foreignAt >= 0 && open.length <= foreignAt) foreignAt = -1;
      }
      const end = html.indexOf(">", i + 2);
      i = end < 0 ? n : end + 1;
      continue;
    }

    // <open …>
    if (isAsciiAlpha(next)) {
      const j = tagNameEnd(html, i + 1, n);
      const name = html.slice(i + 1, j).toLowerCase();
      const { gt, selfClosing } = findTagEnd(html, j);

      if (RAWTEXT_ELEMENTS.has(name)) {
        // One level for the element itself; its content is text, so the stack
        // never actually carries it — the close tag is consumed right here.
        if (open.length + 1 > max) {
          max = open.length + 1;
          if (max >= cap) return cap;
        }
        i = findRawClose(html, gt < 0 ? n : gt + 1, name);
        continue;
      }

      // The self-closing flag is only ACKNOWLEDGED in foreign content. On an
      // ordinary HTML element `/>` is a parse error the tree builder ignores,
      // so `<div/>` OPENS a div — honouring it there under-counts by one level
      // per tag, the cheapest depth bomb of all (6 bytes each). Inside
      // `<svg>`/`<math>` it really does self-close, which is what keeps a
      // legitimate `<svg><path/>×400</svg>` measuring 1 instead of 400.
      const inForeign =
        foreignAt >= 0 &&
        open.length > foreignAt &&
        !(integrationAt >= 0 && open.length > integrationAt);

      if (!(selfClosing && inForeign) && !VOID_ELEMENTS.has(name)) {
        if (FOREIGN_ROOTS.has(name)) {
          if (foreignAt < 0) foreignAt = open.length;
        } else if (inForeign && HTML_INTEGRATION_POINTS.has(name)) {
          // Inside this element the parser is back on HTML rules, so stop
          // acknowledging `/>` until it closes.
          if (integrationAt < 0) integrationAt = open.length;
        }
        open.push(name);
        if (open.length > max) {
          max = open.length;
          // Past the caller's reject threshold the answer can only get bigger,
          // so stop here — this is what keeps a bomb's cost O(bytes scanned so
          // far) instead of O(n²) in the stack it would otherwise build.
          if (max >= cap) return cap;
        }
      }
      i = gt < 0 ? n : gt + 1;
      continue;
    }

    // a bare '<' that doesn't start a tag — literal text
    i = lt + 1;
  }

  return max;
}
