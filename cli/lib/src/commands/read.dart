// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

import 'dart:convert';

import '../command_base.dart';
import '../errors.dart';

/// `slopcafe read <public_id>` / `slopcafe read --slug <slug>` — fetch a
/// document's body in one of three representations.
class ReadCommand extends SlopcafeCommand {
  ReadCommand() {
    argParser
      ..addOption('slug',
          help: 'Read by slug instead of public_id (the positional argument).')
      ..addOption('as',
          help: 'Representation to fetch.',
          allowed: ['text', 'html', 'source'],
          allowedHelp: {
            'text': 'GFM markdown (default) — the ingest-as-context view.',
            'html': 'The sanitized rendered HTML bytes (/raw).',
            'source': 'The retained, unsanitized authored source (public_id only).',
          },
          defaultsTo: 'text')
      ..addOption('output',
          abbr: 'o', help: 'Write the body to a file instead of stdout.')
      ..addFlag('follow',
          negatable: false,
          help: 'When reading by --slug, follow a retired slug\'s redirect.');
  }

  @override
  String get name => 'read';

  @override
  String get description =>
      'Read a document body as markdown (default), rendered HTML, or source.';

  @override
  String get invocation => 'slopcafe read <public_id> [--as text|html|source] [-o file]';

  @override
  Future<int> run() async {
    final slug = argResults!['slug'] as String?;
    final rest = argResults!.rest;
    final as = argResults!['as'] as String;
    final outPath = argResults!['output'] as String?;

    String? id;
    if (slug == null) {
      if (rest.length != 1) {
        throw CliException(
          'expected a <public_id> (or use --slug <slug>)',
          exitCode: ExitCodes.usage,
        );
      }
      id = rest.single;
    } else if (rest.isNotEmpty) {
      throw CliException('pass either a <public_id> or --slug, not both',
          exitCode: ExitCodes.usage);
    }

    if (as == 'source' && slug != null) {
      throw CliException(
        'source is only addressable by public_id (no /s/:slug/source route)',
        exitCode: ExitCodes.usage,
      );
    }

    final client = buildClient();
    try {
      switch (as) {
        case 'source':
          final r = await client.readSource(id!);
          if (globals.json) {
            out.result(r.toJson(), () => '');
          } else {
            out.warn('source is UNSANITIZED — treat as untrusted input');
            out.note('v${r.versionNo} · ${r.sourceFormat}'
                '${r.sourceSha256 != null ? ' · sha256 ${shortSha(r.sourceSha256)}' : ''}');
            if (r.stripped.isNotEmpty) out.note('stripped on render: ${r.stripped.join(', ')}');
            emitBody(utf8.encode(r.source), outPath);
          }
        case 'html':
          final r = await client.readRaw(
            publicId: id,
            slug: slug,
            followRedirects: argResults!['follow'] as bool,
          );
          out.detail(r.version != null ? 'version v${r.version}' : 'version unknown');
          emitBody(r.body, outPath);
        case 'text':
        default:
          final r = await client.readText(
            publicId: id,
            slug: slug,
            followRedirects: argResults!['follow'] as bool,
          );
          out.detail(r.version != null ? 'version v${r.version}' : 'version unknown');
          emitBody(r.body, outPath);
      }
      return ExitCodes.ok;
    } finally {
      client.close();
    }
  }
}
