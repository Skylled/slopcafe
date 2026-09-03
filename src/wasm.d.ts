// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

// Type shims for wrangler's bundling rules: the Rust→WASM sanitizer in
// /sanitizer/pkg (the CompiledWasm rule) and the Text-imported MCP Apps
// template (src/mcp-app-template.html). wasm-pack was run with
// --no-typescript to keep the output lean; this file replaces the .d.ts it
// would otherwise have generated.

declare module "*.wasm" {
  const wasmModule: WebAssembly.Module;
  export default wasmModule;
}

// The `[[rules]] type = "Text"` twin of the CompiledWasm shim above: wrangler
// bundles *.html imports as strings (used by src/mcp.ts for the MCP Apps
// document-viewer template, and by the generated platform-doc bundle).
declare module "*.html" {
  const text: string;
  export default text;
}

// Same Text rule, for the Markdown half of the generated platform-doc bundle
// (src/generated/docs/<name>.md — see scripts/build-docs.mjs). Bundling the
// corpus as string imports rather than one JSON blob keeps it off the
// cold-start JSON.parse path: V8 handles module string literals lazily.
declare module "*.md" {
  const text: string;
  export default text;
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
  /** Max node-nesting depth of a sanitized HTML string, measured iteratively
   *  (stack-safe). Used by the write path to reject depth-bombs (issue #41). */
  export function max_dom_depth(html: string): number;
}
