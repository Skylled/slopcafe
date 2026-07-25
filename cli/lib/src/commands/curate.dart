// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/// The two CLASSIFICATION commands: `tags` and `status`.
///
/// Both are full replacements of a subresource, both are agent-reachable, and
/// crucially **neither writes a byte or bumps a version** — which is exactly
/// why they exist as commands rather than as flags on `update`. Re-tagging
/// through `update` would force a whole-body re-upload and burn a version on a
/// change the server defines as version-less.
///
/// Two commands rather than one `curate`, matching the server: independent
/// columns, separate cores, separate error unions, and no atomic path for a
/// combined call (tags applied, status rejected on a bad `superseded_by`, both
/// hidden behind one exit code).
library;

import '../../api/api.dart';
import '../command_base.dart';
import '../errors.dart';

/// `slopcafe tags <id-or-slug> <a,b,c|--clear>` — full-replace a doc's tags.
class TagsCommand extends SlopcafeCommand {
  TagsCommand() {
    argParser.addFlag(
      'clear',
      negatable: false,
      help: 'Remove every tag (equivalent to passing an empty list).',
    );
  }

  @override
  String get name => 'tags';

  @override
  String get description =>
      'Replace a document\'s tags (PUT /d/:id/tags). No new version is written.';

  @override
  String get invocation => 'slopcafe tags <id-or-slug> <a,b,c> | --clear';

  @override
  Future<int> run() async {
    final rest = argResults!.rest;
    final clear = argResults!['clear'] as bool;
    if (rest.isEmpty) {
      throw CliException.usage('expected <id-or-slug>');
    }
    if (clear && rest.length != 1) {
      throw CliException.usage('--clear takes no tag list');
    }
    if (!clear && rest.length != 2) {
      throw CliException.usage(
        'expected <id-or-slug> <a,b,c> (or --clear to remove every tag)',
      );
    }
    // Full replacement, so an empty list must be *explicit*: `--clear` rather
    // than an omitted argument, which would more likely be a mistake than an
    // intent to wipe the document's classification.
    final tags = clear
        ? const <String>[]
        : rest[1].split(',').map((t) => t.trim()).where((t) => t.isNotEmpty).toList();

    final client = buildClient();
    try {
      final id = await client.resolveDocId(rest[0]);
      final r = await client.setTags(id, tags);
      out.result(r.toJson(), () => _human(r));
      // The server sanitizes silently rather than rejecting, so tell the caller
      // when what landed differs from what they sent. On STDERR (like every
      // other warning) so it also reaches a `--json` caller without corrupting
      // the object on stdout.
      if (!_sameTags(tags, r.tags)) {
        out.warn(
          'server normalized your tags: sent '
          '${tags.isEmpty ? '(none)' : tags.join(', ')} → stored '
          '${r.tags.isEmpty ? '(none)' : r.tags.join(', ')} '
          '(charset is [A-Za-z0-9_-]; invalid characters are stripped)',
        );
      }
      return ExitCodes.ok;
    } finally {
      client.close();
    }
  }

  String _human(SetDocumentTagsResponse r) =>
      '✓ tags ${r.publicId}  → ${r.tags.isEmpty ? '(none)' : r.tags.join(', ')}';

  bool _sameTags(List<String> a, List<String> b) =>
      a.length == b.length &&
      List.generate(a.length, (i) => a[i] == b[i]).every((x) => x);
}

/// `slopcafe status <id-or-slug> <active|deprecated>` — set lifecycle status.
class StatusCommand extends SlopcafeCommand {
  StatusCommand() {
    argParser.addOption(
      'superseded-by',
      valueHelp: 'public_id',
      help: 'The replacement document. A public_id ONLY — never a slug. '
          'Must be live and may not be this document. Cleared by `active`.',
    );
  }

  @override
  String get name => 'status';

  @override
  String get description =>
      'Set a document\'s lifecycle status (PUT /d/:id/status). No new version.';

  @override
  String get invocation =>
      'slopcafe status <id-or-slug> <active|deprecated> [--superseded-by <public_id>]';

  @override
  Future<int> run() async {
    final rest = argResults!.rest;
    if (rest.length != 2) {
      throw CliException.usage('expected <id-or-slug> <active|deprecated>');
    }
    final status = rest[1].toLowerCase();
    if (status != 'active' && status != 'deprecated') {
      // "archived" is reserved server-side and rejected; say so here rather
      // than spending a round trip to be told.
      throw CliException.usage(
        "invalid status '${rest[1]}' (use active or deprecated; "
        'archived is reserved and not settable)',
      );
    }
    final supersededBy = (argResults!['superseded-by'] as String?)?.trim();
    if (status == 'active' && supersededBy != null && supersededBy.isNotEmpty) {
      throw CliException.usage(
        '--superseded-by cannot be combined with `active` '
        '(setting active clears the pointer)',
      );
    }

    final client = buildClient();
    try {
      final id = await client.resolveDocId(rest[0]);
      final r = await client.setStatus(
        id,
        status: status,
        supersededBy: (supersededBy != null && supersededBy.isNotEmpty)
            ? supersededBy
            : null,
      );
      out.result(r.toJson(), () => _human(r));
      return ExitCodes.ok;
    } finally {
      client.close();
    }
  }

  String _human(SetDocumentStatusResponse r) {
    final b = StringBuffer()..write('✓ status ${r.publicId}  → ${r.status}');
    if (r.supersededBy != null) b.write('  → ${r.supersededBy}');
    return b.toString();
  }
}
