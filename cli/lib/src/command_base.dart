// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

import 'dart:io';

import 'package:args/command_runner.dart';

import 'client.dart';
import 'config.dart';
import 'errors.dart';
import 'output.dart';

/// Implemented by the runner so commands can reach the (injectable) process
/// environment without a hard dependency on the runner type. Keeping it an
/// interface lets tests drive a command with a stub environment.
abstract class HasEnv {
  Map<String, String> get env;
}

/// Shared base for every CLI command: exposes the parsed global options, an
/// [Output] sink, the resolved config, and a ready-built [SlopcafeClient].
abstract class SlopcafeCommand extends Command<int> {
  /// The global presentation flags (`--json/--quiet/--verbose/--no-color`).
  GlobalOptions get globals {
    final g = globalResults;
    if (g == null) return GlobalOptions();
    return GlobalOptions(
      json: g['json'] as bool? ?? false,
      quiet: g['quiet'] as bool? ?? false,
      verbose: g['verbose'] as bool? ?? false,
      color: g['color'] as bool? ?? true,
    );
  }

  Output get out => Output(globals);

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
      throw CliException(
        'malformed config at $path: ${e.message}',
        exitCode: ExitCodes.usage,
      );
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
  SlopcafeClient buildClient() {
    final c = resolveConfig();
    out.detail('base: ${c.baseUrl}  profile: ${c.profile}  key: ${redactKey(c.key)}');
    return SlopcafeClient(baseUrl: c.baseUrl, key: c.key);
  }

  /// Read body bytes from a file path, or from stdin when [path] is `-`.
  Future<List<int>> readInput(String path) async {
    if (path == '-') {
      final bytes = <int>[];
      await for (final chunk in stdin) {
        bytes.addAll(chunk);
      }
      return bytes;
    }
    final f = File(path);
    if (!f.existsSync()) {
      throw CliException('no such file: $path', exitCode: ExitCodes.usage);
    }
    return f.readAsBytesSync();
  }

  /// Write a read result to `-o <file>` if given, else to stdout.
  void emitBody(List<int> body, String? outPath) {
    if (outPath == null) {
      out.bytes(body);
    } else {
      File(outPath).writeAsBytesSync(body);
      out.note('wrote ${body.length} bytes to $outPath');
    }
  }

  /// A short sha256 head for human display.
  String shortSha(String? sha) =>
      (sha == null || sha.length < 8) ? (sha ?? '—') : sha.substring(0, 12);
}
