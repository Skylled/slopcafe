// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

import '../../api/api.dart';
import '../command_base.dart';
import '../errors.dart';

/// `slopcafe links <public_id>` — the link-graph neighborhood (`GET /d/:id/links`).
class LinksCommand extends SlopcafeCommand {
  @override
  String get name => 'links';

  @override
  String get description =>
      'Show a document\'s link graph: who links to it, and where it links.';

  @override
  String get invocation => 'slopcafe links <id-or-slug>';

  @override
  Future<int> run() async {
    final rest = argResults!.rest;
    if (rest.length != 1) {
      throw CliException.usage('expected exactly one <id-or-slug>');
    }
    final client = buildClient();
    try {
      // /d/:id/links is id-only; resolve a slug → public_id first.
      final id = await client.resolveDocId(rest.single);
      final r = await client.links(id);
      out.result(r.toJson(), () => _human(r));
      return ExitCodes.ok;
    } finally {
      client.close();
    }
  }

  String _human(DocumentLinksResponse r) {
    final b = StringBuffer()..writeln('links for ${r.publicId}');
    b.writeln('  backlinks (${r.backlinks.length}):');
    if (r.backlinks.isEmpty) {
      b.writeln('    (none)');
    } else {
      for (final d in r.backlinks) {
        b.writeln('    ← ${d.title ?? '(untitled)'}  [${d.publicId}]');
      }
    }
    b.writeln('  outbound (${r.outbound.length}):');
    if (r.outbound.isEmpty) {
      b.writeln('    (none)');
    } else {
      for (final l in r.outbound) {
        final target = l.targetPublicId != null ? ' → ${l.targetPublicId}' : '';
        b.writeln('    [${l.state}] ${l.kind}:${l.value}$target');
      }
    }
    return b.toString().trimRight();
  }
}
