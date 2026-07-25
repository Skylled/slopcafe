// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

import '../../api/api.dart';
import '../client.dart';
import '../command_base.dart';
import '../errors.dart';
import '../format.dart';
import 'metadata_args.dart';
import 'publish.dart' show resolveFormat;

/// `slopcafe update <public_id> <file|-> [options]` — `PUT /d/:id`.
class UpdateCommand extends SlopcafeCommand {
  UpdateCommand() {
    argParser
      ..addOption(
        'if-match',
        help: 'Expected current version: "v<n>", a bare <n>, "*", or "auto". '
            'Default "auto" preflights the current version for you.',
        defaultsTo: 'auto',
      )
      ..addFlag(
        'force',
        negatable: false,
        help: 'Last-write-wins: send If-Match: * (overrides --if-match).',
      )
      ..addOption(
        'format',
        abbr: 'f',
        help: 'Body format. Inferred from the file extension when omitted; '
            'required when reading from stdin.',
        allowed: ['markdown', 'md', 'html', 'htm'],
      )
      ..addFlag('integrity',
          defaultsTo: true,
          help: 'Send X-Content-SHA256 over the raw body. Use --no-integrity to skip.');
    addMetadataFlags(argParser);
  }

  @override
  String get name => 'update';

  @override
  String get description =>
      'Append a new version to a document (PUT /d/:id). Replaces the body.';

  @override
  String get invocation => 'slopcafe update <id-or-slug> <file|-> [options]';

  @override
  Future<int> run() async {
    final rest = argResults!.rest;
    if (rest.length != 2) {
      throw CliException.usage('expected <id-or-slug> <file|->');
    }
    final identifier = rest[0];
    final source = rest[1];
    final format = resolveFormat(argResults!['format'] as String?, source);
    final body = await readInput(source);
    if (body.isEmpty) {
      throw CliException.usage('refusing to update with an empty body');
    }

    final client = buildClient();
    try {
      // Accept a public_id or a slug (auto-detected); PUT /d/:id is id-only, so
      // resolve a slug → public_id via GET /d?slug= first.
      final id = await client.resolveDocId(identifier);
      final ifMatch = await _resolveIfMatch(client, id);
      final res = await client.update(
        publicId: id,
        body: body,
        format: format,
        ifMatch: ifMatch,
        metadata: parseMetadata(argResults!),
        integrity: argResults!['integrity'] as bool,
      );
      out.result(res.toJson(), () => _human(res));
      _warnIfReadersLag(res);
      return ExitCodes.ok;
    } finally {
      client.close();
    }
  }

  /// The version readers were being served at preflight time, when the server
  /// proved it differs from the current one — i.e. this document is public and
  /// already has work nobody has published. Null when there was no preflight,
  /// the server didn't say, or the two agreed.
  ///
  /// Note what this deliberately does NOT claim: when the two AGREE we cannot
  /// tell a private document from a fully-published public one (both serve
  /// `current_ver`, so both report `etag == header`), and writing to the latter
  /// does open a gap. Warning on that ambiguity would fire on every ordinary
  /// private update — the common case — and a warning that cries wolf is one
  /// people stop reading. So this reports only what the server has PROVEN, and
  /// `slopcafe list`/`find` carry `published_ver` on every row for the rest.
  int? _servedAtPreflight;

  Future<String> _resolveIfMatch(SlopcafeClient client, String id) async {
    if (argResults!['force'] as bool) return '*';
    final value = (argResults!['if-match'] as String).trim();
    if (value.toLowerCase() == 'auto') {
      final p = await client.versionPointers(id);
      final v = p.current;
      if (p.served != null && p.served != v) _servedAtPreflight = p.served;
      out.detail('--if-match auto resolved to "v$v"');
      return '"v$v"';
    }
    final normalized = normalizeIfMatch(value);
    if (normalized == null) {
      throw CliException.usage(
        "invalid --if-match '$value' (use \"v<n>\", <n>, *, or auto)",
      );
    }
    return normalized;
  }

  /// Say so when the write landed behind a publication gate.
  ///
  /// `✓ updated → v7` followed by the document's URL reads as "that URL now
  /// shows v7". On a public document with unpublished work it does not, and
  /// the CLI knew both numbers a moment ago. It goes to STDERR via `warn`, so
  /// it reaches a human without corrupting the `--json` object on stdout.
  ///
  /// It names no promote verb on purpose: promotion is operator-only at every
  /// door and no agent-reachable one may ever exist, so the CLI — which holds
  /// an agent key — points at where an operator does it instead of implying a
  /// flag it will never have.
  void _warnIfReadersLag(WriteResponse r) {
    final served = _servedAtPreflight;
    if (served == null || served == r.version) return;
    out.warn(
      'stored as v${r.version}, but readers still see v$served at ${r.url} — '
      'publishing a stored version is operator-only '
      '(an operator promotes it on the document\'s /manage page)',
    );
  }

  String _human(WriteResponse r) {
    final b = StringBuffer()
      ..writeln('✓ updated ${r.title ?? '(untitled)'}  → v${r.version}')
      ..writeln('  ${r.url}')
      ..write('  ${r.sizeBytes} bytes · sanitizer ${r.sanitizerV}');
    if (r.sourceSha256 != null) b.write(' · sha256 ${shortSha(r.sourceSha256)}');
    if (r.modified) b.write('\n  ⚠ sanitizer modified your input');
    if (r.stripped.isNotEmpty) b.write('\n  stripped: ${r.stripped.join(', ')}');
    if (r.willNotRender.isNotEmpty) {
      b.write('\n  will not render: ${r.willNotRender.join(', ')}');
    }
    return b.toString();
  }
}
