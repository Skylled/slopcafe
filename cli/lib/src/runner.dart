// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

import 'dart:io';

import 'package:args/command_runner.dart';
import 'package:dio/dio.dart';

import 'command_base.dart';
import 'commands/config_cmd.dart';
import 'commands/edit.dart';
import 'commands/find.dart';
import 'commands/get.dart';
import 'commands/health.dart';
import 'commands/links.dart';
import 'commands/list.dart';
import 'commands/pack.dart';
import 'commands/publish.dart';
import 'commands/read.dart';
import 'commands/search.dart';
import 'commands/spec.dart';
import 'commands/update.dart';
import 'output.dart';

/// This CLI's own version.
///
/// **Source of truth.** `pubspec.yaml`'s `version:` field must mirror it —
/// the pubspec value only surfaces via `dart pub global list`, but an operator
/// debugging "which build is installed?" must not get two different answers.
/// The constant leads because Dart can't read the pubspec at runtime without a
/// build step, and `test/version_test.dart` fails the suite if the two drift.
const cliVersion = '0.4.0';

/// The API contract version the bundled `lib/api/` model layer was generated
/// from (kept in `tool/CONTRACT_VERSION`).
const contractVersion = '1.5.0';

/// The Slopcafe CLI command runner. Owns the global flags and registers the
/// agent-key command surface. Implements [HasEnv] (so commands read an
/// injectable environment) and [HasCommandIo] (so a test can hand the whole
/// command layer a pre-built transport and captured output streams instead of a
/// real socket and the real process streams). Production passes none of them and
/// every seam falls back to the process default.
class SlopcafeRunner extends CommandRunner<int> implements HasEnv, HasCommandIo {
  SlopcafeRunner({
    Map<String, String>? env,
    this.dio,
    this.stdoutSink,
    this.stderrSink,
  })  : env = env ?? Platform.environment,
      super(
        'slopcafe',
        'Command-line client for the Slopcafe agent web host (agent-key HTTP surface).',
      ) {
    argParser
      ..addOption('base',
          help: 'Base URL. Env: SLOPCAFE_BASE / AWH_BASE. Default: https://slopcafe.com.')
      ..addOption('key',
          help: 'Agent key (awh_…). Env: SLOPCAFE_KEY / AWH_KEY.')
      ..addOption('profile', help: 'Config profile to use. Env: SLOPCAFE_PROFILE.')
      ..addFlag('json',
          negatable: false, help: 'Machine-readable JSON output (for headless use).')
      ..addFlag('quiet',
          abbr: 'q', negatable: false, help: 'Suppress progress notes on stderr.')
      ..addFlag('verbose',
          abbr: 'v', negatable: false, help: 'Extra diagnostics on stderr.')
      ..addFlag('color',
          defaultsTo: true, help: 'Allow ANSI color (use --no-color to disable).')
      ..addOption('timeout',
          valueHelp: 'seconds',
          help: 'Per-request transfer budget (default 60s; connect is capped at '
              '15s). A timeout exits 75 (retryable).')
      // `--unsafe-paths` (disable path confinement) is deliberately NOT
      // registered: it would hand any sandboxed agent a free escape hatch.
      // If a real need appears, restore this flag, the SLOPCAFE_UNSAFE_PATHS
      // check in paths.dart, and the plumbing in command_base's `pathRoot`.
      // ..addFlag('unsafe-paths',
      //     negatable: false,
      //     help: 'Allow file arguments (<file>, -o) outside the working '
      //         'directory. By default they are confined to the CWD (or '
      //         r'$SLOPCAFE_PATH_ROOT) so a sandboxed agent cannot reach '
      //         'arbitrary local paths.')
      ..addFlag('version',
          negatable: false, help: 'Print the CLI version and exit.');

    addCommand(PublishCommand());
    addCommand(UpdateCommand());
    addCommand(EditCommand());
    addCommand(ReadCommand());
    addCommand(GetCommand());
    addCommand(ListCommand());
    addCommand(SearchCommand());
    addCommand(PackCommand());
    addCommand(FindCommand());
    addCommand(LinksCommand());
    addCommand(HealthCommand());
    addCommand(WhoamiCommand());
    addCommand(SpecCommand());
    addCommand(ConfigCommand());
  }

  @override
  final Map<String, String> env;

  @override
  final Dio? dio;

  @override
  final IOSink? stdoutSink;

  @override
  final IOSink? stderrSink;

  GlobalOptions _globals = GlobalOptions();

  /// The global options parsed during [run], stashed on the runner so the
  /// top-level error handler in `bin/slopcafe.dart` can consult them **after** a
  /// command has thrown. Without this seam the process could not know whether
  /// `--json` was requested at the moment it has to report a failure, so
  /// `--json` would silently never apply to errors — the whole point of the
  /// machine error envelope. Defaults to the plain (prose) options before
  /// [run] has parsed anything.
  GlobalOptions get globalOptions => _globals;

  /// The [Output] the **top-level** error handler reports through (see
  /// `runSlopcafe` in entrypoint.dart): the globals stashed by [run] plus this
  /// runner's own streams, so a failure is rendered to the same place a result
  /// would have been.
  Output get output =>
      Output(_globals, stdoutSink: stdoutSink, stderrSink: stderrSink);

  @override
  Future<int> run(Iterable<String> args) async {
    // Best-effort pre-parse pass FIRST: a bad flag makes `parse` throw before
    // any ArgResults exist, and a usage error still deserves the machine
    // envelope when the caller asked for JSON. `--json` is valueless,
    // non-negatable and un-abbreviated, so its literal presence in argv is an
    // unambiguous request for JSON mode. (The one false positive — `--base
    // --json`, i.e. `--json` consumed as another flag's value — costs nothing:
    // that invocation is a usage error either way.)
    _globals = GlobalOptions(json: args.contains('--json'));
    final results = parse(args);
    _globals = GlobalOptions.fromResults(results);
    if (results['version'] as bool? ?? false) {
      // Through the seam, not the bare `stdout`, so `--version` lands wherever
      // the rest of this runner's output does.
      (stdoutSink ?? stdout)
          .writeln('slopcafe $cliVersion (contract $contractVersion)');
      return 0;
    }
    return (await runCommand(results)) ?? 0;
  }
}
