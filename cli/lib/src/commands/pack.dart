// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

import 'dart:convert';

import '../../api/api.dart';
import '../command_base.dart';
import '../errors.dart';

/// `slopcafe pack <slug-or-id>` — load a document/manifest-rooted context pack
/// (`GET /d/pack`, the HTTP twin of MCP `load_context_pack`): the root's own
/// prose plus the full markdown bodies of the documents it references,
/// budget-filled in one call.
///
/// stdout is the pack **content** (root prose, then each member under a
/// `---`-separated header) so `slopcafe pack pack-boot > context.md` — or a
/// boot prompt ingesting the stream directly — gets clean markdown; the
/// accounting (fill counts, budget use) and the omitted-members menu go to
/// stderr. `--json` swaps stdout for the raw PackResponse envelope.
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
      throw CliException(
        'expected exactly one <slug-or-id> (the pack root)',
        exitCode: ExitCodes.usage,
      );
    }
    final budget = _intOpt('budget');
    final maxDocs = _intOpt('max-docs');
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

      if (globals.json) {
        out.result(r.toJson(), () => '');
      } else {
        _notes(r);
        emitBody(utf8.encode(_content(r)), outPath);
      }
      return ExitCodes.ok;
    } finally {
      client.close();
    }
  }

  int? _intOpt(String name) {
    final raw = argResults![name] as String?;
    if (raw == null) return null;
    final n = int.tryParse(raw);
    if (n == null) {
      throw CliException('--$name must be an integer', exitCode: ExitCodes.usage);
    }
    return n;
  }

  /// The pack as one markdown stream: root prose first (the manifest page
  /// explains why these members), then each member under a separator header.
  String _content(PackResponse r) {
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

  /// Accounting + the omitted-members menu, on stderr (suppressed by --quiet).
  void _notes(PackResponse r) {
    final p = r.pack;
    final rootName = p.root == null ? '' : ' of ${p.root!.slug ?? p.root!.publicId}';
    out.note('pack (${p.source})$rootName: ${r.documents.length} member '
        'bodies included, ${p.usedBytes}/${p.budgetBytes} budget bytes used');
    for (final o in r.omitted) {
      final extra = [
        if (o.supersededBy != null) 'superseded by ${o.supersededBy}',
        if (o.hint != null) o.hint!,
      ].join('; ');
      out.note('omitted (${o.reason}): ${o.title ?? o.ref}'
          '${o.publicId != null ? ' [${o.publicId}]' : ''}'
          '${extra.isNotEmpty ? ' — $extra' : ''}');
    }
    if (r.omitted.isNotEmpty) {
      out.note('fetch an omitted member with `slopcafe read <id>`, or raise '
          '--budget/--max-docs');
    }
  }
}
