// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/**
 * Translate D1 / SQLite concurrency constraint errors into structured domain
 * error codes (QL-808 / M3).
 *
 * Cloudflare D1 does not expose structured SQLite error codes on thrown
 * exceptions — it surfaces them as `Error` messages (sometimes wrapped with a
 * `.cause`), e.g.:
 *   - `D1_ERROR: UNIQUE constraint failed: versions.document_id, versions.version_no: SQLITE_CONSTRAINT`
 *   - `D1_ERROR: UNIQUE constraint failed: documents.slug: SQLITE_CONSTRAINT`
 *   - `PRIMARY KEY constraint failed: versions.document_id, versions.version_no`
 *
 * Pure leaf module so all error-shape variations are unit-testable in Node.
 */

function collectErrorText(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;
  for (let depth = 0; depth < 4 && cur !== undefined && cur !== null; depth++) {
    if (cur instanceof Error) {
      if (cur.message) parts.push(cur.message);
      cur = (cur as { cause?: unknown }).cause;
    } else if (typeof cur === "string") {
      parts.push(cur);
      break;
    } else if (typeof cur === "object" && "message" in cur && typeof (cur as { message: unknown }).message === "string") {
      parts.push((cur as { message: string }).message);
      cur = (cur as { cause?: unknown }).cause;
    } else {
      parts.push(String(cur));
      break;
    }
  }
  return parts.join(" | ");
}

/**
 * True when `err` is a D1/SQLite uniqueness or primary-key violation on
 * `versions(document_id, version_no)` — the signature of two concurrent
 * `updateDocumentCore` writers computing the same `nextVer = current_ver + 1`.
 */
export function isVersionsPkConstraintError(err: unknown): boolean {
  const text = collectErrorText(err);
  if (!/(?:unique|primary key) constraint failed/i.test(text)) return false;
  return (
    /versions\.document_id/i.test(text) ||
    /versions\.version_no/i.test(text)
  );
}

/**
 * True when `err` is a D1/SQLite uniqueness violation on `documents.slug`
 * (migration 0005 partial unique index) — the signature of two concurrent
 * writers claiming the same live slug after passing the pre-check SELECT.
 */
export function isSlugUniqueConstraintError(err: unknown): boolean {
  const text = collectErrorText(err);
  if (!/unique constraint failed/i.test(text)) return false;
  return /documents\.slug\b/i.test(text) || /documents_slug/i.test(text);
}
