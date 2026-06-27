// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

import '../command_base.dart';
import '../errors.dart';

/// `slopcafe find <slug>` — resolve a slug to its `public_id` via `GET /d?slug=`.
/// The plain-text output is just the `public_id` on stdout, so it composes:
/// `slopcafe update "$(slopcafe find proj-x)" proj.md`. `--json` emits the full
/// listing row. This is the explicit escape hatch for the auto-detection the
/// read/update/links/edit commands do — and the headless analogue of the MCP
/// `list_documents slug:"…"` lookup.
class FindCommand extends SlopcafeCommand {
  @override
  String get name => 'find';

  @override
  String get description =>
      'Resolve a slug to its public_id (prints the id; --json prints the row).';

  @override
  String get invocation => 'slopcafe find <slug>';

  @override
  Future<int> run() async {
    final rest = argResults!.rest;
    if (rest.length != 1) {
      throw CliException('expected exactly one <slug>', exitCode: ExitCodes.usage);
    }
    final slug = rest.single;

    final client = buildClient();
    try {
      final res = await client.listDocuments(slug: slug, limit: 1);
      if (res.documents.isEmpty) {
        throw CliException(
          "no live document has the slug '$slug'",
          exitCode: ExitCodes.usage,
        );
      }
      final d = res.documents.first;
      out.note('${d.title ?? '(untitled)'} · v${d.currentVer ?? '—'}');
      out.result(d.toJson(), () => d.publicId);
      return ExitCodes.ok;
    } finally {
      client.close();
    }
  }
}
