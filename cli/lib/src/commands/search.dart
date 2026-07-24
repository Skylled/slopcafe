// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

import 'dart:convert';

import '../../api/api.dart';
import '../command_base.dart';
import '../errors.dart';
import 'doc_render.dart';

/// `slopcafe search <query>` — `GET /d/search`, the HTTP twin of MCP
/// `search_documents`. Hybrid keyword+semantic by default; not paginated.
///
/// With `--include-bodies` it becomes the **query-rooted context pack**: the
/// same ranked search, amplified server-side into a budgeted bulk read that
/// returns whole bodies. That is the "brief me on TOPIC" call for an agent with
/// no known starting document — the counterpart to `slopcafe pack`, which needs
/// a root. Without it, an agent had to search, parse the hits, and issue N
/// `read`s, re-implementing client-side the budget/whole-or-omit logic the
/// server already does.
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
      ..addOption('limit', help: 'Max hits, 1–200 (default 50).')
      ..addFlag('include-bodies',
          negatable: false,
          help: 'Return a context pack: the whole bodies of the top hits, '
              'budget-filled in one call (never truncated).')
      ..addOption('budget',
          help: 'With --include-bodies: body budget in STORED bytes '
              '(default 65536 ≈ 16K tokens, min 1024, max 262144). Clamped by '
              'the server, not rejected.')
      ..addOption('max-docs',
          help: 'With --include-bodies: cap on included bodies (default 8, '
              'max 25). Clamped.')
      ..addFlag('include-deprecated',
          negatable: false,
          help: 'With --include-bodies: let deprecated hits join the fill '
              'instead of being omitted-and-reported.')
      // The two pack roots are peers, so they take the same output flag —
      // otherwise an agent that learned `pack <root> -o ctx.md` has to fall
      // back to shell redirection here, which also loses the path-confinement
      // guard `emitJson`/`emitBody` apply.
      ..addOption('output',
          abbr: 'o',
          help: 'With --include-bodies: write the pack to a file instead of '
              'stdout.');
  }

  @override
  String get name => 'search';

  @override
  String get description =>
      'Search documents by content (GET /d/search) — hybrid keyword + semantic.';

  @override
  String get invocation =>
      'slopcafe search <query…> [--mode hybrid|keyword|semantic] [--tag t] [--limit n] '
      '[--include-bodies [--budget bytes] [--max-docs n] [-o file]]';

  @override
  Future<int> run() async {
    final q = argResults!.rest.join(' ').trim();
    if (q.isEmpty) {
      throw CliException.usage('expected a search query');
    }
    final tagRaw = argResults!['tag'] as String?;
    final tags =
        tagRaw?.split(',').map((t) => t.trim()).where((t) => t.isNotEmpty).toList();
    final limit = intOption('limit');
    final mode = argResults!['mode'] as String?;
    final slug = argResults!['slug'] as String?;
    final status = argResults!['status'] as String?;

    final client = buildClient();
    try {
      // `--include-bodies` switches the 200 shape from {documents} to the
      // PackResponse envelope, so it takes the pack decode + the pack
      // renderers — the identical ones `slopcafe pack` uses, so both pack roots
      // print the same bytes.
      if (argResults!['include-bodies'] as bool) {
        final pack = await client.searchPack(
          q: q,
          mode: mode,
          tags: tags,
          slug: slug,
          status: status,
          limit: limit,
          budgetBytes: intOption('budget'),
          maxDocuments: intOption('max-docs'),
          includeDeprecated: argResults!['include-deprecated'] as bool,
        );
        final outPath = argResults!['output'] as String?;
        if (globals.json) {
          emitJson(pack.toJson(), outPath);
        } else {
          for (final n in packNotes(pack)) {
            out.note(n);
          }
          emitBody(utf8.encode(packContent(pack)), outPath);
        }
        return ExitCodes.ok;
      }

      final res = await client.search(
        q: q,
        mode: mode,
        tags: tags,
        slug: slug,
        status: status,
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
