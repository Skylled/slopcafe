// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

import 'dart:io';

import 'errors.dart';

/// Path confinement for file arguments (`publish <file>`, `-o <file>`, …).
///
/// The CLI is routinely driven by sandboxed agents whose harness confines them
/// to a working directory — but the harness can't see inside our process, so a
/// bare `slopcafe publish ~/.ssh/id_rsa` would happily exfiltrate any readable
/// file on the device. By default every user-supplied file path (input and
/// output) must resolve — **after** symlink resolution — to somewhere under a
/// single allowed root: the working directory, or `SLOPCAFE_PATH_ROOT` when the
/// harness sets one.
///
/// There is deliberately **no off-switch**: an initial build had
/// `--unsafe-paths` / `SLOPCAFE_UNSAFE_PATHS=1` disable the guard, but any
/// built-in disable is a free escape hatch for exactly the callers the guard
/// targets, so both are commented out (here, in runner.dart, and in
/// command_base's `pathRoot`) until something explicitly needs them. Widening
/// via `SLOPCAFE_PATH_ROOT` is **constrained** so it can't be spelled into an
/// off-switch either (see [pathRootRejection]: no filesystem root, lineage
/// with the CWD required, must not contain `$HOME`), and it is an explicit,
/// visible act in the invocation — something a harness permission prompt or an
/// audit log shows verbatim — never the silent default. If the off-switches
/// are ever restored,
/// they must NOT become config-file settings: a stored knob would be invisible
/// at call time, which defeats the point.
///
/// Internal paths the CLI derives itself (the XDG config file) are not
/// confined — only paths that arrive as command-line values.

/// Resolve the confinement root for this invocation: `SLOPCAFE_PATH_ROOT` when
/// set (must exist and pass [pathRootRejection] — see there for the hardening
/// rules), else the working directory. The returned root is canonical
/// (symlinks resolved), so containment checks compare like with like. The
/// `null` return ("guard off") is reserved for the commented off-switch below
/// and currently unreachable. [cwd] is injectable for tests; it defaults to
/// the process working directory.
String? resolvePathRoot({
  required Map<String, String> env,
  String? cwd,
  // bool unsafeFlag = false,
}) {
  // The disabled off-switches (see the module note above):
  // if (unsafeFlag) return null;
  // final envUnsafe = (env['SLOPCAFE_UNSAFE_PATHS'] ?? '').toLowerCase();
  // if (envUnsafe == '1' || envUnsafe == 'true' || envUnsafe == 'yes') {
  //   return null;
  // }
  final canonicalCwd =
      (cwd != null ? Directory(cwd) : Directory.current)
          .resolveSymbolicLinksSync();
  final override = env['SLOPCAFE_PATH_ROOT'];
  if (override == null || override.isEmpty) return canonicalCwd;
  final d = Directory(override);
  if (!d.existsSync()) {
    throw CliException.usage(
      'SLOPCAFE_PATH_ROOT does not exist: $override',
      fields: {'path_root': override},
    );
  }
  final root = d.resolveSymbolicLinksSync();
  final rejection =
      pathRootRejection(root, cwd: canonicalCwd, home: _canonicalHome(env));
  if (rejection != null) {
    throw CliException.usage('$rejection: $override',
        fields: {'path_root': override});
  }
  return root;
}

/// Pure validation of an explicit `SLOPCAFE_PATH_ROOT` choice, so the widening
/// knob can't be spelled into an off-switch. All paths must be canonical.
/// Returns the rejection reason, or `null` when the root is acceptable:
///
/// - the CWD itself is always fine (same scope as the default — not a widening);
/// - the filesystem root (`/`, a bare drive root) is refused — an unbounded
///   "root" is exactly the off-switch this knob must not become;
/// - the root must be an ancestor or descendant of the CWD, so an unrelated
///   subtree (`/etc`, another user's tree) can't be named at all;
/// - the root must not contain the home directory — `$HOME` holds the crown
///   jewels (`~/.ssh`, keychains, browser profiles), so widening stops below
///   it (e.g. `~/Repos` is grantable, `~` itself is not).
///
/// [separator] / [caseInsensitive] default to the platform's, overridable so
/// tests can pin both behaviors on any host.
String? pathRootRejection(
  String root, {
  required String cwd,
  String? home,
  String? separator,
  bool? caseInsensitive,
}) {
  final sep = separator ?? Platform.pathSeparator;
  final ci = caseInsensitive ?? Platform.isWindows;
  String norm(String p) {
    var s = ci ? p.toLowerCase() : p;
    while (s.length > 1 && s.endsWith(sep)) {
      s = s.substring(0, s.length - 1);
    }
    return s;
  }

  bool within(String a, String b) =>
      isWithinRoot(a, b, separator: sep, caseInsensitive: false);

  final r = norm(root), c = norm(cwd);
  if (r == c) return null;
  if (_isFilesystemRoot(r, sep)) {
    return 'SLOPCAFE_PATH_ROOT must not be the filesystem root';
  }
  if (!within(c, r) && !within(r, c)) {
    return 'SLOPCAFE_PATH_ROOT must be an ancestor or descendant of the '
        'working directory';
  }
  if (home != null && within(norm(home), r)) {
    return 'SLOPCAFE_PATH_ROOT must not contain the home directory';
  }
  return null;
}

/// `/` on POSIX; a bare drive root (`C:` / `C:\`) on Windows. Input is
/// expected trailing-separator-trimmed but this re-trims defensively.
bool _isFilesystemRoot(String root, String sep) {
  var r = root;
  while (r.length > 1 && r.endsWith(sep)) {
    r = r.substring(0, r.length - 1);
  }
  if (r == sep) return true;
  return RegExp(r'^[A-Za-z]:$').hasMatch(r);
}

/// The canonical home directory from [env] (`HOME`, or `USERPROFILE` on
/// Windows), or `null` when unset/nonexistent.
String? _canonicalHome(Map<String, String> env) {
  final home = env['HOME'] ?? env['USERPROFILE'];
  if (home == null || home.isEmpty) return null;
  final d = Directory(home);
  if (!d.existsSync()) return null;
  return d.resolveSymbolicLinksSync();
}

/// Pure containment check over two **canonical** paths. [separator] /
/// [caseInsensitive] default to the platform's, overridable so tests can pin
/// both behaviors on any host.
bool isWithinRoot(
  String resolved,
  String root, {
  String? separator,
  bool? caseInsensitive,
}) {
  final sep = separator ?? Platform.pathSeparator;
  var a = resolved, b = root;
  if (caseInsensitive ?? Platform.isWindows) {
    a = a.toLowerCase();
    b = b.toLowerCase();
  }
  // Trim a trailing separator off the root ('/'-rooted confinement means
  // "anything absolute", which the startsWith below then grants).
  while (b.length > 1 && b.endsWith(sep)) {
    b = b.substring(0, b.length - 1);
  }
  if (b == sep) return a.startsWith(sep);
  return a == b || a.startsWith('$b$sep');
}

/// Validate an **input** file path against [root] and return the canonical
/// path to read (symlinks resolved, so a link pointing outside the root is
/// caught AND the read targets what was checked). `root == null` = guard off,
/// path returned unchanged. Missing file → usage error either way.
String guardInputPath(String path, {required String? root}) {
  final f = File(path);
  if (!f.existsSync()) {
    throw CliException.usage('no such file: $path', fields: {'path': path});
  }
  if (root == null) return path;
  final resolved = f.resolveSymbolicLinksSync();
  if (!isWithinRoot(resolved, root)) {
    throw _escapesRoot(path, resolved, root);
  }
  return resolved;
}

/// Validate an **output** file path against [root] and return the canonical
/// path to write. An existing file is resolved directly (so a symlink pointing
/// outside the root can't smuggle the write out); a new file resolves its
/// parent directory, which must exist. `root == null` = guard off, path
/// returned unchanged.
String guardOutputPath(String path, {required String? root}) {
  if (root == null) return path;
  final f = File(path);
  final String resolved;
  if (f.existsSync()) {
    resolved = f.resolveSymbolicLinksSync();
  } else {
    final parent = f.parent;
    if (!parent.existsSync()) {
      throw CliException.usage(
        'no such directory: ${parent.path}',
        fields: {'path': path},
      );
    }
    final name = _basename(path);
    if (name.isEmpty || name == '.' || name == '..') {
      throw CliException.usage('invalid output path: $path',
          fields: {'path': path});
    }
    resolved = parent.resolveSymbolicLinksSync() + Platform.pathSeparator + name;
  }
  if (!isWithinRoot(resolved, root)) {
    throw _escapesRoot(path, resolved, root);
  }
  return resolved;
}

CliException _escapesRoot(String path, String resolved, String root) =>
    CliException.usage(
      'path escapes the allowed root: $path (resolves to $resolved, outside '
      '$root). File access is confined to the working directory — set '
      'SLOPCAFE_PATH_ROOT to an ancestor of the working directory to widen '
      'the root.',
      fields: {'path': path, 'resolved': resolved, 'root': root},
    );

/// The final path segment, tolerant of trailing separators. Backslash is only
/// a separator on Windows (it's a legal filename byte on POSIX).
String _basename(String path) {
  bool isSep(String c) => c == '/' || (Platform.isWindows && c == r'\');
  var end = path.length;
  while (end > 0 && isSep(path[end - 1])) {
    end--;
  }
  var start = end;
  while (start > 0 && !isSep(path[start - 1])) {
    start--;
  }
  return path.substring(start, end);
}
