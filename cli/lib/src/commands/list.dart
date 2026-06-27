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
    final limit = _parseLimit(argResults!['limit'] as String?);

    final client = buildClient();
    try {
      final res = await client.listDocuments(
        slug: argResults!['slug'] as String?,
        tags: tags,
        status: argResults!['status'] as String?,
        limit: limit,
        cursor: argResults!['cursor'] as String?,
      );
      out.result(res.toJson(), () => _human(res));
      return ExitCodes.ok;
    } finally {
      client.close();
    }
  }

  int? _parseLimit(String? raw) {
    if (raw == null || raw.isEmpty) return null;
    final n = int.tryParse(raw);
    if (n == null) {
      throw CliException('--limit must be an integer', exitCode: ExitCodes.usage);
    }
    return n;
  }

  String _human(ListDocumentsResponse r) {
    if (r.documents.isEmpty) return '(no documents)';
    final b = StringBuffer();
    for (final d in r.documents) {
      b.writeln(listingLine(d));
    }
    b.write('${r.documents.length} document(s)');
    if (r.nextCursor != null) {
      b.write(' · more: --cursor ${r.nextCursor}');
    }
    return b.toString();
  }
}
