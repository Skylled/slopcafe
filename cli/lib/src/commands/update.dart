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
      return ExitCodes.ok;
    } finally {
      client.close();
    }
  }

  Future<String> _resolveIfMatch(SlopcafeClient client, String id) async {
    if (argResults!['force'] as bool) return '*';
    final value = (argResults!['if-match'] as String).trim();
    if (value.toLowerCase() == 'auto') {
      final v = await client.currentVersion(id);
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
