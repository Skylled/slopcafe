// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

import 'dart:convert';

import '../client.dart';
import '../command_base.dart';
import '../errors.dart';
import '../format.dart';
import '../read_envelope.dart';

/// `slopcafe read <id-or-slug>` / `slopcafe read --slug <slug>` — fetch a
/// document's body in one of three representations. The positional identifier
/// is auto-detected (a 22-char base64url string is a `public_id`, anything else
/// a slug); a 22-char *lowercase* name parses as both, so it is resolved
/// live-slug-first via `resolveDocId` (probe `GET /d?slug=`, fall back to the
/// id reading on a miss). `--slug <value>` forces a slug.
///
/// **Output shape is uniform across `--as`.** Without `--json` stdout is the
/// raw body, so `> out.md` and `-o` still capture exactly the bytes. With
/// `--json` stdout (or `-o`) is the read envelope — body **plus** the metadata
/// the response carried — for every representation. Previously only `--as
/// source` honored `--json`, so an agent could not predict the output shape
/// from the flag: the same command answered JSON or raw markdown depending on a
/// *different* flag's value.
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
        throw CliException.usage(
            'pass either a positional <id-or-slug> or --slug, not both');
      }
      slug = slugOpt;
    } else {
      if (rest.length != 1) {
        throw CliException.usage('expected a <id-or-slug> (or use --slug <slug>)');
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
      // A 22-char lowercase positional (`zenyatta-shared-memory`) is BOTH a
      // well-formed public_id and a well-formed slug. resolveDocId probes the
      // live-slug namespace first and falls back to the id reading on a miss
      // (keyless invocations keep the assume-id guess; --slug forces the slug
      // reading outright, with no probe).
      if (id != null && isAmbiguousDocIdentifier(id)) {
        id = await client.resolveDocId(id);
      }
      final followed = argResults!['follow'] as bool;
      switch (as) {
        case 'source':
          // /source is id-only — resolve a slug to its public_id first.
          final srcId = id ?? await client.resolveDocId(slug!, isSlug: true);
          final r = await client.readSource(srcId);
          if (globals.json) {
            emitJson(sourceReadEnvelope(r, publicId: srcId), outPath);
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
            followRedirects: followed,
          );
          _emitRendered(r, format: 'html', id: id, slug: slug, followed: followed,
              outPath: outPath);
        case 'text':
        default:
          final r = await client.readText(
            publicId: id,
            slug: slug,
            followRedirects: followed,
          );
          _emitRendered(r, format: 'markdown', id: id, slug: slug, followed: followed,
              outPath: outPath);
      }
      return ExitCodes.ok;
    } finally {
      client.close();
    }
  }

  /// Emit a rendered (`--as text` / `--as html`) read: the raw bytes normally,
  /// the read envelope under `--json` — both through the `-o`-aware path.
  ///
  /// A `--follow`ed **slug** read omits `slug` from the envelope: the name we
  /// asked for may be the *retired* one, so echoing it as the served document's
  /// own slug would be a lie (and the target's `public_id` isn't on the wire to
  /// use instead). An id read can't redirect, so its `public_id` always stands.
  void _emitRendered(
    ReadResult r, {
    required String format,
    required String? id,
    required String? slug,
    required bool followed,
    required String? outPath,
  }) {
    out.detail(r.version != null ? 'version v${r.version}' : 'version unknown');
    if (!globals.json) {
      emitBody(r.body, outPath);
      return;
    }
    emitJson(
      renderedReadEnvelope(
        content: r.text,
        format: format,
        publicId: id,
        slug: followed ? null : slug,
        version: r.version,
        sanitizerV: r.sanitizerVersion,
        converterV: r.converterVersion,
        contentType: r.contentType,
      ),
      outPath,
    );
  }
}
