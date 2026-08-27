// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/**
 * Optional document metadata: title and description (per-version) plus tags
 * (document-level since migration 0012, like slug).
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

/** Max number of tags retained per document (extras are silently dropped). */
export const TAGS_MAX_COUNT = 10;

/** Cap on a single tag's char count after sanitization. */
export const TAG_MAX_CHARS = 32;

/** Anything not in this set is stripped from tags at write time. */
const TAG_CHAR_RE = /[^A-Za-z0-9_-]/g;

/** Cap on a slug's char count. Lower than tags' 32 because URL-style slugs */
/** are typically much shorter; 64 leaves room for kebab-case multi-word IDs. */
export const SLUG_MAX_CHARS = 64;

// ---------------------------------------------------------------------------
// Insight structured metadata (agent-web-host-insight fork, migration 0019)
//
// Six document-level fields (documents.app_package / app_version_code /
// app_version_name / compared_version_code / company / doc_kind) that let the
// auto-insight Android-teardown producer filter/range-query its corpus beyond
// what tags can express (dots aren't in the tag charset; a JSON tags array
// can't be range-queried). See slopcafe_migration/DESIGN.md Decision 8.
//
// Validation posture mirrors tags, not slug: silently sanitize/cap rather
// than reject. These columns carry no uniqueness constraint (unlike slug), so
// a malformed value can't collide with or corrupt another document — the
// same reasoning that lets sanitizeTagsInput strip instead of 422.
// ---------------------------------------------------------------------------

/** Cap on agent-supplied app_package input (e.g. "com.google.android.gms"). */
export const APP_PACKAGE_MAX_CHARS = 200;

/** Cap on agent-supplied app_version_name input (e.g. "17.5.34"). */
export const APP_VERSION_NAME_MAX_CHARS = 100;

/** Cap on agent-supplied company input (e.g. "Google"). */
export const COMPANY_MAX_CHARS = 100;

/**
 * The fixed Insight document-kind vocabulary (slopcafe_migration/DESIGN.md
 * Decision 9), pinned here AND in the migration 0019 CHECK constraint so the
 * teardown pipeline and the future investigation agents (teardown-analyst /
 * teardown-writer / investigation-manager) share one taxonomy instead of
 * re-keying later. Keep this array and the CHECK constraint in lockstep.
 */
export const DOC_KIND_VALUES = [
  "teardown",
  "teardown-section",
  "writeup",
  "hypothesis",
  "experiment-result",
  "kb-feature",
  "analyst-context",
] as const;

/** One of the fixed Insight document kinds — see DOC_KIND_VALUES. */
export type DocKind = (typeof DOC_KIND_VALUES)[number];

/** Type guard: is `value` one of the fixed DOC_KIND_VALUES? */
export function isDocKind(value: string): value is DocKind {
  return (DOC_KIND_VALUES as readonly string[]).includes(value);
}

/**
 * Allowed slug shape: lowercase URL-safe identifier, 1-64 chars, must start
 * and end with alphanumeric (so `-foo`, `foo-`, `_foo`, `foo_` are rejected).
 * Underscore and hyphen are allowed in the middle. Single-char slugs match
 * the `[a-z0-9]` half of the alternation.
 *
 * Unlike tags (which silently sanitize invalid chars), slug validation
 * REJECTS invalid input — uniqueness means a silently-mutated input could
 * unexpectedly collide with another doc. The caller surfaces invalid_slug
 * as a distinct error code (see src/core.ts).
 */
const SLUG_RE = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;

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
 *     (derive title / null description) on PUBLISH. EXCEPT `tags`, which is
 *     document-level (migration 0012, like `slug`): `undefined` leaves the
 *     document's tags ALONE on update; PUBLISH defaults to `[]`.
 *   - `""` title → re-derive from new content (override prior derivation).
 *   - `""` description → clear to null.
 *   - `[]` tags → clear the document's tags (NULL on `documents.tags`).
 *   - Non-empty value → use as-is (after validation/sanitization).
 *
 * The resolution happens inside src/core.ts — title/description against the
 * prior version, tags against the document row; this module just defines the
 * shape.
 */
export type DocumentMetadataInput = {
  title?: string;
  description?: string;
  tags?: string[];
  /**
   * Optional document slug (unique handle, releaseable on revoke). Lives
   * on the `documents` row — not per-version — so the resolution path in
   * core.ts treats this field differently from the per-version triple:
   *
   *   - `undefined` → no change (keep current slug on update; null on publish)
   *   - `""`        → clear (release the slug; documents.slug = NULL)
   *   - non-empty   → claim after validateSlugInput; collides if taken
   *
   * Validation is REJECT-on-invalid (not silently sanitize), so the caller
   * surfaces a distinct `invalid_slug` error code rather than mutating the
   * agent's input.
   */
  slug?: string;

  /**
   * Insight structured metadata (agent-web-host-insight fork, migration
   * 0019) — all six document-level, like `tags`/`slug`, so resolution in
   * core.ts happens against the document row, not the prior version. Two
   * shapes depending on field type:
   *
   *   - string fields (`app_package`, `app_version_name`, `company`):
   *     `undefined` → leave the column ALONE on update (no default derivation
   *     exists, unlike title — publish has no "leave alone" case, so an
   *     omitted field there is born NULL, same as tags' "no leave-alone case
   *     on publish"); `""` → clear to NULL; non-empty → validated + stored.
   *   - numeric fields (`app_version_code`, `compared_version_code`):
   *     `undefined` → leave alone / NULL on publish; `null` → explicit clear
   *     (mirrors `""` for the string fields — a bare empty string can't carry
   *     "clear" for a numeric column); a number → validated non-negative
   *     integer and stored.
   *   - `doc_kind`: same undefined/"" shape as the string fields, but a
   *     non-empty value must be one of DOC_KIND_VALUES — see
   *     resolveDocKindForWrite in core.ts for what happens to an
   *     out-of-vocabulary value (silently dropped, not rejected — same
   *     permissive posture as tags' charset strip).
   */
  app_package?: string;
  app_version_code?: number | null;
  app_version_name?: string;
  compared_version_code?: number | null;
  company?: string;
  doc_kind?: string;
};

/**
 * What ends up stored on the versions row (and surfaced to agents on read).
 * `title` is null when neither agent input nor derivation produced one
 * (typical for documents with no text content).
 *
 * Tags are NOT here: since migration 0012 they live on `documents` (document-
 * level classification, like `slug`), resolved separately by the write path —
 * see `resolveTagsForWrite` in src/core.ts.
 */
export type ResolvedMetadata = {
  title: string | null;
  description: string | null;
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
 * Normalize an agent-supplied Insight `app_package` for storage (migration
 * 0019). Same shape as validateDescriptionInput — NFC + strip control +
 * collapse whitespace + trim + cap — deliberately permissive: this column
 * carries no uniqueness constraint, so unlike slug there's no collision risk
 * in accepting whatever the producer sends (an Android package name is
 * reverse-DNS-shaped, but we don't enforce that shape here).
 */
export function validateAppPackageInput(raw: string): string {
  return raw
    .normalize("NFC")
    .replace(INPUT_CONTROL_STRIP_RE, "")
    .replace(WS_RUN_RE, " ")
    .trim()
    .slice(0, APP_PACKAGE_MAX_CHARS);
}

/**
 * Normalize an agent-supplied Insight `app_version_name` for storage
 * (migration 0019). Same shape as validateAppPackageInput.
 */
export function validateAppVersionNameInput(raw: string): string {
  return raw
    .normalize("NFC")
    .replace(INPUT_CONTROL_STRIP_RE, "")
    .replace(WS_RUN_RE, " ")
    .trim()
    .slice(0, APP_VERSION_NAME_MAX_CHARS);
}

/**
 * Normalize an agent-supplied Insight `company` for storage (migration
 * 0019). Same shape as validateAppPackageInput.
 */
export function validateCompanyInput(raw: string): string {
  return raw
    .normalize("NFC")
    .replace(INPUT_CONTROL_STRIP_RE, "")
    .replace(WS_RUN_RE, " ")
    .trim()
    .slice(0, COMPANY_MAX_CHARS);
}

/**
 * Parse an agent-supplied Insight version-code string into a validated
 * non-negative integer (migration 0019). Used by BOTH the `X-Doc-App-
 * Version-Code` / `X-Doc-Compared-Version-Code` header parsers below AND
 * (defensively) by core.ts's resolver, so a header and an MCP-args value
 * are held to the identical rule regardless of origin.
 *
 * Returns `null` for a value that doesn't parse to a non-negative integer —
 * callers treat that as "drop the field" (permissive posture, matching tags'
 * charset-strip rather than slug's hard reject: a malformed version code
 * can't corrupt or collide with anything, so silently ignoring it is safer
 * than failing an otherwise-valid publish/update over one bad header).
 */
export function parseVersionCodeInput(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
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

/** Why a slug input was rejected — used by core to map to error codes. */
export type SlugReject =
  | "too_long"
  | "bad_charset"
  | "must_start_alnum"
  | "must_end_alnum"
  | "empty";

/**
 * Validate an agent-supplied slug for storage.
 *
 * Returns `{ ok: true, slug }` on success (lowercased + trimmed input that
 * matches SLUG_RE), or `{ ok: false, reason }` on rejection. The caller
 * surfaces a structured `invalid_slug` error rather than silently mutating
 * input — uniqueness means agents need to know exactly what was rejected.
 *
 * Input is trimmed and lowercased BEFORE the regex check, so `"  My-Slug  "`
 * becomes `"my-slug"` and validates. This is a courtesy convenience — the
 * canonical form an agent should send and store is the lowercased version.
 *
 * Empty input (after trim) is the explicit "clear slug" signal at the
 * caller (`""` in DocumentMetadataInput); this function rejects it so the
 * caller's "is the field present and non-empty?" check handles the clear
 * case before getting here.
 */
export function validateSlugInput(raw: string): { ok: true; slug: string } | { ok: false; reason: SlugReject } {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.length === 0) return { ok: false, reason: "empty" };
  if (trimmed.length > SLUG_MAX_CHARS) return { ok: false, reason: "too_long" };
  if (!SLUG_RE.test(trimmed)) {
    // Distinguish the three common failure modes so the error message can
    // tell the agent exactly which rule was broken.
    if (!/^[a-z0-9]/.test(trimmed)) return { ok: false, reason: "must_start_alnum" };
    if (!/[a-z0-9]$/.test(trimmed)) return { ok: false, reason: "must_end_alnum" };
    return { ok: false, reason: "bad_charset" };
  }
  return { ok: true, slug: trimmed };
}

/**
 * Render a `SlugReject` code as a human/agent-readable message. Shared by every
 * surface that surfaces an `invalid_slug` error (HTTP `POST`/`PUT /d`, the
 * operator `POST /admin/documents/:id/slug`, and the browser slug form) so the
 * wording stays in lockstep with the validation rules above.
 */
export function formatSlugReject(reason: SlugReject): string {
  switch (reason) {
    case "empty":
      return "slug must be non-empty (pass an empty value to clear an existing slug)";
    case "too_long":
      return "slug exceeds 64 characters";
    case "bad_charset":
      return "slug may only contain lowercase letters, digits, '-', '_'";
    case "must_start_alnum":
      return "slug must start with a lowercase letter or digit";
    case "must_end_alnum":
      return "slug must end with a lowercase letter or digit";
  }
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
 * Shared display normalization helper. Applies NFC normalization, strips
 * dangerous control / bidi / zero-width characters, collapses whitespace,
 * trims, and truncates to the specified character limit.
 */
function normalizeForDisplay(text: string, maxChars: number): string {
  return text
    .normalize("NFC")
    .replace(DISPLAY_STRIP_RE, "")
    .replace(WS_RUN_RE, " ")
    .trim()
    .slice(0, maxChars);
}

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
  return normalizeForDisplay(title, TITLE_DISPLAY_MAX_CHARS);
}

/**
 * Anti-phishing pass for description fields (rendered in shell page meta tags
 * and social cards). Prevents malicious spoofing of preview text rendering.
 *
 * Same normalization logic as normalizeTitleForDisplay, but capped at
 * DESCRIPTION_MAX_CHARS (500).
 */
export function normalizeDescriptionForDisplay(desc: string): string {
  return normalizeForDisplay(desc, DESCRIPTION_MAX_CHARS);
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

/** Reused, non-streaming UTF-8 decoder for header recovery (see below). */
const HEADER_UTF8_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

/**
 * Read an `X-Doc-*` header value as UTF-8.
 *
 * Per the Fetch standard, an HTTP header value is a *ByteString*: `Headers.get`
 * hands back one JS char per raw byte (a Latin-1 view). So a client that sent
 * the UTF-8 bytes for `café — résumé` (`63 61 66 c3 a9 …`) gets the mojibake
 * `cafÃ© â€" rÃ©sumÃ©` — and a character that can't fit in one byte (an em-dash,
 * a curly quote, any CJK/emoji) is unrepresentable in a Latin-1 header at all.
 * That mismatch is exactly why an agent felt it had to downgrade an em-dash to a
 * hyphen: the header contract was implicitly Latin-1 while everything else here
 * (the request body, MCP JSON args, the served `charset=utf-8`) is UTF-8.
 *
 * This re-reads the byte view and decodes it as UTF-8 so the `X-Doc-*` metadata
 * contract is unambiguously UTF-8, matching the rest of the surface. The decode
 * is *fatal* with a fall-back, which makes it lossless across the realistic
 * client behaviors:
 *   - pure ASCII            → valid UTF-8, decodes to itself (the common case);
 *   - UTF-8 multi-byte      → recovered exactly (`café — résumé`), so an em-dash
 *                             in a title now just works;
 *   - a lone Latin-1 byte   → e.g. a browser `fetch` sends `é` as the single
 *                             byte `0xE9`, which is *invalid* UTF-8 → the decode
 *                             throws and we keep the original char, preserving
 *                             the value that was already correct.
 *
 * The leading guard covers a runtime that already decoded the value for us
 * (chars beyond 0xFF can't be a raw ByteString): re-encoding those would corrupt
 * them, so we return the string untouched.
 */
function decodeHeaderUtf8(value: string): string {
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) > 0xff) return value; // already decoded by the runtime
  }
  try {
    const bytes = Uint8Array.from(value, (c) => c.charCodeAt(0));
    return HEADER_UTF8_DECODER.decode(bytes);
  } catch {
    return value; // not UTF-8 — the bytes were already a faithful Latin-1 string
  }
}

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
 * Every value is decoded as UTF-8 first (see `decodeHeaderUtf8`) so the header
 * channel carries the full Unicode range, just like the request body and the
 * MCP JSON args — no need to ASCII-fold or entity-encode metadata defensively.
 *
 * `X-Doc-Tags` is comma-separated (charset is restricted to [A-Za-z0-9_-]
 * so the comma is always a safe delimiter). Each segment is trimmed, then
 * routed through `sanitizeTagsInput` for charset + length + dedupe + cap.
 *
 * `X-Doc-Slug` is passed through as a raw (UTF-8-decoded) string — the
 * validateSlugInput call happens in core so the REJECT path is symmetric across
 * HTTP and MCP (a non-ASCII slug then rejects with a clear `bad_charset` rather
 * than a confusing mojibake one). An empty header value is preserved as the
 * explicit "clear slug" signal.
 *
 * Insight structured metadata (migration 0019) rides six more `X-Doc-*`
 * headers, each following the shape documented on DocumentMetadataInput:
 *
 *   X-Doc-App-Package            - string; "" clears
 *   X-Doc-App-Version-Code       - non-negative integer string; "" clears
 *                                  (→ null); a value that fails
 *                                  parseVersionCodeInput is silently DROPPED
 *                                  (the field stays unset — a malformed
 *                                  header leaves the document's current
 *                                  value untouched rather than failing the
 *                                  whole write)
 *   X-Doc-App-Version-Name       - string; "" clears
 *   X-Doc-Compared-Version-Code  - same shape as X-Doc-App-Version-Code
 *   X-Doc-Company                - string; "" clears
 *   X-Doc-Kind                   - one of DOC_KIND_VALUES; "" clears; an
 *                                  out-of-vocabulary value is silently
 *                                  DROPPED (same permissive posture as an
 *                                  invalid version code, not slug's hard
 *                                  reject — there's no uniqueness at stake)
 */
export function parseMetadataHeaders(req: Request): DocumentMetadataInput {
  const opts: DocumentMetadataInput = {};

  const titleHeader = req.headers.get("x-doc-title");
  if (titleHeader !== null) {
    opts.title = validateTitleInput(decodeHeaderUtf8(titleHeader));
  }

  const descHeader = req.headers.get("x-doc-description");
  if (descHeader !== null) {
    opts.description = validateDescriptionInput(decodeHeaderUtf8(descHeader));
  }

  const tagsHeader = req.headers.get("x-doc-tags");
  if (tagsHeader !== null) {
    // Empty header → empty array (the explicit "clear all tags" signal).
    const decoded = decodeHeaderUtf8(tagsHeader);
    const parts =
      decoded.length === 0 ? [] : decoded.split(",").map((s) => s.trim());
    opts.tags = sanitizeTagsInput(parts);
  }

  const slugHeader = req.headers.get("x-doc-slug");
  if (slugHeader !== null) {
    // Raw pass-through — empty preserved for the "clear" signal, validation
    // (and lowercase/trim) lives in core so MCP and HTTP share one error path.
    opts.slug = decodeHeaderUtf8(slugHeader);
  }

  // -- Insight structured metadata (migration 0019) --------------------------

  const appPackageHeader = req.headers.get("x-doc-app-package");
  if (appPackageHeader !== null) {
    opts.app_package = validateAppPackageInput(decodeHeaderUtf8(appPackageHeader));
  }

  const appVersionCodeHeader = req.headers.get("x-doc-app-version-code");
  if (appVersionCodeHeader !== null) {
    const decoded = decodeHeaderUtf8(appVersionCodeHeader);
    if (decoded.trim().length === 0) {
      opts.app_version_code = null; // explicit clear
    } else {
      const parsed = parseVersionCodeInput(decoded);
      if (parsed !== null) opts.app_version_code = parsed;
      // else: malformed header — leave opts.app_version_code unset (drop).
    }
  }

  const appVersionNameHeader = req.headers.get("x-doc-app-version-name");
  if (appVersionNameHeader !== null) {
    opts.app_version_name = validateAppVersionNameInput(decodeHeaderUtf8(appVersionNameHeader));
  }

  const comparedVersionCodeHeader = req.headers.get("x-doc-compared-version-code");
  if (comparedVersionCodeHeader !== null) {
    const decoded = decodeHeaderUtf8(comparedVersionCodeHeader);
    if (decoded.trim().length === 0) {
      opts.compared_version_code = null; // explicit clear
    } else {
      const parsed = parseVersionCodeInput(decoded);
      if (parsed !== null) opts.compared_version_code = parsed;
      // else: malformed header — leave opts.compared_version_code unset (drop).
    }
  }

  const companyHeader = req.headers.get("x-doc-company");
  if (companyHeader !== null) {
    opts.company = validateCompanyInput(decodeHeaderUtf8(companyHeader));
  }

  const docKindHeader = req.headers.get("x-doc-kind");
  if (docKindHeader !== null) {
    const decoded = decodeHeaderUtf8(docKindHeader).trim();
    if (decoded.length === 0) {
      opts.doc_kind = ""; // explicit clear signal (interpreted in core)
    } else if (isDocKind(decoded)) {
      opts.doc_kind = decoded;
      // else: unrecognized value — leave opts.doc_kind unset (drop).
    }
  }

  return opts;
}
