/**
 * Wrapper around the Rust→WASM build in /sanitizer/pkg. Exposes the six
 * functions the crate exports:
 *
 *   - `sanitize(html)`           — write-time allowlist enforcement
 *   - `sanitizerVersion()`       — id of the active allowlist
 *   - `markdownToHtml(md)`       — write-time Markdown→HTML parser (GFM).
 *                                  NOT a trust boundary — caller must run
 *                                  `sanitize()` on the result before storing.
 *   - `mdInputVersion()`         — id of the active MD-input pipeline
 *   - `htmlToMarkdown(html)`     — read-time HTML→Markdown for agent context
 *   - `converterVersion()`       — id of the active text-conversion policy
 *
 * The wasm-pack `--target web` glue normally fetches its .wasm via
 * `new URL('sanitizer_bg.wasm', import.meta.url)` — that path does not
 * exist on Workers. Instead we import the .wasm directly (wrangler treats
 * it as a `WebAssembly.Module`) and hand it to `initSync`, which is
 * synchronous and never touches `import.meta.url`.
 *
 * Init runs lazily on first use and is a no-op on subsequent calls, so
 * cold isolates pay the cost once and warm ones pay nothing. Both the
 * write path and the read path share the same module load.
 *
 * The Rust side is exercised by the corpus tests at the bottom of
 * sanitizer/src/lib.rs and sanitizer/src/markdown.rs (`npm test`). This
 * JS wrapper (and the wasm-bindgen glue beneath it) doesn't have its
 * own coverage yet — see action-plan-v1.md "Follow-ups" for the deferred
 * Vitest + Miniflare layer.
 */

import sanitizerWasm from "../sanitizer/pkg/sanitizer_bg.wasm";
import {
  converter_version,
  html_to_markdown,
  initSync,
  markdown_to_html,
  md_input_version,
  sanitize as wasmSanitize,
  sanitizer_version,
} from "../sanitizer/pkg/sanitizer.js";

let initialized = false;

function ensureReady(): void {
  if (initialized) return;
  initSync({ module: sanitizerWasm });
  initialized = true;
}

/** Sanitize `html` against the v1 allowlist. Throws if the WASM is broken. */
export function sanitize(html: string): string {
  ensureReady();
  return wasmSanitize(html);
}

/** Identifier of the active allowlist; written to `versions.sanitizer_v`. */
export function sanitizerVersion(): string {
  ensureReady();
  return sanitizer_version();
}

/**
 * Parse Markdown input into HTML (CommonMark + GFM: tables, strikethrough,
 * task lists, footnotes). The result is unsanitized — callers MUST pipe it
 * through `sanitize()` before storing. Raw HTML in the Markdown source
 * passes through untouched here; the sanitizer is the trust boundary.
 *
 * Stored as `versions.source_format = 'markdown'` so the admin/list views
 * can tell how a version was authored. The Markdown source itself IS now
 * retained per version alongside the sanitized HTML (the (S, H) pair —
 * source-retention Case A; the earlier convert-and-discard model is
 * reversed). Because S is kept, `markdownToHtml` runs not only at the
 * one-shot publish but also as the re-render step on `edit_document`:
 * `editDocumentCore` patches the retained Markdown source, then re-renders it
 * here and re-sanitizes into the new (S, H) pair.
 */
export function markdownToHtml(md: string): string {
  ensureReady();
  return markdown_to_html(md);
}

/** Identifier of the active Markdown-input parser configuration. */
export function mdInputVersion(): string {
  ensureReady();
  return md_input_version();
}

/**
 * Convert sanitized HTML to GFM Markdown for agent context windows.
 *
 * Callers MUST pass already-sanitized bytes — never raw agent input. The
 * text path reflects exactly what the renderer would show, and anything
 * the sanitizer stripped is excluded from the text view by construction.
 * (See sanitizer/src/markdown.rs for the emitter; src/core.ts is the only
 * production caller and it passes bytes pulled from R2.)
 */
export function htmlToMarkdown(html: string): string {
  ensureReady();
  return html_to_markdown(html);
}

/** Identifier of the active text-conversion policy; stamped on read responses. */
export function converterVersion(): string {
  ensureReady();
  return converter_version();
}
