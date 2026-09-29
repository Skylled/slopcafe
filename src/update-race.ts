// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0
/**
 * The pure tail of `updateDocumentCore`'s race retry (issue #132): what an
 * update reports once every attempt lost its guarded batch. A leaf (no imports)
 * so `test/update-race.test.mjs` can drive it under the strip-types runner;
 * `document-write.ts` pulls in the WASM sanitizer and D1 and cannot load there.
 *
 * Every loss wrote nothing, so the outcome is always a clean, retryable error,
 * never a throw:
 *   - the document is gone (revoked or missing) → `not_found`;
 *   - otherwise → `version_conflict` (HTTP 412 `precondition_failed`, MCP
 *     `version_conflict`), whose contract is already "re-read and retry".
 *     `concurrent_change` is set when `current_ver` did NOT move, i.e. every
 *     loss was a slug/visibility race (an operator rename, a visibility flip, a
 *     contended new slug). "Current is vN, you sent vN" reads as nonsense, so
 *     the doors use it to say the document changed concurrently instead. The
 *     flag is internal: every door hand-picks `current_version`/`expected` onto
 *     the wire, so the error body's shape is unchanged.
 */

/**
 * How many times updateDocumentCore re-runs an attempt that lost a race. Each
 * attempt re-screens the body and re-puts both blobs, so this stays small: a
 * loss needs another write to commit inside one attempt's read→batch window.
 */
export const MAX_UPDATE_ATTEMPTS = 3;

export type ExhaustedRaceOutcome =
  | { ok: false; code: "not_found" }
  | {
      ok: false;
      code: "version_conflict";
      current_version: number;
      expected: number;
      concurrent_change: boolean;
    };

/**
 * @param now             the document as re-read after the last loss (null = no row)
 * @param expectedVersion the caller's pin (`If-Match: "vN"`), null for a clobber
 * @param base            the `current_ver` the last losing attempt read
 */
export function exhaustedRaceOutcome(
  now: { current_ver: number | null; revoked_at: string | null } | null,
  expectedVersion: number | null,
  base: number,
): ExhaustedRaceOutcome {
  if (!now || now.revoked_at !== null || now.current_ver === null) {
    return { ok: false, code: "not_found" };
  }
  const expected = expectedVersion ?? base;
  return {
    ok: false,
    code: "version_conflict",
    current_version: now.current_ver,
    expected,
    concurrent_change: now.current_ver === expected,
  };
}
