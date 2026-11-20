// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/**
 * Bounded request-body reader (QL-808 / Q5).
 *
 * Prevents an oversized upload (with or without a `Content-Length` header, or
 * with a spoofed/understated `Content-Length`) from being buffered in full by
 * `req.arrayBuffer()` / `req.text()` and OOMing a 128 MiB Worker isolate before
 * the byte-cap guard can return `413 too_large`.
 *
 * Pure Web Fetch API (`Request` / `ReadableStream`) so it is unit-testable in
 * Node with zero Workers runtime dependencies.
 */

export type BoundedBodyResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; code: "too_large"; limit: number };

/**
 * Read `req`'s raw bytes up to `maxBytes`, returning `too_large` immediately if
 * `Content-Length` exceeds `maxBytes` or as soon as streamed chunks cross the
 * ceiling (canceling the stream before allocating more memory).
 */
export async function readBodyWithLimit(
  req: Request,
  maxBytes: number,
): Promise<BoundedBodyResult> {
  // Fast path: reject declared oversize payloads before touching the body stream.
  const clHeader = req.headers.get("content-length");
  if (clHeader !== null) {
    const trimmed = clHeader.trim();
    if (/^\d+$/.test(trimmed)) {
      const declared = Number(trimmed);
      if (Number.isFinite(declared) && declared > maxBytes) {
        return { ok: false, code: "too_large", limit: maxBytes };
      }
    }
  }

  if (!req.body) {
    return { ok: true, bytes: new Uint8Array(0) };
  }

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {
          /* best effort */
        });
        return { ok: false, code: "too_large", limit: maxBytes };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  if (chunks.length === 0) return { ok: true, bytes: new Uint8Array(0) };
  if (chunks.length === 1) return { ok: true, bytes: chunks[0]! };

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes: out };
}
