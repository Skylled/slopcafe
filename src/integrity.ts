// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/**
 * Optional content-integrity handshake for the HTTP write path.
 *
 * The byte-exact publish story (POST /d with `curl --data-binary @file`)
 * streams a file from disk straight to the Worker without a model
 * regenerating it token-by-token. That removes the regeneration cost and
 * fidelity risk, but introduces a different one: a silent *transport*
 * truncation — a dropped connection, a proxy buffer limit, or a half-read
 * file leaving a partial body that still parses as valid HTML and publishes
 * "successfully." This handshake turns that into a loud 422 instead of a
 * quietly-wrong publish.
 *
 * The client computes a SHA-256 of the exact bytes it intends to send (e.g.
 * `sha256sum file.html`) and passes it as `X-Content-SHA256`. The server
 * hashes the bytes it actually received — BEFORE sanitization — and rejects
 * on mismatch. Pre-sanitization is deliberate: this verifies the wire ("the
 * bytes I sent arrived intact"), not the sanitizer's transformation. The
 * `modified` / `size_bytes` fields on the write response continue to describe
 * the post-sanitize result; integrity is a separate, earlier gate.
 *
 * Byte-length is intentionally subsumed by the hash — a truncated or
 * placeholder-injected body produces a different digest — so the public
 * surface is a single header.
 *
 * HTTP-only by design: the value comes from the hash being produced by the
 * same deterministic tool (the shell) that streams the file. A model cannot
 * reliably hash 85 KB of content it is emitting as a tool argument, so there
 * is no coherent MCP equivalent. An MCP agent that has a shell should use the
 * curl path; one that doesn't can't benefit.
 */

/** A SHA-256 hex digest: exactly 64 lowercase hex characters. */
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/** SHA-256 of `bytes` as lowercase hex. Uses Web Crypto (global in Workers). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Normalize the raw `X-Content-SHA256` header value into a canonical hex
 * digest, or signal that no check was requested / the value is malformed.
 *
 *   - null (header absent)        → { ok: true, value: null }  (no check)
 *   - valid digest                → { ok: true, value: <64-hex> }
 *   - anything else               → { ok: false }              (caller 400s)
 *
 * Accepts an optional `sha256:` prefix (some tools emit it) and is
 * case-insensitive on input, but stores/compares lowercase. Surrounding
 * whitespace is trimmed.
 */
export function normalizeExpectedSha256(
  raw: string | null,
): { ok: true; value: string | null } | { ok: false } {
  if (raw === null) return { ok: true, value: null };
  let v = raw.trim().toLowerCase();
  if (v.startsWith("sha256:")) v = v.slice("sha256:".length).trim();
  if (!SHA256_HEX_RE.test(v)) return { ok: false };
  return { ok: true, value: v };
}

export type IntegrityVerdict =
  | { ok: true }
  | { ok: false; expected: string; actual: string; received_bytes: number };

/**
 * Verify the received bytes against an expected SHA-256. A null expectation
 * is a no-op pass (the handshake is opt-in). On mismatch the verdict carries
 * both digests and the received byte count so the caller can build an
 * actionable error.
 */
export async function verifyContentIntegrity(
  bytes: Uint8Array,
  expectedSha256: string | null,
): Promise<IntegrityVerdict> {
  if (expectedSha256 === null) return { ok: true };
  const actual = await sha256Hex(bytes);
  if (actual === expectedSha256) return { ok: true };
  return { ok: false, expected: expectedSha256, actual, received_bytes: bytes.byteLength };
}
