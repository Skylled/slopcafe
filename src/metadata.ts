/**
 * Optional per-version document metadata: title, description, tags.
 *
 * Three concerns live here so src/core.ts can stay focused on the
 * sanitize/cap-check/R2/D1 sequence:
 *
 *   1. Input validation — what an agent supplies (via MCP tool args or HTTP
 *      X-Doc-* headers) before we store it. Lightweight: NFC normalize,
 *      strip ASCII control characters, collapse whitespace, length cap.
 *      Tags additionally have a [A-Za-z0-9_-] charset restriction enforced
 *      by silently stripping disallowed bytes (per the user's "sanitize"
 *      framing — invalid chars don't reject the request).
 *
 *   2. Derivation — when an agent omits a title, pull one out of the
 *      already-sanitized HTML. First <h1>'s text content, or fall back to
 *      the first ~80 chars of stripped-tag text. Runs on POST-sanitize
 *      bytes so derived titles can't leak content the sanitizer stripped.
 *
 *   3. Display normalization — applied at SHELL render time (src/serve.ts),
 *      NOT at write. Strips Unicode bidi overrides + zero-width + control
 *      chars so a malicious title can't reorder the " | Slopcafe" brand
 *      suffix visually in a browser tab. The defense is intentionally
 *      layered: write-time validation preserves agent intent for the API
 *      surface (list_documents returns the raw stored value), and the
 *      shell page applies the stronger anti-phishing pass for humans.
 *
 * The "shape" of inputs the rest of the system uses (DocumentMetadataInput,
 * ResolvedMetadata) is exported here too so neither callers nor core have
 * to redefine it.
 */

// ---------------------------------------------------------------------------
// Public limits & constants
// ---------------------------------------------------------------------------

/** Brand suffix appended to the shell `<title>` tag — see formatPageTitle. */
export const SITE_BRAND = "Slopcafe";

/** Cap on agent-supplied title input (pre-display-normalization). */
export const TITLE_MAX_INPUT_CHARS = 300;

/** Cap on titles derived from document content (H1 or first-N fallback). */
export const TITLE_MAX_DERIVED_CHARS = 200;

/** Final cap applied at display time after anti-phishing normalization. */
export const TITLE_DISPLAY_MAX_CHARS = 200;

/** Cap on agent-supplied description input. */
export const DESCRIPTION_MAX_CHARS = 500;

/** Max number of tags retained per version (extras are silently dropped). */
export const TAGS_MAX_COUNT = 10;

/** Cap on a single tag's char count after sanitization. */
export const TAG_MAX_CHARS = 32;

/** Anything not in this set is stripped from tags at write time. */
const TAG_CHAR_RE = /[^A-Za-z0-9_-]/g;

// ---------------------------------------------------------------------------
// Char-range strip regexes, built programmatically.
//
// We construct these from numeric ranges rather than embedding literal
// control / bidi / zero-width characters in source — those are invisible
// in most editors and trivially lost in a refactor or copy-paste. The
// hex-number tables below are the reviewable surface.
// ---------------------------------------------------------------------------

/**
 * Code-point ranges stripped from titles at DISPLAY time
 * (normalizeTitleForDisplay). Each tuple is inclusive [lo, hi]:
 *
 *   0x0000–0x0008  C0 controls (non-whitespace)
 *   0x000E–0x001F  C0 controls (non-whitespace)
 *   0x007F–0x009F  DEL + C1 controls
 *   0x200B–0x200D  ZWSP, ZWNJ, ZWJ
 *   0x2060         word joiner
 *   0x202A–0x202E  legacy bidi overrides (LRE/RLE/PDF/LRO/RLO)
 *   0x2066–0x2069  Unicode 6.3 bidi isolates (LRI/RLI/FSI/PDI)
 *   0xFEFF         BOM / zero-width no-break space
 *
 * The whitespace-class controls (U+0009 TAB, U+000A LF, U+000B VT, U+000C FF,
 * U+000D CR) are deliberately NOT stripped here — they pass through and get
 * folded to a single space by WS_RUN_RE. Stripping them outright would
 * silently merge words ("a\tb" → "ab" instead of "a b"), which is worse
 * for screen-reader / search use than the visible whitespace they replace.
 */
const DISPLAY_STRIP_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x0008],
  [0x000e, 0x001f],
  [0x007f, 0x009f],
  [0x200b, 0x200d],
  [0x2060, 0x2060],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
];

/**
 * Code-point ranges stripped at WRITE time (validateTitleInput,
 * validateDescriptionInput). Just non-whitespace C0 + C1 controls; bidi
 * and zero-width are preserved in storage so agents reading back via
 * list_documents see what they supplied byte-for-byte (modulo NFC +
 * whitespace fold + length). Whitespace controls (TAB/LF/CR/VT/FF) pass
 * through to be folded to spaces by WS_RUN_RE — see the comment on
 * DISPLAY_STRIP_RANGES for why.
 */
const INPUT_STRIP_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x0008],
  [0x000e, 0x001f],
  [0x007f, 0x009f],
];

const DISPLAY_STRIP_RE = makeCharRangeRegExp(DISPLAY_STRIP_RANGES);
const INPUT_CONTROL_STRIP_RE = makeCharRangeRegExp(INPUT_STRIP_RANGES);

/** Collapse any run of whitespace (space/tab/newline/etc.) to a single space. */
const WS_RUN_RE = /\s+/g;

/**
 * Compose a global RegExp matching any character in the supplied code-point
 * ranges. Built via the RegExp constructor with `\\uXXXX` escapes so the
 * source file stays printable-ASCII.
 */
function makeCharRangeRegExp(
  ranges: ReadonlyArray<readonly [number, number]>,
): RegExp {
  const cls = ranges
    .map(([lo, hi]) =>
      lo === hi ? unicodeEscape(lo) : `${unicodeEscape(lo)}-${unicodeEscape(hi)}`,
    )
    .join("");
  return new RegExp("[" + cls + "]", "g");
}

function unicodeEscape(cp: number): string {
  return "\\u" + cp.toString(16).toUpperCase().padStart(4, "0");
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Caller-supplied metadata for a publish/update operation.
 *
 * Semantics:
 *   - `undefined` field → inherit from prior version on UPDATE; default
 *     (derive title / null description / [] tags) on PUBLISH.
 *   - `""` title → re-derive from new content (override prior derivation).
 *   - `""` description → clear to null.
 *   - `[]` tags → clear to empty.
 *   - Non-empty value → use as-is (after validation/sanitization).
 *
 * The resolution against the prior version happens inside src/core.ts;
 * this module just defines the shape.
 */
export type DocumentMetadataInput = {
  title?: string;
  description?: string;
  tags?: string[];
};

/**
 * What ends up stored on the versions row (and surfaced to agents on read).
 * `title` is null when neither agent input nor derivation produced one
 * (typical for documents with no text content). `tags` is always an array
 * — empty is the "no tags" representation.
 */
export type ResolvedMetadata = {
  title: string | null;
  description: string | null;
  tags: string[];
};

// ---------------------------------------------------------------------------
// Input validators
// ---------------------------------------------------------------------------

/**
 * Normalize an agent-supplied title for storage. Returns the cleaned string
 * (may be empty — callers interpret "" as "re-derive from content").
 *
 * Bidi chars are preserved here — the anti-phishing strip lives at display
 * time so list_documents can return the raw stored value to agents.
 */
export function validateTitleInput(raw: string): string {
  return raw
    .normalize("NFC")
    .replace(INPUT_CONTROL_STRIP_RE, "")
    .replace(WS_RUN_RE, " ")
    .trim()
    .slice(0, TITLE_MAX_INPUT_CHARS);
}

/**
 * Normalize an agent-supplied description for storage. Returns the cleaned
 * string (may be empty — callers interpret "" as "clear to null").
 *
 * Same shape as validateTitleInput: NFC + strip control + collapse whitespace
 * + trim + cap. Bidi is preserved (description isn't a phishing surface — it
 * surfaces as <meta name="description"> which the browser doesn't render in
 * the tab title).
 */
export function validateDescriptionInput(raw: string): string {
  return raw
    .normalize("NFC")
    .replace(INPUT_CONTROL_STRIP_RE, "")
    .replace(WS_RUN_RE, " ")
    .trim()
    .slice(0, DESCRIPTION_MAX_CHARS);
}

/**
 * Clean an array of agent-supplied tags. Per tag: strip chars outside
 * [A-Za-z0-9_-], truncate to TAG_MAX_CHARS, drop empties. Dedupe
 * (case-sensitive — "AI" and "ai" are distinct, preserving agent intent).
 * Cap the array to TAGS_MAX_COUNT.
 *
 * Defensive: accepts `unknown` so it can safely handle MCP / JSON inputs
 * that may not have been type-checked at the boundary.
 */
export function sanitizeTagsInput(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== "string") continue;
    const cleaned = raw.replace(TAG_CHAR_RE, "").slice(0, TAG_MAX_CHARS);
    if (cleaned.length === 0) continue;
    if (seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
    if (out.length >= TAGS_MAX_COUNT) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Title derivation from document content
// ---------------------------------------------------------------------------

/** Match the first <h1>...</h1>. `[\s\S]` so newlines inside survive. */
const H1_RE = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i;

/** Strip every HTML tag — used to flatten H1 inner content (or whole-doc). */
const TAG_RE = /<[^>]+>/g;

/** Cap on the fallback-to-first-N-chars derivation when no <h1> exists. */
const TITLE_FALLBACK_CHARS = 80;

/**
 * Pull a usable title out of already-sanitized HTML.
 *
 *   1. First <h1>'s text content (inline tags stripped, entities decoded).
 *   2. Fallback: first TITLE_FALLBACK_CHARS of the document's stripped-tag
 *      text — useful for docs that lead with a paragraph instead of a heading.
 *   3. Returns null when there's no extractable text at all.
 *
 * Runs on POST-sanitize bytes, never on raw agent input. Two reasons that
 * order matters: (a) derived titles reflect exactly what the renderer would
 * show, not what the agent tried to ship; (b) anything the sanitizer
 * stripped can't leak back through the title channel.
 */
export function deriveTitleFromHtml(cleanedHtml: string): string | null {
  const h1 = H1_RE.exec(cleanedHtml);
  if (h1) {
    const text = flattenHtmlText(h1[1]!);
    if (text.length > 0) {
      return text.slice(0, TITLE_MAX_DERIVED_CHARS);
    }
  }

  // Fallback: whole-document text, first N chars.
  const allText = flattenHtmlText(cleanedHtml);
  if (allText.length === 0) return null;
  return allText.slice(0, TITLE_FALLBACK_CHARS);
}

/**
 * Strip HTML tags, decode the entity set our sanitizer emits, collapse
 * whitespace, trim. Used by both the H1 path and the fallback path. Not
 * a full HTML parser — the input is bounded by the sanitizer's allowlist,
 * so a small regex is sufficient.
 */
function flattenHtmlText(html: string): string {
  return decodeEntities(html.replace(TAG_RE, " "))
    .replace(WS_RUN_RE, " ")
    .trim();
}

/**
 * Lightweight HTML entity decoder. Handles the named entities the sanitizer
 * is most likely to emit, plus decimal (`&#N;`) and hex (`&#xH;`) numeric
 * references. Unknown named entities pass through unchanged rather than
 * being silently corrupted.
 *
 * Single pass with a dispatching regex — no double-decode bugs (e.g.
 * "&amp;lt;" stays as "&lt;", not as "<").
 */
function decodeEntities(s: string): string {
  return s.replace(
    /&(?:(#x[0-9A-Fa-f]+)|(#[0-9]+)|([A-Za-z][A-Za-z0-9]*));/g,
    (full, hex, dec, named) => {
      if (hex) {
        // hex matches "#xNNNN" — slice off both "#" and "x".
        const cp = parseInt(hex.slice(2), 16);
        return safeFromCodePoint(cp) ?? full;
      }
      if (dec) {
        // dec matches "#NNN" — slice off the leading "#".
        const cp = parseInt(dec.slice(1), 10);
        return safeFromCodePoint(cp) ?? full;
      }
      if (named) {
        return NAMED_ENTITIES[named] ?? full;
      }
      return full;
    },
  );
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ", // intentional: collapse to plain space so WS_RUN_RE folds runs
};

function safeFromCodePoint(cp: number): string | null {
  if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return null;
  try {
    return String.fromCodePoint(cp);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Display-time normalization (browser-tab phishing mitigation)
// ---------------------------------------------------------------------------

/**
 * Anti-phishing pass for the shell page `<title>` rendering. Removes Unicode
 * mechanisms a malicious title could use to reorder visible characters in
 * the browser tab — most notably the right-to-left override (U+202E) which
 * could flip "Login | Slopcafe" into "efacpolS | nigoL" (visually) while
 * the stored value still says "Login".
 *
 * Strips:
 *   - C0/C1 control chars
 *   - Bidi overrides (LRE/RLE/PDF/LRO/RLO) and bidi isolates (LRI/RLI/FSI/PDI)
 *   - Zero-width formatting chars (ZWSP, ZWNJ, ZWJ, WJ, BOM)
 *
 * Then NFC-normalizes, collapses whitespace, trims, and length-caps.
 * Final HTML-escape happens at interpolation in src/serve.ts (existing
 * escapeHtml helper — single point for the encoding layer).
 */
export function normalizeTitleForDisplay(title: string): string {
  return title
    .normalize("NFC")
    .replace(DISPLAY_STRIP_RE, "")
    .replace(WS_RUN_RE, " ")
    .trim()
    .slice(0, TITLE_DISPLAY_MAX_CHARS);
}

/**
 * Compose the shell `<title>` value: normalized title + " | Slopcafe".
 * Falls back to bare brand for a null/empty title so a doc without one
 * still shows a usable tab label.
 */
export function formatPageTitle(rawTitle: string | null | undefined): string {
  if (!rawTitle) return SITE_BRAND;
  const normalized = normalizeTitleForDisplay(rawTitle);
  if (normalized.length === 0) return SITE_BRAND;
  return `${normalized} | ${SITE_BRAND}`;
}

// ---------------------------------------------------------------------------
// HTTP header parsing
// ---------------------------------------------------------------------------

/**
 * Lift `X-Doc-Title` / `X-Doc-Description` / `X-Doc-Tags` headers off a
 * request into the DocumentMetadataInput shape `core.ts` expects.
 *
 * Header semantics:
 *   - Header absent      → field stays `undefined` (inherit on update,
 *                          default on publish)
 *   - Header present     → field is set, even if empty. Empty string is
 *                          the "clear / re-derive" signal.
 *
 * `X-Doc-Tags` is comma-separated (charset is restricted to [A-Za-z0-9_-]
 * so the comma is always a safe delimiter). Each segment is trimmed, then
 * routed through `sanitizeTagsInput` for charset + length + dedupe + cap.
 */
export function parseMetadataHeaders(req: Request): DocumentMetadataInput {
  const opts: DocumentMetadataInput = {};

  const titleHeader = req.headers.get("x-doc-title");
  if (titleHeader !== null) {
    opts.title = validateTitleInput(titleHeader);
  }

  const descHeader = req.headers.get("x-doc-description");
  if (descHeader !== null) {
    opts.description = validateDescriptionInput(descHeader);
  }

  const tagsHeader = req.headers.get("x-doc-tags");
  if (tagsHeader !== null) {
    // Empty header → empty array (the explicit "clear all tags" signal).
    const parts =
      tagsHeader.length === 0 ? [] : tagsHeader.split(",").map((s) => s.trim());
    opts.tags = sanitizeTagsInput(parts);
  }

  return opts;
}
