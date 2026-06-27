// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

import 'package:slopcafe_cli/src/format.dart';
import 'package:test/test.dart';

void main() {
  group('inferFormat', () {
    test('markdown extensions', () {
      for (final p in ['a.md', 'A.MARKDOWN', 'x/y.mdown', 'z.mkd', 'q.mdwn']) {
        expect(inferFormat(p), DocFormat.markdown, reason: p);
      }
    });
    test('html extensions', () {
      for (final p in ['a.html', 'b.HTM', 'c.xhtml']) {
        expect(inferFormat(p), DocFormat.html, reason: p);
      }
    });
    test('unknown or extensionless → null', () {
      expect(inferFormat('README'), isNull);
      expect(inferFormat('a.txt'), isNull);
      expect(inferFormat('-'), isNull);
      expect(inferFormat('dir.md/file'), isNull); // last dot logic
    });
  });

  group('DocFormat.parse', () {
    test('aliases', () {
      expect(DocFormat.parse('md'), DocFormat.markdown);
      expect(DocFormat.parse('MARKDOWN'), DocFormat.markdown);
      expect(DocFormat.parse('html'), DocFormat.html);
      expect(DocFormat.parse('htm'), DocFormat.html);
      expect(DocFormat.parse('pdf'), isNull);
    });
    test('content types', () {
      expect(DocFormat.markdown.contentType, 'text/markdown');
      expect(DocFormat.html.contentType, 'text/html');
    });
  });

  group('parseVersionTag', () {
    test('accepts the lenient spellings', () {
      expect(parseVersionTag('"v3"'), 3);
      expect(parseVersionTag('v3'), 3);
      expect(parseVersionTag('W/"v12"'), 12);
      expect(parseVersionTag('"7"'), 7);
      expect(parseVersionTag('7'), 7);
    });
    test('null/garbage → null', () {
      expect(parseVersionTag(null), isNull);
      expect(parseVersionTag('etag-no-digits'), isNull);
    });
  });

  group('normalizeIfMatch', () {
    test('star passes through', () => expect(normalizeIfMatch('*'), '*'));
    test('numbers and tags canonicalize to "v<n>"', () {
      expect(normalizeIfMatch('3'), '"v3"');
      expect(normalizeIfMatch('v3'), '"v3"');
      expect(normalizeIfMatch('"v3"'), '"v3"');
      expect(normalizeIfMatch('  v3 '), '"v3"');
    });
    test('unparseable → null', () {
      expect(normalizeIfMatch('latest'), isNull);
      expect(normalizeIfMatch(''), isNull);
    });
  });

  group('isAsciiHeaderSafe', () {
    test('printable ASCII is safe', () {
      expect(isAsciiHeaderSafe('Plain Title 123 - _ , .'), isTrue);
    });
    test('any byte >= 0x80 is unsafe (dart:io rejects it)', () {
      expect(isAsciiHeaderSafe('Café'), isFalse);
      expect(isAsciiHeaderSafe('日本語'), isFalse);
      expect(isAsciiHeaderSafe('em—dash'), isFalse);
    });
    test('control characters are unsafe', () {
      expect(isAsciiHeaderSafe('line\nbreak'), isFalse);
      expect(isAsciiHeaderSafe('tab\there'), isFalse);
    });
  });
}
