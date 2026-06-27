// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

import 'dart:convert';

import '../command_base.dart';
import '../errors.dart';
import '../format.dart';

/// `slopcafe read <id-or-slug>` / `slopcafe read --slug <slug>` — fetch a
/// document's body in one of three representations. The positional identifier
/// is auto-detected (a 22-char base64url string is a `public_id`, anything else
/// a slug); `--slug <value>` forces a slug.
class ReadCommand extends SlopcafeCommand {
  ReadCommand() {
    argParser
      ..addOption('slug',
          help: 'Read by slug (overrides the positional; forces slug interpretation).')
      ..addOption('as',
          help: 'Representation to fetch.',
          allowed: ['text', 'html', 'source'],
          allowedHelp: {
            'text': 'GFM markdown (default) — the ingest-as-context view.',
            'html': 'The sanitized rendered HTML bytes (/raw).',
            'source': 'The retained, unsanitized authored source (a slug is resolved to its id).',
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
  String get invocation => 'slopcafe read <id-or-slug> [--as text|html|source] [-o file]';

  @override
  Future<int> run() async {
    final slugOpt = argResults!['slug'] as String?;
    final rest = argResults!.rest;
    final as = argResults!['as'] as String;
    final outPath = argResults!['output'] as String?;

    // Resolve the identifier into an explicit id-or-slug. `--slug` forces slug;
    // otherwise the single positional is auto-detected by shape.
    String? id;
    String? slug;
    if (slugOpt != null) {
      if (rest.isNotEmpty) {
        throw CliException('pass either a positional <id-or-slug> or --slug, not both',
            exitCode: ExitCodes.usage);
      }
      slug = slugOpt;
    } else {
      if (rest.length != 1) {
        throw CliException(
          'expected a <id-or-slug> (or use --slug <slug>)',
          exitCode: ExitCodes.usage,
        );
      }
      final ident = rest.single;
      if (looksLikePublicId(ident)) {
        id = ident;
      } else {
        slug = ident;
      }
    }

    final client = buildClient();
    try {
      switch (as) {
        case 'source':
          // /source is id-only — resolve a slug to its public_id first.
          final srcId = id ?? await client.resolveDocId(slug!, isSlug: true);
          final r = await client.readSource(srcId);
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
