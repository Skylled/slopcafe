// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/**
 * Write-time advisories for "your input survived but something visible was
 * lost." Surfaces what would otherwise be a silent failure: the sanitizer
 * drops things without telling the agent what, and the iframe CSP blocks
 * other things at render time with no advisory at all.
 *
 * Two channels, one purpose — turn invisible-by-default content loss into
 * a learnable signal:
 *
 *   `stripped[]`        - constructs the sanitizer removed entirely
 *                         (e.g. <script>, <iframe>, javascript: URLs).
 *   `will_not_render[]` - constructs that survived the sanitizer but the
 *                         iframe CSP will refuse to load. The canonical
 *                         case is <img src="https://..."> — the element
 *                         is preserved by the allowlist, but img-src
 *                         'self' data: blocks the network fetch, so the
 *                         user sees a broken image with no other signal.
 *
 * Detection is intentionally pattern-based, not a parse:
 *
 *   - Run a regex against the INPUT. If it matches and the same regex
 *     does NOT match the OUTPUT (case-insensitive), we know the
 *     sanitizer removed every instance. Emit one short entry.
 *   - Entity-encoded text like `<p>The &lt;script&gt; tag is bad</p>`
 *     matches in both input and output (text survives), so we never
 *     wrongly claim something was stripped.
 *   - As a catch-all behind the specific rules, a generic element-name
 *     diff (`detectStrippedElements`) reports any open-tag whose count
 *     dropped to fewer in the output than the input and that no specific
 *     rule named — so an allowlist gap nobody wrote a regex for (the way
 *     <section> vanished silently) still surfaces. It shares the same
 *     false-positive defenses (comment/script/style bodies and
 *     entity-encoded text don't count; survivors are never flagged).
 *   - We may still MISS detections (e.g. a stripped attribute on a
 *     surviving element). The contract is "best effort, advisory" — false
 *     negatives are acceptable, false positives are not.
 *
 * Entries are deliberately short: a count + element + one-clause reason.
 * The on-platform publishing guide (slug slopcafe-publishing-guide) carries
 * the long explanation; this just nudges the agent toward reading it.
 *
 * Future: when the SOLO spec's dropped-forward-link case lands, it should
 * join the same `stripped[]` array (one advisory channel, not two). See
 * addendum §3 "spec §4 dropped-forward-link case."
 */

export type Advisories = {
  stripped: string[];
  will_not_render: string[];
};

/**
 * Compute advisories from the pre-sanitize input and post-sanitize output.
 * Returns empty arrays if nothing notable changed. Cheap (regex-only), safe
 * to call on every write.
 */
export function detectAdvisories(input: string, cleaned: string): Advisories {
  const stripped: string[] = [];
  const will_not_render: string[] = [];

  for (const rule of STRIPPED_RULES) {
    const inCount = countMatches(input, rule.match);
    if (inCount === 0) continue;
    const outCount = countMatches(cleaned, rule.match);
    if (outCount >= inCount) continue; // not stripped (or matches text that survived)
    const removed = inCount - outCount;
    stripped.push(rule.message(removed));
  }

  // Generic catch-all: any element present in the input but gone from the
  // output that the specific rules above didn't already name. This closes the
  // class of "documented-or-not, the allowlist dropped a tag and nobody wrote a
  // regex for it" — the gap that let <section> vanish silently before it was
  // re-allowed. Specific rules win (better wording), so this only fires for the
  // long tail (e.g. <dialog>, <canvas>, <fieldset>, <video>).
  for (const entry of detectStrippedElements(input, cleaned)) {
    stripped.push(entry);
  }

  for (const rule of WILL_NOT_RENDER_RULES) {
    const outCount = countMatches(cleaned, rule.match);
    if (outCount === 0) continue;
    will_not_render.push(rule.message(outCount));
  }

  return { stripped, will_not_render };
}

/**
 * Tag-set diff: element open-tags whose count dropped between input and output,
 * minus (a) the ones a specific STRIPPED_RULES entry already reported and
 * (b) <html>/<head>/<body>, which are allowed-but-unwrapped by html5ever (not
 * a content loss). Returns one short advisory per such tag.
 *
 * False-positive defense matches the rest of this module's contract:
 *   - Comments and <script>/<style> bodies are removed from BOTH sides first,
 *     so a tag name living inside stripped content (or a comment) isn't counted
 *     as a "real" element that went missing.
 *   - Entity-encoded text (`&lt;dialog&gt;`) never matches the `<tag` opener
 *     regex, so mentioning a tag in prose can't trigger an advisory.
 *   - We only report when the output count is strictly lower than the input
 *     count — a tag that survived (even once) is never flagged.
 */
function detectStrippedElements(input: string, cleaned: string): string[] {
  const inTags = countOpenTags(stripNoise(input));
  const outTags = countOpenTags(stripNoise(cleaned));
  const out: string[] = [];
  for (const [tag, inCount] of inTags) {
    if (
      SPECIFICALLY_COVERED.has(tag) ||
      UNWRAPPED_OK.has(tag) ||
      CONTEXT_SENSITIVE_OK.has(tag)
    ) {
      continue;
    }
    const removed = inCount - (outTags.get(tag) ?? 0);
    if (removed <= 0) continue;
    out.push(`${removed} <${tag}> (not in the allowlist; element removed, text kept)`);
  }
  return out;
}

/** Strip comments and the raw text bodies of <script>/<style> before
 *  tag-counting. For <script> the body is removed content; for the now-allowed
 *  <style> the body is CSS text, not markup — either way a tag-looking string
 *  inside it (`content:"<div>"`, a commented-out `<img>`) must not read as a
 *  real element that went missing. <style>/<script> survive symmetrically in
 *  both input and output, so removing them from both sides can't skew the diff. */
function stripNoise(s: string): string {
  return s
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, "");
}

/** Count element open-tags by lowercased name. Only well-formed openers
 *  (`<name` where name starts with an ASCII letter) match, so `&lt;x&gt;` and
 *  `</close>` are ignored. Matches HTML and camelCase SVG names alike. */
function countOpenTags(s: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const m of s.matchAll(/<([a-z][a-z0-9-]*)\b/gi)) {
    const tag = m[1].toLowerCase();
    counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return counts;
}

/** Allowed-but-unwrapped by html5ever — losing the wrapper is intended, not a
 *  content strip, so the generic detector must not flag these. */
const UNWRAPPED_OK = new Set(["html", "head", "body"]);

/** Allowed tags with a restricted parent context that html5ever *drops* (not
 *  the allowlist) when they appear mis-nested — e.g. a bare <td> outside a
 *  <table>. They are never allowlist-stripped, so excluding them from the
 *  generic detector loses no real signal while avoiding a "not in the
 *  allowlist" advisory that would be untrue. Used correctly (inside their
 *  parent) their counts are preserved and nothing fires anyway. */
const CONTEXT_SENSITIVE_OK = new Set([
  // table model
  "caption", "colgroup", "col", "thead", "tbody", "tfoot", "tr", "td", "th",
  // list items / description lists
  "li", "dt", "dd",
  // ruby annotations
  "rt", "rp", "rtc",
]);

/** Tag names a specific STRIPPED_RULES entry already reports (with a better,
 *  reason-bearing message). Listed here so the generic detector doesn't
 *  double-report them. Keep in sync with STRIPPED_RULES above. */
const SPECIFICALLY_COVERED = new Set([
  // NB: "style" is intentionally absent — <style> is allowed (v1.4) and its CSS
  // body is excluded from tag-counting by stripNoise, so it never reaches here.
  "script", "link", "iframe", "object", "embed", "applet", "frame",
  "frameset", "meta", "base", "form", "input", "textarea", "select", "button",
  "noscript", "main", "address", "foreignobject", "animate", "animatetransform",
  "animatemotion", "set",
]);

/** Case-insensitive non-overlapping match count. Bounded by string length. */
function countMatches(s: string, re: RegExp): number {
  // Caller passes flag-bearing regexes via the rules table; ensure global+i
  // so .matchAll iterates and we get a stable count.
  const flags = re.flags.includes("g") ? re.flags : `${re.flags}g`;
  const withGlobal = new RegExp(re.source, flags);
  let n = 0;
  for (const _m of s.matchAll(withGlobal)) n++;
  return n;
}

type Rule = {
  match: RegExp;
  message: (count: number) => string;
};

// ---------------------------------------------------------------------------
// stripped[] — patterns we expect to disappear between input and output when
// the sanitizer touches them. Order roughly mirrors the publishing-guide's
// "What gets stripped silently" table so an agent reading both gets a
// consistent picture.
// ---------------------------------------------------------------------------
const STRIPPED_RULES: Rule[] = [
  {
    // The opening tag — closing tags survive as text in the regex sense
    // because html5ever can normalize, so anchor on `<script` opener.
    match: /<script[\s>/]/i,
    message: (n) => `${n} <script> (no JavaScript executes; CSP also blocks)`,
  },
  {
    // <style> is allowed (sanitizer v1.4) — a class-based inline stylesheet
    // survives, so there is no stripped[] advisory for it. External CSS loads
    // it might reference are caught by WILL_NOT_RENDER_RULES instead.
    match: /<link[\s>][^>]*\brel\s*=\s*["']?stylesheet/i,
    message: (n) => `${n} <link rel=stylesheet> (external CSS blocked; put rules in an inline <style> block)`,
  },
  {
    match: /<iframe[\s>]/i,
    message: (n) => `${n} <iframe> (no embedded content)`,
  },
  {
    match: /<(object|embed|applet|frame|frameset)[\s>]/i,
    message: (n) => `${n} <object>/<embed>/<applet>/<frame> (no embedded content)`,
  },
  {
    match: /<meta[\s>]/i,
    message: (n) => `${n} <meta> (can carry http-equiv refresh redirects)`,
  },
  {
    match: /<base[\s>]/i,
    message: (n) => `${n} <base> (URL rewriting blocked)`,
  },
  {
    match: /<(form|input|textarea|select|button)[\s>]/i,
    message: (n) =>
      `${n} <form>/<input>/<textarea>/<select>/<button> (this is a display surface, not interactive)`,
  },
  {
    match: /<noscript[\s>]/i,
    message: (n) => `${n} <noscript> (not in allowlist; JS never runs anyway)`,
  },
  {
    match: /<(main|address)[\s>]/i,
    message: (n) => `${n} <main>/<address> (use <section> or <div> instead)`,
  },
  {
    match: /<foreignObject[\s>]/i,
    message: (n) => `${n} <foreignObject> (re-enables HTML inside SVG)`,
  },
  {
    match: /<(animate|animateTransform|animateMotion|set)[\s>]/i,
    message: (n) => `${n} SVG <animate*>/<set> (can retarget href to javascript:)`,
  },
  {
    // Inline event handlers — match the attribute prefix, not just `on=`
    // (which would false-positive on legitimate attrs like `lang="on"`).
    // Require `on` + letters + `=`, with a leading space/quote/newline so
    // it's clearly an attribute boundary.
    match: /[\s"'/]on[a-z]+\s*=/i,
    message: (n) => `${n} inline event handler attribute (on*=; no JavaScript runs)`,
  },
  {
    match: /\b(href|src|action|formaction|xlink:href)\s*=\s*["']?\s*javascript:/i,
    message: (n) => `${n} javascript: URL (script-execution vector)`,
  },
  {
    match: /\b(href|src|action|formaction|xlink:href)\s*=\s*["']?\s*vbscript:/i,
    message: (n) => `${n} vbscript: URL`,
  },
  {
    // data: in href/src. The sanitizer's URL-scheme allowlist drops it
    // (which is the right default — a data:text/html href can navigate to
    // attacker-controlled HTML). The whole attribute disappears, so an
    // <img data:...> becomes an <img> with no src — broken-image render.
    match: /\b(href|src|xlink:href)\s*=\s*["']?\s*data:/i,
    message: (n) =>
      `${n} data: URL in href/src (sanitizer URL allowlist; for visuals use inline SVG)`,
  },
  {
    // ARIA IDREF-typed attributes we deliberately deny — see WICG sanitizer-api#245
    // and sanitizer/src/lib.rs DENIED_ARIA_ATTRS.
    match: /\baria-(owns|controls|activedescendant|flowto)\s*=/i,
    message: (n) =>
      `${n} IDREF-typed aria-* attribute (accessibility-tree hijack risk; other aria-* are allowed)`,
  },
  {
    match: /\btarget\s*=\s*["']?_/i,
    message: (n) =>
      `${n} target= stripped on a non-http(s) link (fragment/relative links open in-frame; external http/https links auto-open in a new tab)`,
  },
  {
    // HTML comments. Match `<!--` opener; html5ever strips the closing too.
    match: /<!--/,
    message: (n) => `${n} HTML comment (stripped entirely)`,
  },
];

// ---------------------------------------------------------------------------
// will_not_render[] — patterns that survive the sanitizer but the served
// CSP refuses to load. Without this advisory the agent sees `modified: false`
// and a broken render with no clue why.
//
// Two cases today: an external <img src>, and (since <style> is allowed in
// v1.4) a surviving stylesheet that references an external URL — an
// `@import`, `url(https://…)` background, or `@font-face src: url(https://…)`.
// The render CSP's style/img/font-src are `self`/`data:` only, so any external
// origin in CSS silently fails to load.
// ---------------------------------------------------------------------------
const WILL_NOT_RENDER_RULES: Rule[] = [
  {
    match: /<img\b[^>]*\bsrc\s*=\s*["']?https?:/i,
    message: (n) =>
      `${n} <img> with external src (iframe CSP img-src 'self' data: blocks the load; use inline SVG for visuals)`,
  },
  {
    // External URL inside CSS: `url(https://…)`, `url("https://…")`, or an
    // `@import "https://…"`. Matches the cleaned output, where an allowed
    // <style> block keeps its CSS verbatim. data:/relative URLs are fine and
    // don't match. CSS comments can produce a false positive — acceptable for
    // an advisory (false negatives ok, and it only nudges toward the guide).
    match: /(?:@import\s+|url\(\s*)["']?https?:\/\//i,
    message: (n) =>
      `${n} external URL in CSS (CSP style/img/font-src is 'self' data: only; inline the rules, use a data: URI, or draw with inline SVG)`,
  },
];
