// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

import 'dart:convert';

import '../command_base.dart';
import '../errors.dart';
import 'doc_render.dart';

/// `slopcafe pack <slug-or-id>` — load a document/manifest-rooted context pack
/// (`GET /d/pack`, the HTTP twin of MCP `load_context_pack`): the root's own
/// prose plus the full markdown bodies of the documents it references,
/// budget-filled in one call.
///
/// stdout is the pack **content** (root prose, then each member under a
/// `---`-separated header) so `slopcafe pack pack-boot > context.md` — or a
/// boot prompt ingesting the stream directly — gets clean markdown; the
/// accounting (fill counts, budget use) and the omitted-members menu go to
/// stderr. `--json` swaps the content for the raw PackResponse envelope —
/// through the same `-o`-aware emit path, so the flag keeps working in both
/// modes.
class PackCommand extends SlopcafeCommand {
  PackCommand() {
    argParser
      ..addOption('budget',
          help: 'Body budget in STORED bytes (default 65536 ≈ 16K tokens, '
              'max 262144). Clamped by the server, not rejected.')
      ..addOption('max-docs',
          help: 'Cap on included member bodies (default 8, max 25). Clamped.')
      ..addFlag('include-deprecated',
          negatable: false,
          help: 'Include deprecated members in the fill instead of '
              'omitting-and-reporting them.')
      ..addFlag('follow',
          negatable: false,
          help: "Substitute a deprecated member's `superseded_by` replacement "
              'into the fill (the original stays visible in the omitted list).')
      ..addOption('output',
          abbr: 'o', help: 'Write the pack content to a file instead of stdout.');
  }

  @override
  String get name => 'pack';

  @override
  String get description =>
      "Load a context pack: a root document's prose plus the full bodies of "
      'the documents it references (manifest or links), in one call.';

  @override
  String get invocation =>
      'slopcafe pack <slug-or-id> [--budget bytes] [--max-docs n] [-o file]';

  @override
  Future<int> run() async {
    final rest = argResults!.rest;
    if (rest.length != 1) {
      throw CliException.usage('expected exactly one <slug-or-id> (the pack root)');
    }
    final budget = intOption('budget');
    final maxDocs = intOption('max-docs');
    final outPath = argResults!['output'] as String?;

    final client = buildClient();
    try {
      // `from` is resolved server-side (live slug first, then public_id) —
      // no client-side resolveDocId round-trip.
      final r = await client.loadPack(
        from: rest.single,
        budgetBytes: budget,
        maxDocuments: maxDocs,
        includeDeprecated: argResults!['include-deprecated'] as bool,
        followRedirects: argResults!['follow'] as bool,
      );

      // Both branches go through the `-o`-aware emit path. `out.result` would
      // have written the envelope to stdout and silently ignored `-o`, leaving
      // the caller's next step reading a file that was never created.
      if (globals.json) {
        emitJson(r.toJson(), outPath);
      } else {
        for (final n in packNotes(r)) {
          out.note(n);
        }
        emitBody(utf8.encode(packContent(r)), outPath);
      }
      return ExitCodes.ok;
    } finally {
      client.close();
    }
  }
}
