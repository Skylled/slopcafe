// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

import 'dart:io';

import 'package:args/command_runner.dart';
import 'package:dio/dio.dart';

import 'errors.dart';
import 'runner.dart';

/// Run the CLI and return the process exit code.
///
/// Every failure mode is funnelled into a single [CliException] and reported
/// once by [_fatal], so the exit code and the `--json` error envelope are
/// decided in exactly one place.
///
/// This lives in `lib/` rather than in `bin/main` on purpose: the funnel *is*
/// the CLI's machine contract (which exit code, prose-or-envelope, which
/// stream), and a `main` that calls `exit()` cannot be exercised by a test. The
/// binary keeps only what genuinely belongs to the process — constructing the
/// runner and handing this function's answer to `exit()`.
Future<int> runSlopcafe(SlopcafeRunner runner, List<String> args) async {
  try {
    return await runner.run(args);
  } on UsageException catch (e) {
    // argv problems keep EX_USAGE (64). In `--json` mode the envelope carries
    // the usage block too, so a headless caller loses nothing by the switch.
    return _fatal(runner, CliException.usage(e.message, usageText: e.usage));
  } on CliException catch (e) {
    return _fatal(runner, e);
  } on DioException catch (e) {
    // Connection/transport failures (DNS, refused, TLS, and — now that the
    // client sets budgets — timeouts). Never a status code, since the client
    // treats every HTTP status as valid.
    return _fatal(runner, CliException.fromDio(e));
  } on FileSystemException catch (e) {
    return _fatal(
      runner,
      CliException(
        '${e.message}${e.path != null ? ': ${e.path}' : ''}',
        errorCode: CliErrorCodes.io,
        fields: {if (e.path != null) 'path': e.path},
      ),
    );
  } catch (e) {
    // Catch-all so an unexpected error still terminates cleanly with a non-zero
    // code (never leaves a headless caller hanging). DioException is handled
    // above, so a credential-bearing exception can't reach this print.
    return _fatal(runner, CliException('unexpected error: $e'));
  }
}

/// Report [e] in the mode the caller asked for and yield its exit code. The
/// runner stashes the parsed global options during `run()`, which is what lets
/// this — after a command has already thrown — know whether `--json` was
/// requested.
int _fatal(SlopcafeRunner runner, CliException e) {
  runner.output.fatal(e);
  return e.exitCode;
}
