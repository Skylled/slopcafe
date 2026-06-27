// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

import 'dart:io';

import 'package:args/command_runner.dart';
import 'package:dio/dio.dart';
import 'package:slopcafe_cli/src/errors.dart';
import 'package:slopcafe_cli/src/runner.dart';

Future<void> main(List<String> args) async {
  final runner = SlopcafeRunner();
  try {
    exit(await runner.run(args));
  } on UsageException catch (e) {
    stderr.writeln(e.message);
    stderr.writeln();
    stderr.writeln(e.usage);
    exit(ExitCodes.usage);
  } on CliException catch (e) {
    stderr.writeln('✗ ${e.message}');
    exit(e.exitCode);
  } on DioException catch (e) {
    // Connection/transport failures (DNS, refused, timeout) — never a status
    // code, since the client treats every HTTP status as valid.
    stderr.writeln('✗ network error: ${e.message ?? e.type.name} (${e.requestOptions.uri})');
    exit(ExitCodes.failure);
  } on FileSystemException catch (e) {
    stderr.writeln('✗ ${e.message}${e.path != null ? ': ${e.path}' : ''}');
    exit(ExitCodes.failure);
  } catch (e) {
    // Catch-all so an unexpected error still terminates cleanly with a non-zero
    // code (never leaves a headless caller hanging). DioException is handled
    // above, so a credential-bearing exception can't reach this print.
    stderr.writeln('✗ unexpected error: $e');
    exit(ExitCodes.failure);
  }
}
