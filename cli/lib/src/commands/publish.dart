// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

import '../../api/api.dart';
import '../command_base.dart';
import '../errors.dart';
import '../format.dart';
import 'metadata_args.dart';

/// `slopcafe publish <file|-> [options]` — `POST /d`.
class PublishCommand extends SlopcafeCommand {
  PublishCommand() {
    argParser
      ..addOption(
        'format',
        abbr: 'f',
        help: 'Body format. Inferred from the file extension when omitted; '
            'required when reading from stdin.',
        allowed: ['markdown', 'md', 'html', 'htm'],
      )
      ..addFlag(
        'integrity',
        defaultsTo: true,
        help: 'Send X-Content-SHA256 over the raw body (byte-exact publish). '
            'Use --no-integrity to skip.',
      );
    addMetadataFlags(argParser);
  }

  @override
  String get name => 'publish';

  @override
  String get description =>
      'Publish a new document (POST /d). Byte-exact by default.';

  @override
  String get invocation => 'slopcafe publish <file|-> [options]';

  @override
  Future<int> run() async {
    final rest = argResults!.rest;
    if (rest.length != 1) {
      throw CliException.usage('expected exactly one <file|-> argument');
    }
    final source = rest.single;
    final format = resolveFormat(argResults!['format'] as String?, source);
    final body = await readInput(source);
    if (body.isEmpty) {
      throw CliException.usage('refusing to publish an empty body');
    }

    final client = buildClient();
    try {
      final res = await client.publish(
        body: body,
        format: format,
        metadata: parseMetadata(argResults!),
        integrity: argResults!['integrity'] as bool,
      );
      out.result(res.toJson(), () => _human(res));
      return ExitCodes.ok;
    } finally {
      client.close();
    }
  }

  String _human(WriteResponse r) {
    final b = StringBuffer()
      ..writeln('✓ published ${r.title ?? '(untitled)'}  v${r.version}')
      ..writeln('  ${r.url}')
      ..write('  ${r.sizeBytes} bytes · sanitizer ${r.sanitizerV}');
    if (r.sourceSha256 != null) b.write(' · sha256 ${shortSha(r.sourceSha256)}');
    if (r.slug != null) b.write('\n  slug: ${r.slug}');
    if (r.modified) b.write('\n  ⚠ sanitizer modified your input');
    if (r.stripped.isNotEmpty) b.write('\n  stripped: ${r.stripped.join(', ')}');
    if (r.willNotRender.isNotEmpty) {
      b.write('\n  will not render: ${r.willNotRender.join(', ')}');
    }
    return b.toString();
  }
}

/// Resolve the write format from an explicit `--format` or the file extension.
DocFormat resolveFormat(String? formatFlag, String source) {
  if (formatFlag != null) {
    final f = DocFormat.parse(formatFlag);
    if (f == null) {
      throw CliException.usage("invalid --format '$formatFlag' (use markdown or html)");
    }
    return f;
  }
  if (source == '-') {
    throw CliException.usage(
      'cannot infer format from stdin — pass --format markdown|html',
    );
  }
  final inferred = inferFormat(source);
  if (inferred == null) {
    throw CliException.usage(
      "cannot infer format from '$source' — pass --format markdown|html",
    );
  }
  return inferred;
}
