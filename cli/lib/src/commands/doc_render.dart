// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

import '../../api/api.dart';

/// A bracketed `[private, deprecated, revoked]` suffix for a listing row, or
/// `''` when the document is a plain live public active doc. Shared so `list`,
/// `search`, and `find` flag rows identically.
String statusFlags({
  required String visibility,
  required String status,
  required bool revoked,
  String? supersededBy,
}) {
  final flags = <String>[];
  if (revoked) flags.add('revoked');
  if (visibility == 'private') flags.add('private');
  if (status != 'active') {
    flags.add(supersededBy != null ? '$status→$supersededBy' : status);
  }
  return flags.isEmpty ? '' : '  [${flags.join(', ')}]';
}

/// One human-readable line for a [DocumentListing] row: id, version, title,
/// optional slug, and status flags.
String listingLine(DocumentListing d) {
  final ver = d.currentVer != null ? 'v${d.currentVer}' : '—';
  final slug = (d.slug != null && d.slug!.isNotEmpty) ? '  /s/${d.slug}' : '';
  final flags = statusFlags(
    visibility: d.visibility,
    status: d.status,
    revoked: d.isRevoked,
    supersededBy: d.supersededBy,
  );
  return '${d.publicId}  $ver  ${d.title ?? '(untitled)'}$slug$flags';
}

/// One human-readable block for a [SearchHit]: score + matched field on the
/// header line, the listing line, then the snippet indented beneath.
String hitBlock(SearchHit h) {
  final ver = h.currentVer != null ? 'v${h.currentVer}' : '—';
  final slug = (h.slug != null && h.slug!.isNotEmpty) ? '  /s/${h.slug}' : '';
  final flags = statusFlags(
    visibility: h.visibility,
    status: h.status,
    revoked: h.revokedAt != null,
    supersededBy: h.supersededBy,
  );
  final score = h.score.toStringAsFixed(4);
  final b = StringBuffer()
    ..writeln('${h.publicId}  $ver  ${h.title ?? '(untitled)'}$slug$flags')
    ..writeln('    ${h.matchedField} · score $score');
  if (h.snippet.isNotEmpty) b.writeln('    ${h.snippet.replaceAll('\n', ' ')}');
  return b.toString().trimRight();
}
