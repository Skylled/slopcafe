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
 * egregious cases early. The approximation is safe under the 512 cap (which has
 * ~20× headroom over the converter's ~10k-deep overflow):
 *   - Void elements + self-closing tags don't increment (they're leaves).
 *   - Comments / doctype / CDATA / processing-instructions are skipped.
 *   - Raw-text/rcdata element CONTENT (script/style/textarea/title/…) is
 *     skipped, so `<` inside CSS/JS/text can't inflate the count. The set is a
 *     SUBSET of what html5ever treats as raw text in any scripting mode, so the
 *     scan never SKIPS content the real parser would nest (which would let a
 *     bomb through) — at worst it over-counts a pathological input and rejects
 *     it early, which is the safe direction for a parse-cost screen.
 *   - Quoted attribute values are skipped when finding a tag's `>`.
 *   - Deeply-nested DISALLOWED tags (`<foo>…`) DO count — they cost the same to
 *     parse, which is exactly what we're bounding.
 */

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

function isAsciiAlpha(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

function isNameChar(code: number): boolean {
  return (
    isAsciiAlpha(code) ||
    (code >= 0x30 && code <= 0x39) || // 0-9
    code === 0x2d || // -
    code === 0x5f || // _
    code === 0x3a // : (namespaced, e.g. xmlns:xlink)
  );
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

export function maxNestingDepth(html: string): number {
  const n = html.length;
  let i = 0;
  let depth = 0;
  let max = 0;

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
        depth = depth > 0 ? depth - 1 : 0;
      }
      const end = html.indexOf(">", i + 2);
      i = end < 0 ? n : end + 1;
      continue;
    }

    // <open …>
    if (isAsciiAlpha(next)) {
      let j = i + 1;
      while (j < n && isNameChar(html.charCodeAt(j))) j++;
      const name = html.slice(i + 1, j).toLowerCase();
      const { gt, selfClosing } = findTagEnd(html, j);

      if (RAWTEXT_ELEMENTS.has(name)) {
        depth += 1;
        if (depth > max) max = depth;
        const close = findRawClose(html, gt < 0 ? n : gt + 1, name);
        depth = depth > 0 ? depth - 1 : 0;
        i = close;
        continue;
      }

      if (!selfClosing && !VOID_ELEMENTS.has(name)) {
        depth += 1;
        if (depth > max) max = depth;
      }
      i = gt < 0 ? n : gt + 1;
      continue;
    }

    // a bare '<' that doesn't start a tag — literal text
    i = lt + 1;
  }

  return max;
}
