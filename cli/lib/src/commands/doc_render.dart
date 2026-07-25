// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

import '../../api/api.dart';

/// A bracketed `[private, deprecated, revoked]` suffix for a listing row, or
/// `''` when the document is a plain live public active doc. Shared so `list`,
/// `search`, and `find` flag rows identically.
///
/// [publishedVer]/[currentVer] add a `readers see vN` flag: on a PUBLIC
/// document those two differ exactly when an agent has written something no
/// operator has published, and the document's URL therefore serves older bytes
/// than the corpus holds. This is the one place the state is always knowable
/// for free — every listing row carries both numbers — whereas a write can only
/// report it when its own preflight happened to prove it.
///
/// Silent on a private document however the numbers look: nothing anonymous can
/// read it, so `published_ver` has no effect there and flagging it would be
/// noise on the common case.
String statusFlags({
  required String visibility,
  required String status,
  required bool revoked,
  String? supersededBy,
  int? publishedVer,
  int? currentVer,
}) {
  final flags = <String>[];
  if (revoked) flags.add('revoked');
  if (visibility == 'private') flags.add('private');
  if (!revoked &&
      visibility == 'public' &&
      publishedVer != null &&
      currentVer != null &&
      publishedVer != currentVer) {
    flags.add('readers see v$publishedVer');
  }
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
    publishedVer: d.publishedVer,
    currentVer: d.currentVer,
  );
  return '${d.publicId}  $ver  ${d.title ?? '(untitled)'}$slug$flags';
}

/// A [PackResponse] as **one markdown stream**: the root's own prose first (the
/// manifest page explains why these members are here), then each member under a
/// `---` separator with an HTML-comment provenance header.
///
/// Shared by both pack roots — the document/manifest root (`slopcafe pack`) and
/// the query root (`slopcafe search --include-bodies`) — so a boot prompt sees
/// identical bytes whichever way the pack was assembled. A query-rooted pack has
/// no `root`, so it starts straight at the first member.
String packContent(PackResponse r) {
  final b = StringBuffer();
  final root = r.pack.root;
  if (root != null) {
    b
      ..writeln('<!-- pack root: ${root.slug ?? root.publicId} -->')
      ..writeln(root.content.trimRight())
      ..writeln();
  }
  for (final d in r.documents) {
    final name = d.slug ?? d.publicId;
    b
      ..writeln('---')
      ..writeln()
      ..writeln('<!-- pack member: $name (${d.publicId}) v${d.version}'
          '${d.title != null ? ' — ${d.title}' : ''} -->')
      ..writeln(d.content.trimRight())
      ..writeln();
  }
  return b.toString();
}

/// How many omitted members get their own stderr line before the rest are
/// summarised. A *document*-rooted pack omits at most a manifest's worth, but a
/// *query*-rooted one (`search --include-bodies`) omits every hit past the
/// knobs — up to `--limit` (default 50) rows — and 40 near-identical
/// "omitted (max_documents)" lines bury the accounting line above them. The
/// full list is never lost: it is the `omitted[]` array under `--json`.
const _maxListedOmissions = 10;

/// The pack's accounting line plus the omitted-members menu, as note lines for
/// **stderr** — the content stream on stdout must stay ingestible markdown.
/// Returned rather than printed so both pack commands share the wording while
/// each owns its own [Output].
List<String> packNotes(PackResponse r) {
  final p = r.pack;
  // A document/manifest pack names its root; a query pack names the query.
  final origin = p.root != null
      ? ' of ${p.root!.slug ?? p.root!.publicId}'
      : (p.query != null ? ' for "${p.query}"' : '');
  final notes = <String>[
    'pack (${p.source})$origin: ${r.documents.length} member bodies included, '
        '${p.usedBytes}/${p.budgetBytes} budget bytes used',
  ];
  for (final o in r.omitted.take(_maxListedOmissions)) {
    final extra = [
      if (o.supersededBy != null) 'superseded by ${o.supersededBy}',
      if (o.hint != null) o.hint!,
    ].join('; ');
    notes.add('omitted (${o.reason}): ${o.title ?? o.ref}'
        '${o.publicId != null ? ' [${o.publicId}]' : ''}'
        '${extra.isNotEmpty ? ' — $extra' : ''}');
  }
  final rest = r.omitted.length - _maxListedOmissions;
  if (rest > 0) {
    notes.add('…and $rest more omitted — run with --json for the full list');
  }
  if (r.omitted.isNotEmpty) {
    notes.add('fetch an omitted member with `slopcafe read <id>`, or raise '
        '--budget/--max-docs');
  }
  return notes;
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
    publishedVer: h.publishedVer,
    currentVer: h.currentVer,
  );
  final score = h.score.toStringAsFixed(4);
  final b = StringBuffer()
    ..writeln('${h.publicId}  $ver  ${h.title ?? '(untitled)'}$slug$flags')
    ..writeln('    ${h.matchedField} · score $score');
  if (h.snippet.isNotEmpty) b.writeln('    ${h.snippet.replaceAll('\n', ' ')}');
  return b.toString().trimRight();
}
