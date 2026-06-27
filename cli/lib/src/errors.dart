// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

import '../api/api.dart';

/// Process exit codes the CLI uses. The values follow the BSD `sysexits.h`
/// convention where one fits, so a calling agent/script can branch on them.
class ExitCodes {
  ExitCodes._();

  /// Success.
  static const ok = 0;

  /// A generic runtime/API failure (a 4xx/5xx that isn't an auth problem,
  /// a network error, an I/O error, …).
  static const failure = 1;

  /// The command line was wrong (bad flag, missing argument). `EX_USAGE`.
  static const usage = 64;

  /// Authentication/authorization failed — a missing or rejected key. The
  /// distinct code lets a headless caller tell "fix your key" from "bad
  /// request". `EX_NOPERM`.
  static const noPermission = 77;
}

/// A fatal, already-explained CLI error: the message has been composed for the
/// user and the [exitCode] is what the process should return. Thrown anywhere
/// under a command and caught once at the top of `bin/slopcafe.dart`.
class CliException implements Exception {
  CliException(this.message, {this.exitCode = ExitCodes.failure});

  /// Lift a typed [ApiError] (from the generated envelope glue) into a CLI
  /// error, mapping the contract's auth codes / 401 to [ExitCodes.noPermission]
  /// and everything else to [ExitCodes.failure]. The human string leads with
  /// the server's own `message` when present, then the machine code in
  /// brackets so a script can still grep for it.
  factory CliException.fromApi(ApiError error) {
    final isAuth =
        error.statusCode == 401 ||
        error.statusCode == 403 ||
        error.code == ErrorCode.unauthorized;
    final code = error.code == ErrorCode.unknown ? null : error.code.wire;
    final status = error.statusCode;
    final detail = error.message ?? (code != null ? null : 'request failed');
    final parts = <String>[
      if (detail != null) detail,
      if (code != null) '[$code]',
      if (status != null) '(HTTP $status)',
    ];
    return CliException(
      parts.join(' '),
      exitCode: isAuth ? ExitCodes.noPermission : ExitCodes.failure,
    );
  }

  final String message;
  final int exitCode;

  @override
  String toString() => message;
}
