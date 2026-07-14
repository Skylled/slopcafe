// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

import 'dart:io';

import 'package:args/command_runner.dart';

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

/// This CLI's own version (independent of the package version field).
const cliVersion = '0.2.0';

/// The API contract version the bundled `lib/api/` model layer was generated
/// from (kept in `tool/CONTRACT_VERSION`).
const contractVersion = '1.5.0';

/// The Slopcafe CLI command runner. Owns the global flags and registers the
/// agent-key command surface. Implements [HasEnv] so commands can read an
/// (injectable) environment.
class SlopcafeRunner extends CommandRunner<int> implements HasEnv {
  SlopcafeRunner({Map<String, String>? env})
    : env = env ?? Platform.environment,
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
  Future<int> run(Iterable<String> args) async {
    final results = parse(args);
    if (results['version'] as bool? ?? false) {
      stdout.writeln('slopcafe $cliVersion (contract $contractVersion)');
      return 0;
    }
    return (await runCommand(results)) ?? 0;
  }
}
