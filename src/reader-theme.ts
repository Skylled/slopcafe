// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

// Reading themes spliced ahead of Markdown-doc bytes by serve.ts's serveRaw
// and serveVersionRaw (GET /d/:id/raw and GET /d/:id/v/:n/raw). Pulled out of
// serve.ts into this dependency-free leaf module — same reasoning as
// conditional.ts / served-version.ts — so `readerThemePrefixForDocKind` can be
// unit-tested directly with the Node strip-types harness. serve.ts transitively
// imports the WASM-backed sanitizer (via core.ts), which Node's plain ESM
// loader cannot import outside the Workers runtime, so serve.ts itself is not
// importable from a `test/*.test.mjs` file; this module has zero imports and
// is.

/**
 * Reading themes injected into Markdown-sourced documents at serve time.
 *
 * A Markdown doc is stored as a bare sanitized HTML fragment with no author
 * styling — the Markdown→HTML parse emits plain `<h1>/<p>/<ul>/…`, and the
 * sanitizer would strip a `<style>` block (and `<link>`/external CSS is off the
 * allowlist) even if we tried to store one. So without this the page renders
 * with the browser's stark, full-width defaults. The theme therefore lives
 * HERE, in serving code the sanitizer never touches.
 *
 * TWO themes share this mechanism, chosen by `readerThemePrefixForDocKind`
 * (below) off the SERVED document's `doc_kind` (migration 0019, `documents`
 * table — versions don't carry their own kind, so the version-history path
 * reads it off the parent document too):
 *   - READER_THEME_CSS / READER_THEME_PREFIX — the prose default. Comfortable
 *     44rem measure, 17px/1.7. Used for every doc_kind EXCEPT the two below,
 *     including NULL (every non-Insight document on this fork).
 *   - DENSE_THEME_CSS / DENSE_THEME_PREFIX — for `doc_kind` `teardown` and
 *     `teardown-section`: long two-column key/text tables carrying very long
 *     unbreakable `code` spans (e.g.
 *     MSG_GMAIL_MANUAL_CHANGES_IN_SEARCH_RESULTS_IGNORED_NOTICE), for which
 *     the prose theme's narrow column is cramped and ribbon-like. Wider
 *     surface (~110rem, still bounded — header-table line lengths matter),
 *     smaller type, tables that wrap long keys instead of overflowing, and a
 *     sticky H2 so a long table's section context survives scrolling. See the
 *     DENSE_THEME_CSS comment for the differences in detail.
 * Both draw their palette from the single READER_THEME_VARS block just below,
 * so light/dark colors can't drift between the two themes.
 *
 * Why this is safe and needs no security change:
 *   - Both are fixed server-side constants. No document/user data is
 *     interpolated, and the document bytes always follow the closing
 *     `</style>`, so there is no CSS-injection surface.
 *   - They sit entirely inside RAW_CSP's existing `style-src 'unsafe-inline'`
 *     allowance (see serve.ts) — no CSP edit.
 *   - The dark theme is a pure `prefers-color-scheme` media query: no JS, which
 *     is exactly why it works inside the scriptless `<iframe sandbox>`.
 *   - Stored R2 bytes are untouched; the `/text` (Markdown) derivation and the
 *     FTS index read the stored bytes, never this served-with-prefix form.
 *
 * Selectors are low-specificity (bare element selectors + `:root` custom
 * properties), so any inline `style=` the author embedded via raw HTML in their
 * Markdown still wins. HTML-authored documents do NOT get either theme —
 * serveRaw passes those through byte-for-byte, because their author owns
 * presentation.
 *
 * The leading `<!doctype html>` flips the iframe out of quirks mode (a bare
 * fragment has no doctype) into standards mode. The reading column is the
 * implicit `<body>` (`max-width` + auto margins) with the page backdrop on
 * `<html>`, so no wrapper element is needed and the whole thing is a
 * prepend-only splice ahead of the streamed R2 bytes.
 */
const READER_THEME_VARS = `
:root{color-scheme:light dark;--bg:#f4f2ee;--surface:#fbfaf7;--text:#2c2a27;--muted:#6b655c;--heading:#1b1a17;--link:#3a6ea5;--link-hover:#2c5580;--rule:#e6e1d7;--code-bg:#efece4;--quote:#d8d2c6;--mark:#f6e6a8;--thead:#efece4}
@media (prefers-color-scheme:dark){:root{--bg:#1a1917;--surface:#201f1c;--text:#d8d4cd;--muted:#9a948a;--heading:#ededea;--link:#8ab4e8;--link-hover:#a9c8ef;--rule:#33302b;--code-bg:#2a2825;--quote:#3a3631;--mark:#5c4a1f;--thead:#262420}}
`;

/** Exported for the structural test — asserts on the CSS text without
 *  duplicating the palette values there. */
export const READER_THEME_CSS = `${READER_THEME_VARS}
*,*::before,*::after{box-sizing:border-box}
html{background:var(--bg);-webkit-text-size-adjust:100%}
body{max-width:44rem;margin:0 auto;padding:3.5rem 1.5rem 6rem;background:var(--surface);color:var(--text);font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;font-size:17px;line-height:1.7;min-height:100vh;overflow-wrap:break-word}
@media (max-width:34rem){body{padding:2rem 1.1rem 4rem;font-size:16px}}
h1,h2,h3,h4,h5,h6{color:var(--heading);line-height:1.25;font-weight:650;letter-spacing:-.01em;margin:2.4em 0 .8em}
h1{font-size:2rem;margin-top:0}
h2{font-size:1.45rem;padding-bottom:.3em;border-bottom:1px solid var(--rule)}
h3{font-size:1.2rem}h4{font-size:1.05rem}h5,h6{font-size:1rem}h6{color:var(--muted)}
p,ul,ol,dl,blockquote,table,pre,figure,hr{margin:0 0 1.15em}
a{color:var(--link);text-decoration:underline;text-underline-offset:2px;text-decoration-thickness:.07em}
a:hover{color:var(--link-hover);text-decoration-thickness:.14em}
strong,b{font-weight:650;color:var(--heading)}
ul,ol{padding-left:1.5em}
li{margin:.3em 0}
li::marker{color:var(--muted)}
li>ul,li>ol{margin:.3em 0}
dt{font-weight:650;color:var(--heading)}
dd{margin:0 0 .5em 1.2em;color:var(--muted)}
blockquote{padding:.2em 0 .2em 1.2em;border-left:3px solid var(--quote);color:var(--muted)}
blockquote>:last-child{margin-bottom:0}
code,kbd,samp{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace}
code{font-size:.9em;background:var(--code-bg);padding:.12em .38em;border-radius:4px}
pre{background:var(--code-bg);padding:1em 1.15em;border-radius:8px;overflow-x:auto;line-height:1.5}
pre code{background:none;padding:0;font-size:.86em}
kbd{font-size:.85em;background:var(--code-bg);border:1px solid var(--rule);border-bottom-width:2px;border-radius:4px;padding:.1em .4em}
hr{border:0;border-top:1px solid var(--rule);margin:2.4em 0}
table{border-collapse:collapse;width:100%;font-size:.95em}
th,td{border:1px solid var(--rule);padding:.5em .7em;text-align:left;vertical-align:top}
thead th{background:var(--thead)}
img,svg{max-width:100%;height:auto}
figure{text-align:center}
figcaption{color:var(--muted);font-size:.9em;margin-top:.5em}
mark{background:var(--mark);color:inherit;padding:.05em .2em;border-radius:3px}
del{color:var(--muted)}
sub,sup{font-size:.75em}
abbr[title]{text-decoration:underline dotted;cursor:help}
`;

/** Prepended to Markdown-doc bodies at serve time. See READER_THEME_CSS. */
export const READER_THEME_PREFIX = `<!doctype html>\n<style>${READER_THEME_CSS}</style>\n`;

/**
 * Data-dense reading theme for `doc_kind` `teardown` / `teardown-section` —
 * see the shared design comment above READER_THEME_VARS for the selection
 * mechanics. Same architecture as READER_THEME_CSS (serve-time prepend,
 * doctype-first, low-specificity selectors, light/dark off READER_THEME_VARS),
 * differing only where a wide, two-column, table-heavy document needs it to:
 *   - Wide-but-bounded surface: `body` max-width ~110rem (not unbounded — line
 *     lengths in the header table still matter) with the same auto margins,
 *     tighter padding than the prose theme.
 *   - Smaller data typography: ~14px/1.45 body, tables ~13px (`.95em` of the
 *     14px base) — reusing the prose theme's own em multipliers here is
 *     deliberate: nothing but `body`'s base font-size and padding actually
 *     changes below, and every other rule's `em`/`rem` spacing tightens
 *     automatically by inheriting that smaller base, which is why headings,
 *     lists, blockquote, hr, etc. are byte-for-byte the same rules as the
 *     prose theme ("inherits sensible defaults from the same variable set").
 *   - Tables: explicit `table-layout:auto` (the initial value, stated for
 *     intent) with `word-break:break-word` added to `th,td` so a long
 *     unbreakable key (e.g. MSG_GMAIL_MANUAL_CHANGES_IN_SEARCH_RESULTS_
 *     IGNORED_NOTICE) wraps instead of forcing overflow, and
 *     `white-space:pre-wrap` on `code` spans INSIDE a cell so a multi-word
 *     string value wraps naturally too. Border/thead treatment is unchanged.
 *     No extra horizontal-scroll/overflow rule on `table` itself: it was
 *     considered (a "last resort" per the design brief) but `word-break`
 *     already resolves the one concrete failure mode this theme exists for,
 *     and the common CSS-only trick for it (`table{display:block}`) risks
 *     stripping the table's implicit ARIA semantics in some browser/AT
 *     combinations — a worse trade than a hypothetical residual overflow this
 *     repo has no live browser harness to even confirm still occurs.
 *   - H2 section headers: `position:sticky;top:0` with the theme's own
 *     `--surface` background (so scrolled-under table rows don't show through)
 *     and a `z-index`, keeping the same bottom-rule look. VERDICT: kept. The
 *     iframe at `/d/:id/raw` loads this document via `src` (a real navigation,
 *     not `srcdoc`), so it is a full, ordinary in-iframe document with its own
 *     scrolling viewport — sticky positioning resolves against that viewport
 *     exactly as on a normal top-level page. The `<iframe sandbox>` token list
 *     (see serve.ts's SANDBOX constant: `allow-popups
 *     allow-popups-to-escape-sandbox` — no `allow-scripts`) restricts script
 *     execution, form submission, and top-level navigation; it does not gate
 *     CSS positioning, which is inert w.r.t. the sandbox. This reasoning is NOT
 *     substituted for a live check — this environment has no headless browser
 *     to load the sandboxed iframe and scroll it — so if a future pass DOES get
 *     to test it for real and finds sticky misbehaving, drop `position:sticky`
 *     from this rule and update this comment; nothing else here depends on it.
 *   - Code spans: same chip look, slightly smaller (`.85em` / tighter padding
 *     vs. the prose theme's `.9em`).
 */
export const DENSE_THEME_CSS = `${READER_THEME_VARS}
*,*::before,*::after{box-sizing:border-box}
html{background:var(--bg);-webkit-text-size-adjust:100%}
body{max-width:110rem;margin:0 auto;padding:2rem 1.5rem 4rem;background:var(--surface);color:var(--text);font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.45;min-height:100vh;overflow-wrap:break-word}
@media (max-width:34rem){body{padding:1.25rem 1rem 3rem;font-size:13px}}
h1,h2,h3,h4,h5,h6{color:var(--heading);line-height:1.25;font-weight:650;letter-spacing:-.01em;margin:2.4em 0 .8em}
h1{font-size:2rem;margin-top:0}
h2{font-size:1.45rem;padding:.4em 0 .3em;border-bottom:1px solid var(--rule);position:sticky;top:0;background:var(--surface);z-index:1}
h3{font-size:1.2rem}h4{font-size:1.05rem}h5,h6{font-size:1rem}h6{color:var(--muted)}
p,ul,ol,dl,blockquote,table,pre,figure,hr{margin:0 0 1.15em}
a{color:var(--link);text-decoration:underline;text-underline-offset:2px;text-decoration-thickness:.07em}
a:hover{color:var(--link-hover);text-decoration-thickness:.14em}
strong,b{font-weight:650;color:var(--heading)}
ul,ol{padding-left:1.5em}
li{margin:.3em 0}
li::marker{color:var(--muted)}
li>ul,li>ol{margin:.3em 0}
dt{font-weight:650;color:var(--heading)}
dd{margin:0 0 .5em 1.2em;color:var(--muted)}
blockquote{padding:.2em 0 .2em 1.2em;border-left:3px solid var(--quote);color:var(--muted)}
blockquote>:last-child{margin-bottom:0}
code,kbd,samp{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace}
code{font-size:.85em;background:var(--code-bg);padding:.1em .34em;border-radius:4px}
pre{background:var(--code-bg);padding:1em 1.15em;border-radius:8px;overflow-x:auto;line-height:1.5}
pre code{background:none;padding:0;font-size:.86em}
kbd{font-size:.85em;background:var(--code-bg);border:1px solid var(--rule);border-bottom-width:2px;border-radius:4px;padding:.1em .4em}
hr{border:0;border-top:1px solid var(--rule);margin:2.4em 0}
table{border-collapse:collapse;width:100%;table-layout:auto;font-size:.95em}
th,td{border:1px solid var(--rule);padding:.5em .7em;text-align:left;vertical-align:top;word-break:break-word}
thead th{background:var(--thead)}
td code,th code{white-space:pre-wrap}
img,svg{max-width:100%;height:auto}
figure{text-align:center}
figcaption{color:var(--muted);font-size:.9em;margin-top:.5em}
mark{background:var(--mark);color:inherit;padding:.05em .2em;border-radius:3px}
del{color:var(--muted)}
sub,sup{font-size:.75em}
abbr[title]{text-decoration:underline dotted;cursor:help}
`;

/** Prepended to `teardown`/`teardown-section` Markdown-doc bodies at serve
 *  time. See the DENSE_THEME_CSS comment. */
export const DENSE_THEME_PREFIX = `<!doctype html>\n<style>${DENSE_THEME_CSS}</style>\n`;

/** `doc_kind` values (migration 0019) that get DENSE_THEME_PREFIX instead of
 *  the prose READER_THEME_PREFIX. Kept as literals rather than importing
 *  DocKind from metadata.ts — only these two of the seven values matter here,
 *  and a D1 row's `doc_kind` is untyped TEXT anyway (see serve.ts's callers'
 *  row types), so an unrecognized or NULL value falls through to the prose
 *  theme by construction rather than by an exhaustiveness check. */
const DENSE_DOC_KINDS = new Set(["teardown", "teardown-section"]);

/**
 * Which reader-theme prefix to splice ahead of a Markdown document's bytes,
 * keyed on the SERVED document's `doc_kind`. Exported so both serve.ts's
 * `serveRaw` and `serveVersionRaw` make the same call from one place — the
 * latter reads `doc_kind` off the parent `documents` row even though it is
 * rendering a specific historical VERSION, because `doc_kind` is
 * document-level (versions don't carry their own kind; see migration 0019 and
 * DESIGN.md Decision 9).
 */
export function readerThemePrefixForDocKind(docKind: string | null): string {
  return docKind !== null && DENSE_DOC_KINDS.has(docKind) ? DENSE_THEME_PREFIX : READER_THEME_PREFIX;
}
