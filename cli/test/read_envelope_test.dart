// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

import 'package:slopcafe_cli/api/api.dart';
import 'package:slopcafe_cli/src/read_envelope.dart';
import 'package:test/test.dart';

void main() {
  group('renderedReadEnvelope', () {
    test('a markdown read carries body + every header the response set', () {
      final e = renderedReadEnvelope(
        content: '# Hi\n',
        format: 'markdown',
        publicId: 'ABCDEFGHIJKLMNOPQRSTUV',
        version: 3,
        sanitizerV: 'ammonia-v1.5',
        converterV: 'md-v1.1',
        contentType: 'text/markdown; charset=utf-8',
      );
      expect(e['public_id'], 'ABCDEFGHIJKLMNOPQRSTUV');
      expect(e['representation'], 'rendered');
      expect(e['content'], '# Hi\n');
      expect(e['format'], 'markdown');
      expect(e['version'], 3);
      expect(e['sanitizer_v'], 'ammonia-v1.5');
      expect(e['converter_v'], 'md-v1.1');
      expect(e['content_type'], 'text/markdown; charset=utf-8');
      // Not on the wire for a body read — must not be fabricated as null.
      expect(e.containsKey('title'), isFalse);
      expect(e.containsKey('tags'), isFalse);
      expect(e.containsKey('status'), isFalse);
    });

    test('an html read reports converter_v as an explicit null', () {
      // /raw runs no converter, so null is the ANSWER (matching src/mcp.ts) and
      // keeps the shape stable across --as values. It sets no version headers,
      // so sanitizer_v is simply unknown → absent, not null.
      final e = renderedReadEnvelope(
        content: '<p>hi</p>',
        format: 'html',
        slug: 'q3-report',
        version: 7,
        contentType: 'text/html; charset=utf-8',
      );
      expect(e['format'], 'html');
      expect(e.containsKey('converter_v'), isTrue);
      expect(e['converter_v'], isNull);
      expect(e.containsKey('sanitizer_v'), isFalse);
      expect(e['slug'], 'q3-report');
      expect(e.containsKey('public_id'), isFalse);
    });

    test('unknown values are omitted, never nulled', () {
      // No ETag (a proxy stripped it) and no identifier: the envelope shrinks
      // rather than asserting "this document has no version".
      final e = renderedReadEnvelope(content: 'x', format: 'markdown');
      expect(e.containsKey('version'), isFalse);
      expect(e.containsKey('sanitizer_v'), isFalse);
      expect(e.containsKey('converter_v'), isFalse);
      expect(e.containsKey('content_type'), isFalse);
      expect(e.containsKey('public_id'), isFalse);
      expect(e.containsKey('slug'), isFalse);
      expect(e['content'], 'x');
    });
  });

  group('sourceReadEnvelope', () {
    ReadSourceResponse source() => ReadSourceResponse(
      source: '## Body\n',
      sourceFormat: 'markdown',
      versionNo: 4,
      sanitizerV: 'ammonia-v1.5',
      stripped: const ['script'],
      willNotRender: const [],
      tags: const ['finance'],
      status: 'deprecated',
      unsanitized: true,
      sourceSha256: 'e3b0c4',
      title: 'Q3',
      description: 'desc',
      slug: 'q3-report',
      supersededBy: 'ZZZZZZZZZZZZZZZZZZZZZZ',
    );

    test('renames only source→content and version_no→version', () {
      final e = sourceReadEnvelope(source(), publicId: 'ABCDEFGHIJKLMNOPQRSTUV');
      // MCP names.
      expect(e['content'], '## Body\n');
      expect(e['version'], 4);
      expect(e['representation'], 'source');
      expect(e['format'], 'markdown'); // format echoes the authored language
      // Everything else the endpoint returned survives under its own name.
      expect(e['source_format'], 'markdown');
      expect(e['source_sha256'], 'e3b0c4');
      expect(e['sanitizer_v'], 'ammonia-v1.5');
      expect(e['stripped'], ['script']);
      expect(e['will_not_render'], isEmpty);
      expect(e['title'], 'Q3');
      expect(e['description'], 'desc');
      expect(e['tags'], ['finance']);
      expect(e['slug'], 'q3-report');
      expect(e['status'], 'deprecated');
      expect(e['superseded_by'], 'ZZZZZZZZZZZZZZZZZZZZZZ');
      expect(e['public_id'], 'ABCDEFGHIJKLMNOPQRSTUV');
      // The two keys that no longer exist under their old spellings.
      expect(e.containsKey('source'), isFalse);
      expect(e.containsKey('version_no'), isFalse);
    });

    test('flags the bytes as unsanitized and reports no converter', () {
      final e = sourceReadEnvelope(source(), publicId: 'ABCDEFGHIJKLMNOPQRSTUV');
      expect(e['unsanitized'], isTrue);
      expect(e.containsKey('converter_v'), isTrue);
      expect(e['converter_v'], isNull); // no converter runs on a source read
    });
  });
}
