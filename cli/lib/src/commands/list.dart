// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

import '../../api/api.dart';
import '../command_base.dart';
import '../errors.dart';
import 'doc_render.dart';

/// `slopcafe list [filters]` — `GET /d`, the HTTP twin of MCP `list_documents`.
/// Newest-first, cursor-paginated; `--slug` is the slug → public_id resolver.
class ListCommand extends SlopcafeCommand {
  ListCommand() {
    argParser
      ..addOption('slug',
          help: 'Filter to the document with this exact slug (0 or 1 row) — '
              'the slug → public_id lookup.')
      ..addOption('tag',
          help: 'AND-filter by tag. Comma-separated for multiple (all must match).')
      ..addOption('status',
          allowed: ['active', 'deprecated'],
          help: 'Lifecycle filter (omit to include everything).')
      ..addOption('order',
          allowed: ['created', 'updated'],
          help: 'created (default) walks publication time; updated walks last '
              'CHANGE — including retags, renames and revokes, which write no '
              'version. Pass the same --order back with --cursor.')
      ..addOption('since',
          valueHelp: 'ISO-8601',
          help: 'Only documents changed at or after this instant (inclusive). '
              'Implies the updated ordering unless --order says otherwise.')
      ..addOption('limit', help: 'Page size, 1–200 (default 50).')
      ..addOption('cursor',
          help: 'Opaque pagination cursor from a prior response\'s next_cursor.');
  }

  @override
  String get name => 'list';

  @override
  String get description =>
      'List documents, newest first (GET /d). Includes revoked, with filters.';

  @override
  String get invocation =>
      'slopcafe list [--slug s] [--tag t] [--status active|deprecated] [--limit n] [--cursor c]';

  @override
  Future<int> run() async {
    final tagRaw = argResults!['tag'] as String?;
    final tags =
        tagRaw?.split(',').map((t) => t.trim()).where((t) => t.isNotEmpty).toList();
    final limit = intOption('limit');

    // `--since` without `--order` means the updated ordering: asking "what
    // changed since X" while walking publication time would window the rows
    // without reordering them, which reads as an arbitrary slice of the feed.
    final since = (argResults!['since'] as String?)?.trim();
    final explicitOrder = argResults!['order'] as String?;
    final order = explicitOrder ??
        ((since != null && since.isNotEmpty) ? 'updated' : null);

    final client = buildClient();
    try {
      final res = await client.listDocuments(
        slug: argResults!['slug'] as String?,
        tags: tags,
        status: argResults!['status'] as String?,
        limit: limit,
        cursor: argResults!['cursor'] as String?,
        order: order,
        updatedSince: since,
      );
      out.result(res.toJson(), () => _human(res, order));
      return ExitCodes.ok;
    } finally {
      client.close();
    }
  }

  String _human(ListDocumentsResponse r, String? order) {
    if (r.documents.isEmpty) return '(no documents)';
    final b = StringBuffer();
    for (final d in r.documents) {
      b.writeln(listingLine(d));
    }
    b.write('${r.documents.length} document(s)');
    if (r.nextCursor != null) {
      // Echo --order back into the continuation: a cursor minted under one
      // ordering is a hard `bad_cursor` under the other, so a copy-pasteable
      // command that dropped it would fail on the second page.
      final carry = order != null ? ' --order $order' : '';
      b.write(' · more: --cursor ${r.nextCursor}$carry');
    }
    return b.toString();
  }
}
