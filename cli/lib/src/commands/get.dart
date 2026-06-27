// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

import '../command_base.dart';
import '../errors.dart';

/// `slopcafe get <slug>` — resolve a slug and emit the rendered HTML bytes.
/// A convenience alias for `read --slug <slug> --as html`.
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
      throw CliException('expected exactly one <slug>', exitCode: ExitCodes.usage);
    }
    final client = buildClient();
    try {
      final r = await client.readRaw(
        slug: rest.single,
        followRedirects: argResults!['follow'] as bool,
      );
      out.detail(r.version != null ? 'version v${r.version}' : 'version unknown');
      emitBody(r.body, argResults!['output'] as String?);
      return ExitCodes.ok;
    } finally {
      client.close();
    }
  }
}
