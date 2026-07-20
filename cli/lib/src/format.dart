// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/// The production origin. Every config resolution falls back to this.
const defaultBaseUrl = 'https://slopcafe.com';

/// The two write formats the backend accepts on `POST /d` / `PUT /d/:id`.
enum DocFormat {
  markdown('text/markdown'),
  html('text/html');

  const DocFormat(this.contentType);

  /// The request `Content-Type` for this format.
  final String contentType;

  /// Parse a user-facing `--format` value. Accepts the canonical names plus
  /// `md`. Returns null for anything else (the caller reports the usage error).
  static DocFormat? parse(String value) {
    switch (value.trim().toLowerCase()) {
      case 'markdown':
      case 'md':
        return DocFormat.markdown;
      case 'html':
      case 'htm':
        return DocFormat.html;
      default:
        return null;
    }
  }
}

/// The server's `public_id` shape: 22 URL-safe-base64 chars (`PUBLIC_ID_RE` in
/// src/serve.ts). A document identifier that matches this is treated as a
/// `public_id`; anything else is treated as a slug. Used to auto-detect
/// id-vs-slug on the read/update/links/edit commands so a single positional
/// accepts either. A value that ALSO parses as a slug is ambiguous — see
/// [isAmbiguousDocIdentifier].
final _publicIdRe = RegExp(r'^[A-Za-z0-9_-]{22}$');

bool looksLikePublicId(String value) => _publicIdRe.hasMatch(value);

/// The server's slug shape (`validateSlugInput` in the Worker): 1–64 chars of
/// lowercase `[a-z0-9_-]` with `[a-z0-9]` endpoints.
final _slugRe = RegExp(r'^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$');

bool looksLikeSlug(String value) => _slugRe.hasMatch(value);

/// True when [value] is BOTH a well-formed `public_id` and a well-formed slug —
/// i.e. exactly 22 lowercase `[a-z0-9_-]` chars (`zenyatta-shared-memory` is
/// one). Shape alone cannot classify such a value: the two charsets overlap, so
/// a 22-char slug is indistinguishable from a capability id. Callers resolve
/// the ambiguity by probing the live-slug namespace first (`resolveDocId`) and
/// falling back to the `public_id` reading on a miss — without that, a 22-char
/// slug misroutes to `/d/:id` and 404s no matter when its document was created
/// (the Zenyatta "stale /s/ 404" papercut).
bool isAmbiguousDocIdentifier(String value) =>
    looksLikePublicId(value) && looksLikeSlug(value);

const _markdownExts = {'.md', '.markdown', '.mdown', '.mkd', '.mdwn'};
const _htmlExts = {'.html', '.htm', '.xhtml'};

/// Infer the write format from a file path's extension. Returns null when the
/// extension is unknown (or there is none) — the caller must then require an
/// explicit `--format` (this is exactly the stdin case, where there is no
/// name to infer from).
DocFormat? inferFormat(String path) {
  final dot = path.lastIndexOf('.');
  if (dot < 0) return null;
  final ext = path.substring(dot).toLowerCase();
  if (_markdownExts.contains(ext)) return DocFormat.markdown;
  if (_htmlExts.contains(ext)) return DocFormat.html;
  return null;
}

/// Whether [value] is safe to send as an HTTP header value from Dart.
///
/// `dart:io`'s `HttpClient` validates header values and throws a
/// `FormatException` on **any** byte ≥ 0x80 (and on control characters), so —
/// unlike `curl` — a Dart process simply cannot put UTF-8 in an `X-Doc-*`
/// header. We detect that up front and fail with guidance instead of letting a
/// cryptic transport error surface. (Printable ASCII + space; no tab.)
bool isAsciiHeaderSafe(String value) =>
    !value.codeUnits.any((c) => c < 0x20 || c > 0x7e);

/// Parse a version integer out of an `ETag` header (or any of the lenient
/// spellings the backend itself accepts). Handles `"v3"`, `v3`, `W/"v3"`,
/// `"3"`, and `3`. Returns null when no version can be read.
int? parseVersionTag(String? etag) {
  if (etag == null) return null;
  final m = RegExp(r'v?(\d+)').firstMatch(etag.trim());
  if (m == null) return null;
  return int.tryParse(m.group(1)!);
}

/// Normalize a user-supplied `--if-match` value to the header the backend
/// wants. `*` passes through; a number or `v<n>`/`"v<n>"` becomes the
/// canonical strong tag `"v<n>"`. Returns null for an unparseable value (the
/// caller reports the usage error). `auto` is resolved by the caller (a
/// preflight) and never reaches here.
String? normalizeIfMatch(String value) {
  final v = value.trim();
  if (v == '*') return '*';
  final n = parseVersionTag(v);
  if (n == null) return null;
  return '"v$n"';
}
