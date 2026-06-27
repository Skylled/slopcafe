// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

import '../../api/api.dart';
import '../command_base.dart';
import '../errors.dart';
import 'doc_render.dart';

/// `slopcafe search <query>` — `GET /d/search`, the HTTP twin of MCP
/// `search_documents`. Hybrid keyword+semantic by default; not paginated.
class SearchCommand extends SlopcafeCommand {
  SearchCommand() {
    argParser
      ..addOption('mode',
          allowed: ['hybrid', 'keyword', 'semantic'],
          defaultsTo: 'hybrid',
          help: 'Ranking legs: hybrid (both, fused), keyword (FTS), semantic (vector).')
      ..addOption('tag',
          help: 'AND-filter by tag. Comma-separated for multiple.')
      ..addOption('slug', help: 'Restrict to this slug.')
      ..addOption('status',
          allowed: ['active', 'deprecated'],
          help: 'Lifecycle filter (omit to include everything).')
      ..addOption('limit', help: 'Max hits, 1–200 (default 50).');
  }

  @override
  String get name => 'search';

  @override
  String get description =>
      'Search documents by content (GET /d/search) — hybrid keyword + semantic.';

  @override
  String get invocation =>
      'slopcafe search <query…> [--mode hybrid|keyword|semantic] [--tag t] [--limit n]';

  @override
  Future<int> run() async {
    final q = argResults!.rest.join(' ').trim();
    if (q.isEmpty) {
      throw CliException('expected a search query', exitCode: ExitCodes.usage);
    }
    final tagRaw = argResults!['tag'] as String?;
    final tags =
        tagRaw?.split(',').map((t) => t.trim()).where((t) => t.isNotEmpty).toList();
    final limitRaw = argResults!['limit'] as String?;
    int? limit;
    if (limitRaw != null && limitRaw.isNotEmpty) {
      limit = int.tryParse(limitRaw);
      if (limit == null) {
        throw CliException('--limit must be an integer', exitCode: ExitCodes.usage);
      }
    }

    final client = buildClient();
    try {
      final res = await client.search(
        q: q,
        mode: argResults!['mode'] as String?,
        tags: tags,
        slug: argResults!['slug'] as String?,
        status: argResults!['status'] as String?,
        limit: limit,
      );
      out.result(res.toJson(), () => _human(res));
      return ExitCodes.ok;
    } finally {
      client.close();
    }
  }

  String _human(SearchDocumentsResponse r) {
    if (r.documents.isEmpty) return '(no matches)';
    final b = StringBuffer();
    for (final h in r.documents) {
      b.writeln(hitBlock(h));
    }
    b.write('${r.documents.length} hit(s)');
    return b.toString();
  }
}
