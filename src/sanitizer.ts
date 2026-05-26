/**
 * Sanitizer wrapper around the Rust→WASM Ammonia build in /sanitizer/pkg.
 *
 * The wasm-pack `--target web` glue normally fetches its .wasm via
 * `new URL('sanitizer_bg.wasm', import.meta.url)` — that path does not
 * exist on Workers. Instead we import the .wasm directly (wrangler treats
 * it as a `WebAssembly.Module`) and hand it to `initSync`, which is
 * synchronous and never touches `import.meta.url`.
 *
 * Init runs lazily on first use and is a no-op on subsequent calls, so
 * cold isolates pay the cost once and warm ones pay nothing.
 */

import sanitizerWasm from "../sanitizer/pkg/sanitizer_bg.wasm";
import { initSync, sanitize as wasmSanitize, sanitizer_version } from "../sanitizer/pkg/sanitizer.js";

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
