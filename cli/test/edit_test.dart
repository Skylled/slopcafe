// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

import 'package:slopcafe_cli/src/commands/edit.dart';
import 'package:slopcafe_cli/src/errors.dart';
import 'package:slopcafe_cli/src/format.dart';
import 'package:test/test.dart';

void main() {
  group('applyEdits', () {
    test('single unique replacement', () {
      final r = applyEdits('hello world', [const EditPair('world', 'there')],
          replaceAll: false);
      expect(r.text, 'hello there');
      expect(r.replacements, 1);
    });

    test('sequential pairs apply in order', () {
      final r = applyEdits('a b c', [
        const EditPair('a', 'x'),
        const EditPair('c', 'z'),
      ], replaceAll: false);
      expect(r.text, 'x b z');
      expect(r.replacements, 2);
    });

    test('non-unique find is rejected unless replace-all', () {
      expect(
        () => applyEdits('na na na', [const EditPair('na', 'la')], replaceAll: false),
        throwsA(isA<CliException>()
            .having((e) => e.exitCode, 'exitCode', ExitCodes.usage)
            .having((e) => e.message, 'message', contains('not unique'))),
      );
    });

    test('replace-all replaces every occurrence and counts them', () {
      final r = applyEdits('na na na', [const EditPair('na', 'la')], replaceAll: true);
      expect(r.text, 'la la la');
      expect(r.replacements, 3);
    });

    test('missing find string is rejected', () {
      expect(
        () => applyEdits('hello', [const EditPair('nope', 'x')], replaceAll: false),
        throwsA(isA<CliException>()
            .having((e) => e.message, 'message', contains('not present'))),
      );
    });

    test('empty find string is rejected', () {
      expect(
        () => applyEdits('hello', [const EditPair('', 'x')], replaceAll: false),
        throwsA(isA<CliException>()),
      );
    });

    test('replacement is literal (no \$-group substitution)', () {
      final r = applyEdits(r'a', [const EditPair('a', r'$1')], replaceAll: false);
      expect(r.text, r'$1');
    });
  });

  group('--find/--replace parsing', () {
    // Regression: addMultiOption defaults to splitCommas:true, which silently
    // split a comma-bearing --replace into several values and produced a
    // "find vs replace count mismatch". Values must be taken verbatim.
    List<String> parse(String flag, List<String> args) =>
        (EditCommand().argParser.parse(args)[flag] as List<String>);

    test('a comma-bearing --replace stays a single value', () {
      final replaces = parse('replace', ['--replace', 'a, b, c, d']);
      expect(replaces, ['a, b, c, d']);
    });

    test('a comma-bearing --find stays a single value', () {
      final finds = parse('find', ['--find', 'x, y, z']);
      expect(finds, ['x, y, z']);
    });

    test('one comma-bearing pair yields matching counts', () {
      final parsed = EditCommand().argParser.parse(
          ['--find', 'foo', '--replace', 'one, two, three']);
      expect(parsed['find'], ['foo']);
      expect(parsed['replace'], ['one, two, three']);
    });

    test('repeating the flag still accumulates values', () {
      final finds = parse('find', ['--find', 'a', '--find', 'b, c']);
      expect(finds, ['a', 'b, c']);
    });
  });

  group('looksLikePublicId', () {
    test('accepts a 22-char base64url string', () {
      expect(looksLikePublicId('abcdefghijklmnopqrstuv'), isTrue);
      expect(looksLikePublicId('A1_-A1_-A1_-A1_-A1_-A1'), isTrue);
    });

    test('rejects the wrong length or charset', () {
      expect(looksLikePublicId('too-short'), isFalse);
      expect(looksLikePublicId('proj-x'), isFalse);
      expect(looksLikePublicId('slopcafe-publishing-guide'), isFalse); // 25 chars
      expect(looksLikePublicId('abcdefghijklmnopqrstu.'), isFalse); // bad char
    });
  });
}
