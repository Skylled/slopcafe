// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

import 'dart:io';

import 'package:slopcafe_cli/src/entrypoint.dart';
import 'package:slopcafe_cli/src/runner.dart';

/// Entrypoint. All of the interesting behavior — the error funnel, the exit-code
/// mapping, the `--json` error envelope — lives in `runSlopcafe` so it can be
/// tested; the binary owns only the process-level act of exiting with its
/// answer.
Future<void> main(List<String> args) async {
  exit(await runSlopcafe(SlopcafeRunner(), args));
}
