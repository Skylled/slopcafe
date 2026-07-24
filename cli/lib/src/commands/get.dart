// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

import '../command_base.dart';
import '../errors.dart';
import '../read_envelope.dart';

/// `slopcafe get <slug>` — resolve a slug and emit the rendered HTML bytes.
/// A convenience alias for `read --slug <slug> --as html`, and it honors
/// `--json` (the read envelope) and `-o` the same way, so the two commands are
/// interchangeable for a headless caller rather than differing by which flags
/// they happen to respect.
class GetCommand extends SlopcafeCommand {
  GetCommand() {
    argParser
      ..addOption('output',
          abbr: 'o', help: 'Write the body to a file instead of stdout.')
      ..addFlag('follow',
          negatable: false,
          help: 'If the slug was retired and now redirects, follow it.');
  }

  @override
  String get name => 'get';

  @override
  String get description =>
      'Fetch a document by slug (GET /s/:slug) — the rendered HTML bytes.';

  @override
  String get invocation => 'slopcafe get <slug> [-o file]';

  @override
  Future<int> run() async {
    final rest = argResults!.rest;
    if (rest.length != 1) {
      throw CliException.usage('expected exactly one <slug>');
    }
    final slug = rest.single;
    final followed = argResults!['follow'] as bool;
    final outPath = argResults!['output'] as String?;
    final client = buildClient();
    try {
      final r = await client.readRaw(slug: slug, followRedirects: followed);
      out.detail(r.version != null ? 'version v${r.version}' : 'version unknown');
      if (globals.json) {
        emitJson(
          renderedReadEnvelope(
            content: r.text,
            format: 'html',
            // A followed redirect may have served a *different* document than
            // the retired slug names, so don't echo the slug as if it were the
            // target's own.
            slug: followed ? null : slug,
            version: r.version,
            sanitizerV: r.sanitizerVersion,
            converterV: r.converterVersion,
            contentType: r.contentType,
          ),
          outPath,
        );
      } else {
        emitBody(r.body, outPath);
      }
      return ExitCodes.ok;
    } finally {
      client.close();
    }
  }
}
