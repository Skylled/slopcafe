// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

// Type shims for the Rust→WASM sanitizer in /sanitizer/pkg.
// wasm-pack was run with --no-typescript to keep the output lean; this
// file replaces the .d.ts it would otherwise have generated.

declare module "*.wasm" {
  const wasmModule: WebAssembly.Module;
  export default wasmModule;
}

// Wildcard pattern: TS resolves the relative path before matching module
// declarations, so a literal "../sanitizer/pkg/sanitizer.js" wouldn't bind.
declare module "*/pkg/sanitizer.js" {
  /** Synchronously instantiate the WASM module. Idempotent. */
  export function initSync(options: { module: WebAssembly.Module }): unknown;
  /** Sanitize HTML against the v1 allowlist. Call after `initSync`. */
  export function sanitize(html: string): string;
  /** Version tag for the active allowlist; the single source of truth for the
   *  sanitizer version (stamped on writes and surfaced by the health endpoint). */
  export function sanitizer_version(): string;
  /** Parse Markdown (CommonMark + GFM) to HTML. NOT a trust boundary — pipe through `sanitize`. */
  export function markdown_to_html(md: string): string;
  /** Version tag for the active Markdown-input parser configuration. */
  export function md_input_version(): string;
  /** Convert sanitized HTML to GFM Markdown. Call after `initSync`. */
  export function html_to_markdown(html: string): string;
  /** Version tag for the active text-conversion policy. */
  export function converter_version(): string;
}
