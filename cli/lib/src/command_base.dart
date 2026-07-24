// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

import 'dart:convert';
import 'dart:io';

import 'package:args/command_runner.dart';
import 'package:dio/dio.dart';

import 'client.dart';
import 'config.dart';
import 'errors.dart';
import 'output.dart';
import 'paths.dart';

/// Implemented by the runner so commands can reach the (injectable) process
/// environment without a hard dependency on the runner type. Keeping it an
/// interface lets tests drive a command with a stub environment.
abstract class HasEnv {
  Map<String, String> get env;
}

/// Implemented by the runner so a command's **transport and output streams** can
/// be supplied from outside the process defaults. Every getter answering `null`
/// (what production does) is exactly the pre-seam behavior: open a real socket,
/// write to the real `stdout`/`stderr`.
///
/// It exists for testability, and deliberately so: the command layer is where
/// every `--json` / `-o` / exit-code decision is actually made, and without this
/// seam none of it could be exercised without hitting the network and the real
/// process streams. Keeping the seam on the *runner* (rather than, say, a
/// mutable static) means a test constructs its own runner and nothing global
/// changes — two suites can run concurrently without stepping on each other.
abstract class HasCommandIo {
  /// A pre-built transport for [SlopcafeCommand.buildClient], or `null` to open
  /// a real one. The client applies its own headers and timeout budgets to an
  /// injected Dio (see [SlopcafeClient]), so both paths behave identically.
  Dio? get dio;

  /// Where a command's primary result goes (`null` = the process `stdout`).
  IOSink? get stdoutSink;

  /// Where notes/warnings/errors go (`null` = the process `stderr`).
  IOSink? get stderrSink;
}

/// Shared base for every CLI command: exposes the parsed global options, an
/// [Output] sink, the resolved config, and a ready-built [SlopcafeClient].
abstract class SlopcafeCommand extends Command<int> {
  /// The global options (`--json/--quiet/--verbose/--no-color/--timeout`).
  /// Parsed by [GlobalOptions.fromResults] — the same mapping the runner
  /// stashes for the top-level error handler, so the two can't diverge.
  GlobalOptions get globals => GlobalOptions.fromResults(globalResults);

  Output get out => Output(
        globals,
        stdoutSink: _io?.stdoutSink,
        stderrSink: _io?.stderrSink,
      );

  /// The runner's IO seam, or null when the command is driven by something that
  /// doesn't offer one (then every stream is the process default).
  HasCommandIo? get _io => runner is HasCommandIo ? runner as HasCommandIo : null;

  /// The process environment (overridable for tests).
  Map<String, String> get env =>
      runner is HasEnv ? (runner as HasEnv).env : Platform.environment;

  /// Merge flags + env + config file into the effective settings.
  ResolvedConfig resolveConfig() {
    final g = globalResults;
    final path = configPathFor(env);
    ConfigFile? file;
    try {
      file = loadConfigFile(path);
    } on FormatException catch (e) {
      throw CliException.usage('malformed config at $path: ${e.message}');
    }
    return mergeConfig(
      baseFlag: g?['base'] as String?,
      keyFlag: g?['key'] as String?,
      profileFlag: g?['profile'] as String?,
      env: env,
      file: file,
    );
  }

  /// Build a client from the resolved config. The caller is responsible for
  /// `close()`ing it (the top-level `bin` does so in a finally).
  ///
  /// The base URL is validated here rather than in [resolveConfig] on purpose:
  /// `slopcafe config list` / `config set` must keep working on a broken base,
  /// since fixing it is exactly what the operator is there to do.
  SlopcafeClient buildClient() {
    final c = resolveConfig();
    assertUsableBaseUrl(c.baseUrl);
    out.detail('base: ${c.baseUrl}  profile: ${c.profile}  key: ${redactKey(c.key)}');
    return SlopcafeClient(
      baseUrl: c.baseUrl,
      key: c.key,
      timeout: globals.timeout,
      // Null in production → the client opens its own transport.
      dio: _io?.dio,
    );
  }

  /// The path-confinement root for file arguments (see paths.dart):
  /// `SLOPCAFE_PATH_ROOT` if set, else the working directory, canonicalized.
  /// There is deliberately no off-switch — the commented plumbing below is the
  /// re-add seam (with the flag in runner.dart and the checks in paths.dart).
  String? get pathRoot => resolvePathRoot(
        env: env,
        // unsafeFlag: globalResults?['unsafe-paths'] as bool? ?? false,
      );

  /// Read body bytes from a file path, or from stdin when [path] is `-`.
  /// File paths are confined to [pathRoot] (symlinks resolved), so a sandboxed
  /// agent can't upload arbitrary local files.
  Future<List<int>> readInput(String path) async {
    if (path == '-') {
      final bytes = <int>[];
      await for (final chunk in stdin) {
        bytes.addAll(chunk);
      }
      return bytes;
    }
    return File(guardInputPath(path, root: pathRoot)).readAsBytesSync();
  }

  /// Write a read result to `-o <file>` if given, else to stdout. File paths
  /// are confined to [pathRoot], like [readInput].
  void emitBody(List<int> body, String? outPath) {
    if (outPath == null) {
      out.bytes(body);
    } else {
      File(guardOutputPath(outPath, root: pathRoot)).writeAsBytesSync(body);
      out.note('wrote ${body.length} bytes to $outPath');
    }
  }

  /// Emit a machine-readable [json] object through the **same** sink as a body:
  /// `-o <file>` when given, else stdout.
  ///
  /// This exists because `Output.result` always writes to stdout, which made
  /// `-o` a silent no-op in `--json` mode on the two commands that have both
  /// (`read --as source`, `pack`) — the agent's next step then read a file that
  /// was never written, with exit 0 and no warning. Any command with an `-o`
  /// flag must route its JSON branch here, not through `out.result`.
  ///
  /// The trailing newline matches `Output.result`'s `writeln`, so the file and
  /// the stdout form are byte-identical.
  void emitJson(Object? json, String? outPath) =>
      emitBody(utf8.encode('${Output.encodeJson(json)}\n'), outPath);

  /// Parse an integer-valued option, or null when it wasn't passed. Shared so
  /// every numeric knob (`--limit`, `--budget`, `--max-docs`) reports the same
  /// usage error with the same exit code instead of each command rolling its
  /// own.
  int? intOption(String name) {
    final raw = argResults![name] as String?;
    if (raw == null || raw.isEmpty) return null;
    final n = int.tryParse(raw);
    if (n == null) throw CliException.usage('--$name must be an integer');
    return n;
  }

  /// A short sha256 head for human display.
  String shortSha(String? sha) =>
      (sha == null || sha.length < 8) ? (sha ?? '—') : sha.substring(0, 12);
}
