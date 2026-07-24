// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

import 'dart:convert';

import '../../api/api.dart';
import '../command_base.dart';
import '../errors.dart';
import '../format.dart';
import 'metadata_args.dart';

/// One literal find/replace pair.
class EditPair {
  const EditPair(this.find, this.replace);
  final String find;
  final String replace;
}

/// Apply find/replace pairs to [text], mirroring MCP `edit_document` / the
/// Claude Code Edit tool: each `find` must occur at least once; unless
/// [replaceAll], it must occur **exactly once** (ambiguous edits are rejected,
/// not guessed). Replacement is literal — no `$`-group substitution. Returns the
/// rewritten text and the total number of replacements made. Throws a
/// [CliException] (usage) on an empty, missing, or non-unique `find`.
({String text, int replacements}) applyEdits(
  String text,
  List<EditPair> pairs, {
  required bool replaceAll,
}) {
  var out = text;
  var total = 0;
  for (final p in pairs) {
    if (p.find.isEmpty) {
      throw CliException.usage('--find must be non-empty');
    }
    final count = p.find.allMatches(out).length;
    if (count == 0) {
      throw CliException.usage(
        "--find string not present in the source: '${_preview(p.find)}'",
      );
    }
    if (!replaceAll && count > 1) {
      throw CliException.usage(
        "--find string is not unique ($count occurrences): '${_preview(p.find)}' — "
        'use --replace-all or extend the string with surrounding context',
      );
    }
    out = replaceAll ? out.replaceAll(p.find, p.replace) : out.replaceFirst(p.find, p.replace);
    total += replaceAll ? count : 1;
  }
  return (text: out, replacements: total);
}

String _preview(String s) => s.length <= 40 ? s : '${s.substring(0, 40)}…';

/// `slopcafe edit <id-or-slug> --find OLD --replace NEW [...]` — headless
/// find/replace. MCP-only on the server (`edit_document`), so the CLI does it
/// client-side: read the retained **source** (`GET /d/:id/source`), apply the
/// edits to those exact bytes, then `PUT` the result back in the document's own
/// source format (Markdown stays Markdown). Identify the doc by `public_id` or
/// slug (auto-detected; resolved via `GET /d?slug=`).
///
/// It carries the same `--title/--description/--tags/--slug` metadata flags as
/// `publish`/`update` (MCP `edit_document` takes all four): renaming a product
/// across a document and then fixing its title is one call, not an edit
/// followed by a full-body `update` that re-sends the whole document and burns
/// a second version. Inheritance is the backend's own `X-Doc-*` contract —
/// omitting a flag inherits the prior version's value, passing `""` clears it
/// (and for the title re-derives from the new content's H1).
class EditCommand extends SlopcafeCommand {
  EditCommand() {
    argParser
      ..addMultiOption('find',
          abbr: 'f',
          splitCommas: false,
          help: 'Literal substring to replace. Repeatable; pairs by position with --replace. '
              'A single value is taken verbatim (commas are NOT delimiters).')
      ..addMultiOption('replace',
          abbr: 'r',
          splitCommas: false,
          help: 'Replacement for the matching --find. Repeatable; same count as --find. '
              'A single value is taken verbatim (commas are NOT delimiters).')
      ..addFlag('replace-all',
          negatable: false,
          help: 'Replace every occurrence of each --find (default: it must match exactly once).')
      ..addOption('if-match',
          defaultsTo: 'auto',
          help: 'Expected current version: "v<n>", <n>, "*", or "auto" (default; preflights).')
      ..addFlag('force',
          negatable: false, help: 'Last-write-wins: send If-Match: * (overrides --if-match).')
      ..addFlag('integrity',
          defaultsTo: true,
          help: 'Send X-Content-SHA256 over the rewritten body. Use --no-integrity to skip.');
    // Same four flags, same three-state semantics, as publish/update — the
    // republish below is a PUT, so the server's inherit-or-clear contract
    // applies unchanged.
    addMetadataFlags(argParser);
  }

  @override
  String get name => 'edit';

  @override
  String get description =>
      'Find/replace within a document\'s source, then republish (client-side edit_document).';

  @override
  String get invocation =>
      'slopcafe edit <id-or-slug> --find OLD --replace NEW [--find … --replace …] [--replace-all]';

  @override
  Future<int> run() async {
    final rest = argResults!.rest;
    if (rest.length != 1) {
      throw CliException.usage('expected exactly one <id-or-slug>');
    }
    final finds = argResults!['find'] as List<String>;
    final replaces = argResults!['replace'] as List<String>;
    if (finds.isEmpty) {
      throw CliException.usage('at least one --find/--replace pair is required');
    }
    if (finds.length != replaces.length) {
      throw CliException.usage(
        '--find and --replace must be given the same number of times '
        '(${finds.length} find vs ${replaces.length} replace)',
      );
    }
    final pairs = [
      for (var i = 0; i < finds.length; i++) EditPair(finds[i], replaces[i]),
    ];

    final client = buildClient();
    try {
      final id = await client.resolveDocId(rest.single);
      final src = await client.readSource(id);
      final format = DocFormat.parse(src.sourceFormat);
      if (format == null) {
        throw CliException(
          'cannot edit: unknown source format "${src.sourceFormat}"',
          exitCode: ExitCodes.failure,
        );
      }
      final edited = applyEdits(src.source, pairs,
          replaceAll: argResults!['replace-all'] as bool);
      out.detail('${edited.replacements} replacement(s) against source v${src.versionNo}');
      final body = utf8.encode(edited.text);
      if (body.isEmpty) {
        throw CliException.usage('refusing to write an empty body');
      }

      final ifMatch = _resolveIfMatch(src.versionNo);
      final res = await client.update(
        publicId: id,
        body: body,
        format: format,
        ifMatch: ifMatch,
        metadata: parseMetadata(argResults!),
        integrity: argResults!['integrity'] as bool,
      );
      out.result(res.toJson(), () => _human(res, edited.replacements));
      return ExitCodes.ok;
    } finally {
      client.close();
    }
  }

  /// Resolve the `If-Match` for the republish. Unlike `update`, `edit` has
  /// ALREADY read the source (at [sourceVersion]) and computed the new body from
  /// it, so `auto` guards THAT version rather than re-probing the current one: a
  /// concurrent write between the source read and this PUT must 412 (re-read and
  /// retry), never silently clobber the newer version with stale-source edits.
  /// This also means `edit` needs no HEAD preflight — the source read gave us
  /// the version — so it never touches the ETag path at all.
  String _resolveIfMatch(int sourceVersion) {
    if (argResults!['force'] as bool) return '*';
    final value = (argResults!['if-match'] as String).trim();
    if (value.toLowerCase() == 'auto') {
      out.detail('--if-match auto guarding source v$sourceVersion');
      return '"v$sourceVersion"';
    }
    final normalized = normalizeIfMatch(value);
    if (normalized == null) {
      throw CliException.usage(
        "invalid --if-match '$value' (use \"v<n>\", <n>, *, or auto)",
      );
    }
    return normalized;
  }

  String _human(WriteResponse r, int replacements) {
    final b = StringBuffer()
      ..writeln('✓ edited ${r.title ?? '(untitled)'}  → v${r.version}  ($replacements replacement(s))')
      ..writeln('  ${r.url}')
      ..write('  ${r.sizeBytes} bytes · sanitizer ${r.sanitizerV}');
    if (r.sourceSha256 != null) b.write(' · sha256 ${shortSha(r.sourceSha256)}');
    if (r.modified) b.write('\n  ⚠ sanitizer modified your input');
    if (r.stripped.isNotEmpty) b.write('\n  stripped: ${r.stripped.join(', ')}');
    return b.toString();
  }
}
