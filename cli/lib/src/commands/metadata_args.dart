// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

import 'package:args/args.dart';

import '../client.dart';

/// Register the optional document-metadata flags shared by `publish` and
/// `update`. Mirrors the backend's `X-Doc-*` headers.
void addMetadataFlags(ArgParser p) {
  p
    ..addOption('title', help: 'Document title (X-Doc-Title). '
        'Pass "" to clear / re-derive from the content H1.')
    ..addOption('description',
        help: 'Short description (X-Doc-Description). Pass "" to clear.')
    ..addOption('tags',
        help: 'Comma-separated tags (X-Doc-Tags). Pass "" to clear.')
    ..addOption('slug',
        help: 'Unique handle (X-Doc-Slug). Pass "" to drop the slug.');
}

/// Parse the metadata flags into a [DocMetadata]. A flag that was **not passed**
/// stays `null` (omitted → publish: unset, update: inherit); a flag passed as
/// `""` becomes an explicit empty value (clear); `--tags` splits on commas.
DocMetadata parseMetadata(ArgResults r) {
  List<String>? tags;
  if (r.wasParsed('tags')) {
    final raw = (r['tags'] as String?) ?? '';
    tags = raw
        .split(',')
        .map((t) => t.trim())
        .where((t) => t.isNotEmpty)
        .toList();
  }
  return DocMetadata(
    title: r['title'] as String?,
    description: r['description'] as String?,
    tags: tags,
    slug: r['slug'] as String?,
  );
}
