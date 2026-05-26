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
  /** Version tag for the active allowlist (matches SANITIZER_VERSION env). */
  export function sanitizer_version(): string;
}
