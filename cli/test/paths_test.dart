// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

import 'dart:io';

import 'package:slopcafe_cli/src/errors.dart';
import 'package:slopcafe_cli/src/paths.dart';
import 'package:test/test.dart';

void main() {
  group('isWithinRoot (pure)', () {
    test('root itself and children are within', () {
      expect(isWithinRoot('/a/b', '/a/b', separator: '/'), isTrue);
      expect(isWithinRoot('/a/b/c.md', '/a/b', separator: '/'), isTrue);
      expect(isWithinRoot('/a/b/c/d', '/a/b', separator: '/'), isTrue);
    });

    test('siblings and prefix-named siblings are outside', () {
      expect(isWithinRoot('/a/c', '/a/b', separator: '/'), isFalse);
      // The classic startsWith trap: /a/bc shares the string prefix /a/b.
      expect(isWithinRoot('/a/bc', '/a/b', separator: '/'), isFalse);
      expect(isWithinRoot('/a', '/a/b', separator: '/'), isFalse);
    });

    test('a trailing separator on the root is tolerated', () {
      expect(isWithinRoot('/a/b/c', '/a/b/', separator: '/'), isTrue);
      expect(isWithinRoot('/a/bc', '/a/b/', separator: '/'), isFalse);
    });

    test("root '/' admits any absolute path", () {
      expect(isWithinRoot('/etc/passwd', '/', separator: '/'), isTrue);
    });

    test('case-insensitive mode (the Windows behavior)', () {
      expect(
        isWithinRoot(r'C:\Work\doc.md', r'c:\work',
            separator: r'\', caseInsensitive: true),
        isTrue,
      );
      expect(
        isWithinRoot('/A/B/c', '/a/b', separator: '/', caseInsensitive: false),
        isFalse,
      );
    });
  });

  group('resolvePathRoot', () {
    test('the off-switch is disabled: SLOPCAFE_UNSAFE_PATHS is ignored', () {
      // The guard has no off-switch (deliberate — see paths.dart). If the
      // commented SLOPCAFE_UNSAFE_PATHS / --unsafe-paths plumbing is ever
      // restored, this pin should flip back to asserting the disable works.
      for (final v in ['1', 'true', 'TRUE', 'yes', '0', '']) {
        expect(
          resolvePathRoot(env: {'SLOPCAFE_UNSAFE_PATHS': v}),
          Directory.current.resolveSymbolicLinksSync(),
        );
      }
    });

    test('SLOPCAFE_PATH_ROOT widens to an ancestor of the CWD (canonicalized)',
        () {
      final tmp = Directory.systemTemp.createTempSync('slopcafe_paths');
      addTearDown(() => tmp.deleteSync(recursive: true));
      final cwd = Directory('${tmp.path}/sub')..createSync();
      expect(
        resolvePathRoot(
          env: {'SLOPCAFE_PATH_ROOT': tmp.path},
          cwd: cwd.path,
        ),
        tmp.resolveSymbolicLinksSync(),
      );
    });

    test('SLOPCAFE_PATH_ROOT unrelated to the CWD is rejected', () {
      final a = Directory.systemTemp.createTempSync('slopcafe_paths_a');
      final b = Directory.systemTemp.createTempSync('slopcafe_paths_b');
      addTearDown(() => a.deleteSync(recursive: true));
      addTearDown(() => b.deleteSync(recursive: true));
      expect(
        () => resolvePathRoot(
          env: {'SLOPCAFE_PATH_ROOT': b.path},
          cwd: a.path,
        ),
        throwsA(isA<CliException>()
            .having((e) => e.message, 'message',
                contains('ancestor or descendant'))
            .having((e) => e.exitCode, 'exitCode', ExitCodes.usage)),
      );
    });

    test('SLOPCAFE_PATH_ROOT naming the home directory is rejected', () {
      final tmp = Directory.systemTemp.createTempSync('slopcafe_paths');
      addTearDown(() => tmp.deleteSync(recursive: true));
      final cwd = Directory('${tmp.path}/proj')..createSync();
      expect(
        () => resolvePathRoot(
          env: {'SLOPCAFE_PATH_ROOT': tmp.path, 'HOME': tmp.path},
          cwd: cwd.path,
        ),
        throwsA(isA<CliException>()
            .having((e) => e.message, 'message', contains('home directory'))),
      );
    });

    test('nonexistent SLOPCAFE_PATH_ROOT fails loudly', () {
      expect(
        () => resolvePathRoot(
            env: const {'SLOPCAFE_PATH_ROOT': '/no/such/dir/slopcafe'}),
        throwsA(isA<CliException>()
            .having((e) => e.exitCode, 'exitCode', ExitCodes.usage)),
      );
    });

    test('defaults to the canonical working directory', () {
      expect(
        resolvePathRoot(env: const {}),
        Directory.current.resolveSymbolicLinksSync(),
      );
    });
  });

  group('pathRootRejection (pure)', () {
    const cwd = '/ws/project';
    const home = '/Users/kyle';

    String? check(String root, {String c = cwd, String? h}) =>
        pathRootRejection(root, cwd: c, home: h, separator: '/');

    test('the CWD itself and descendants are accepted', () {
      expect(check('/ws/project'), isNull);
      expect(check('/ws/project/'), isNull);
      expect(check('/ws/project/sub'), isNull);
    });

    test('an ancestor of the CWD is accepted (the widening case)', () {
      expect(check('/ws'), isNull);
      expect(check('$home/Repos', c: '$home/Repos/agent-web-host', h: home),
          isNull);
    });

    test('the filesystem root is rejected even though it is an ancestor', () {
      expect(check('/'), contains('filesystem root'));
      expect(
        pathRootRejection(r'C:\', cwd: r'C:\work\project',
            separator: r'\', caseInsensitive: true),
        contains('filesystem root'),
      );
    });

    test('an unrelated subtree is rejected', () {
      expect(check('/etc'), contains('ancestor or descendant'));
      expect(check('/ws/other'), contains('ancestor or descendant'));
      expect(check('/ws/projectile'), contains('ancestor or descendant'));
    });

    test('a root containing the home directory is rejected', () {
      expect(check(home, c: '$home/Repos/x', h: home),
          contains('home directory'));
      expect(check('/Users', c: '$home/Repos/x', h: home),
          contains('home directory'));
    });

    test('CWD == home is still usable as the (default-equivalent) root', () {
      expect(check(home, c: home, h: home), isNull);
    });

    test('with no home known, non-root ancestors are accepted', () {
      expect(check('/Users', c: '$home/Repos/x'), isNull);
    });
  });

  group('guardInputPath', () {
    late Directory tmp;
    late String root;

    setUp(() {
      tmp = Directory.systemTemp.createTempSync('slopcafe_paths');
      root = '${tmp.resolveSymbolicLinksSync()}/root';
      Directory(root).createSync();
    });
    tearDown(() => tmp.deleteSync(recursive: true));

    test('a file under the root passes and returns the canonical path', () {
      File('$root/doc.md').writeAsStringSync('hi');
      expect(guardInputPath('$root/doc.md', root: root), '$root/doc.md');
      // A ../-bearing spelling of the same file also canonicalizes cleanly.
      File('$root/sub/inner.md').createSync(recursive: true);
      expect(
        guardInputPath('$root/sub/../sub/inner.md', root: root),
        '$root/sub/inner.md',
      );
    });

    test('a path escaping the root is rejected', () {
      final outside = File('${tmp.path}/outside.md')..writeAsStringSync('no');
      expect(
        () => guardInputPath(outside.path, root: root),
        throwsA(isA<CliException>()
            .having((e) => e.message, 'message', contains('escapes'))
            .having((e) => e.exitCode, 'exitCode', ExitCodes.usage)),
      );
      expect(
        () => guardInputPath('$root/../outside.md', root: root),
        throwsA(isA<CliException>()),
      );
    });

    test('a symlink inside the root pointing outside is rejected', () {
      File('${tmp.path}/secret.txt').writeAsStringSync('s3cret');
      Link('$root/innocent.md').createSync('${tmp.path}/secret.txt');
      expect(
        () => guardInputPath('$root/innocent.md', root: root),
        throwsA(isA<CliException>()
            .having((e) => e.message, 'message', contains('escapes'))),
      );
    });

    test('a symlink resolving within the root passes', () {
      File('$root/real.md').writeAsStringSync('hi');
      Link('$root/alias.md').createSync('$root/real.md');
      expect(guardInputPath('$root/alias.md', root: root), '$root/real.md');
    });

    test('a missing file is a usage error regardless of the guard', () {
      for (final r in [root, null]) {
        expect(
          () => guardInputPath('$root/absent.md', root: r),
          throwsA(isA<CliException>()
              .having((e) => e.message, 'message', contains('no such file'))),
        );
      }
    });

    test('root == null (guard off — reserved mechanism) passes any existing path through', () {
      final outside = File('${tmp.path}/outside.md')..writeAsStringSync('ok');
      expect(guardInputPath(outside.path, root: null), outside.path);
    });
  });

  group('guardOutputPath', () {
    late Directory tmp;
    late String root;

    setUp(() {
      tmp = Directory.systemTemp.createTempSync('slopcafe_paths');
      root = '${tmp.resolveSymbolicLinksSync()}/root';
      Directory(root).createSync();
    });
    tearDown(() => tmp.deleteSync(recursive: true));

    test('a new file under the root passes', () {
      expect(guardOutputPath('$root/out.md', root: root), '$root/out.md');
    });

    test('an existing file under the root passes', () {
      File('$root/out.md').writeAsStringSync('old');
      expect(guardOutputPath('$root/out.md', root: root), '$root/out.md');
    });

    test('a new file outside the root is rejected', () {
      expect(
        () => guardOutputPath('${tmp.path}/out.md', root: root),
        throwsA(isA<CliException>()
            .having((e) => e.message, 'message', contains('escapes'))),
      );
      expect(
        () => guardOutputPath('$root/../out.md', root: root),
        throwsA(isA<CliException>()),
      );
    });

    test('an existing symlink pointing outside the root is rejected', () {
      File('${tmp.path}/target.md').writeAsStringSync('t');
      Link('$root/link.md').createSync('${tmp.path}/target.md');
      expect(
        () => guardOutputPath('$root/link.md', root: root),
        throwsA(isA<CliException>()
            .having((e) => e.message, 'message', contains('escapes'))),
      );
    });

    test('a new file whose parent is a symlink out of the root is rejected', () {
      Directory('${tmp.path}/elsewhere').createSync();
      Link('$root/sub').createSync('${tmp.path}/elsewhere');
      expect(
        () => guardOutputPath('$root/sub/out.md', root: root),
        throwsA(isA<CliException>()
            .having((e) => e.message, 'message', contains('escapes'))),
      );
    });

    test('a missing parent directory is a usage error', () {
      expect(
        () => guardOutputPath('$root/no/such/dir/out.md', root: root),
        throwsA(isA<CliException>()
            .having((e) => e.message, 'message', contains('no such directory'))),
      );
    });

    test('root == null (guard off — reserved mechanism) passes the path through untouched', () {
      expect(
        guardOutputPath('${tmp.path}/anywhere.md', root: null),
        '${tmp.path}/anywhere.md',
      );
    });
  });
}
