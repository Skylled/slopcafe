// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

import 'dart:io' show SocketException;

import 'package:dio/dio.dart';

import '../api/api.dart';

/// Process exit codes the CLI uses. The values follow the BSD `sysexits.h`
/// convention where one fits, so a calling agent/script can branch on them.
///
/// The full map — every code the process can return:
///
/// | Code | Constant       | Meaning                                             |
/// |------|----------------|-----------------------------------------------------|
/// | 0    | [ok]           | success                                              |
/// | 1    | [failure]      | the request/run failed for a reason with no code of its own (a 4xx the CLI can't classify further, an I/O error, an unexpected exception) |
/// | 64   | [usage]        | the **command line** was wrong (bad flag, missing/extra argument, a non-ASCII header value, a path outside the confinement root) — argv problems ONLY |
/// | 66   | [notFound]     | the server says the named document/slug does not exist (`404 not_found`, `410 gone`, or a slug that matches no live document) |
/// | 75   | [tempFail]     | a transient failure worth retrying: a timeout, a connection error, or a `408/429/5xx` from the origin |
/// | 77   | [noPermission] | authentication/authorization failed (no key, `401`, `403`) |
///
/// Coarse by design: the exit code answers "what class of thing went wrong",
/// and the machine-readable `error` code in the `--json` error envelope (see
/// [CliException.toJson]) answers "which one exactly". So e.g. `slug_taken`
/// (409) and `precondition_failed` (412) both exit `1` — a caller that needs to
/// tell them apart reads the envelope, which is precisely what `--json` is for.
class ExitCodes {
  ExitCodes._();

  /// Success.
  static const ok = 0;

  /// A generic runtime/API failure (a 4xx that isn't auth/not-found, an I/O
  /// error, an unexpected exception).
  static const failure = 1;

  /// The command line was wrong (bad flag, missing argument). `EX_USAGE`.
  ///
  /// Reserved for **argv** problems. "The document you named doesn't exist" is
  /// [notFound], not this — a harness that reads 64 as "the agent called the
  /// tool wrong" would otherwise retry with different flag spellings forever.
  static const usage = 64;

  /// The named document/slug does not exist (server `404 not_found` / `410
  /// gone`, or a client-side slug lookup that matched no live document).
  /// `EX_NOINPUT` — "the named input could not be opened". Both the slug path
  /// and the `public_id` path use this, so `slopcafe find x || create_it` can
  /// tell "missing" from "network down".
  static const notFound = 66;

  /// A transient failure: retrying the same request may well succeed. Timeouts,
  /// connection errors, and `408/429/5xx` from the origin all land here.
  /// `EX_TEMPFAIL`. Advisory only — for a non-idempotent write (publish/update)
  /// confirm the current state before retrying.
  static const tempFail = 75;

  /// Authentication/authorization failed — a missing or rejected key. The
  /// distinct code lets a headless caller tell "fix your key" from "bad
  /// request". `EX_NOPERM`.
  static const noPermission = 77;
}

/// Machine-readable error codes for failures the **CLI itself** originates —
/// the ones that never reached the server, or that have no wire code.
///
/// Every value is prefixed `cli_`, and no backend [ErrorCode] wire value uses
/// that prefix, so the `error` field of the JSON error envelope is unambiguous:
/// a bare snake_case code (`slug_taken`, `precondition_failed`, …) always means
/// "the server said no" and always carries a `status`; a `cli_*` code always
/// means "the CLI stopped before or around the request".
class CliErrorCodes {
  CliErrorCodes._();

  /// Bad command line (the [ExitCodes.usage] companion).
  static const usage = 'cli_usage';

  /// A slug resolved to no live document (client-side lookup, no wire error).
  static const notFound = 'cli_not_found';

  /// No agent key is configured.
  static const noKey = 'cli_no_key';

  /// The request timed out (connect/send/receive).
  static const timeout = 'cli_timeout';

  /// The connection failed or was severed (DNS, refused, reset, TLS).
  static const network = 'cli_network';

  /// The request was cancelled.
  static const cancelled = 'cli_cancelled';

  /// A local filesystem error (reading the input, writing `-o`).
  static const io = 'cli_io';

  /// The response was not the shape the contract promises.
  static const badResponse = 'cli_bad_response';

  /// The configured base URL is not a usable absolute http(s) origin.
  static const badBaseUrl = 'cli_bad_base_url';

  /// The configured base URL answers, but is not a Slopcafe instance.
  static const notSlopcafe = 'cli_not_slopcafe';

  /// An unexpected internal error (the catch-all).
  static const internal = 'cli_internal';
}

/// A fatal, already-explained CLI error: the human [message] has been composed
/// for the user, the [exitCode] is what the process should return, and the
/// machine-readable triple ([errorCode] / [status] / [fields]) is what a
/// headless caller reads. Thrown anywhere under a command and caught once at
/// the top of `bin/slopcafe.dart`.
///
/// The structured half is the point: an agent must be able to tell
/// "re-read and retry" (`precondition_failed`) from "pick another slug"
/// (`slug_taken`) from "give up" (`too_large`) **without regexing prose**.
class CliException implements Exception {
  CliException(
    this.message, {
    this.exitCode = ExitCodes.failure,
    this.errorCode = CliErrorCodes.internal,
    this.status,
    this.fields = const {},
    this.retryable = false,
    this.usageText,
  });

  /// Lift a typed [ApiError] (from the generated envelope glue) into a CLI
  /// error, **keeping the whole envelope**: the contract `error` code, the HTTP
  /// status, and every discriminant-specific context field the server supplied
  /// (`slug` on `slug_taken`, `expected`/`actual` on `integrity_mismatch`, the
  /// version context on `precondition_failed`, …).
  ///
  /// The human string leads with the server's own `message` when present, then
  /// the machine code in brackets so a prose-mode script can still grep for it.
  factory CliException.fromApi(ApiError error) {
    final code = error.code == ErrorCode.unknown ? null : error.code.wire;
    final status = error.statusCode;
    final detail = error.message ?? (code != null ? null : 'request failed');
    final parts = <String>[
      if (detail != null) detail,
      if (code != null) '[$code]',
      if (status != null) '(HTTP $status)',
    ];
    final transient = _isTransientStatus(status);
    return CliException(
      parts.join(' '),
      exitCode: _exitCodeForApi(error),
      // The envelope's `error` is never null. Preference order:
      //   1. the code this build's generated `ErrorCode` enum recognises;
      //   2. the RAW `error` string the body carried, when the backend has
      //      grown a code newer than `tool/CONTRACT_VERSION`. Erasing it to
      //      `cli_bad_response` would be an outright false claim — the `cli_`
      //      prefix is documented to mean "the CLI stopped before or around the
      //      request", and here the server answered with a decision. It also
      //      loses the only copy of that code: `toJson` filters the reserved
      //      `error` key out of the spread server fields;
      //   3. `cli_bad_response` when the body carried no code at all (a
      //      plain-text 4xx from a render/read route) — then `status` is the
      //      caller's branch key.
      errorCode: code ?? _rawWireCode(error) ?? CliErrorCodes.badResponse,
      status: status,
      fields: error.fields,
      retryable: transient,
    );
  }

  /// Lift a transport-level [DioException] (no HTTP status — the client treats
  /// every status as valid, so these are connect/send/receive failures only).
  /// A timeout is deliberately **distinct and retryable-looking**
  /// ([ExitCodes.tempFail] + `retryable: true`): a stalled Cloudflare/D1 flap is
  /// something a headless caller should ride out, not abort the run over.
  factory CliException.fromDio(DioException e) {
    final o = e.requestOptions;
    // dio's own timeout message is internal-facing ("raise the
    // RequestOptions.connectTimeout…"), so compose one that names the flag a
    // caller can actually turn.
    final (String code, String detail) = switch (e.type) {
      DioExceptionType.connectionTimeout => (
        CliErrorCodes.timeout,
        'timed out connecting after ${_secs(o.connectTimeout)} — the origin '
            'did not complete the handshake; retry, or raise --timeout',
      ),
      // NOT an idle bound: dio caps `addStream(body)` as a whole, so this fires
      // after `sendTimeout` of *total* upload time even while bytes are still
      // flowing. Say so, or the operator hunts a stall that isn't there.
      DioExceptionType.sendTimeout => (
        CliErrorCodes.timeout,
        'timed out sending the request body after ${_secs(o.sendTimeout)} — '
            'that bounds the whole upload, not the idle gap, so a large body on '
            'a slow link can hit it while still transferring; raise --timeout',
      ),
      DioExceptionType.receiveTimeout => (
        CliErrorCodes.timeout,
        'timed out waiting for the response after ${_secs(o.receiveTimeout)} '
            'of no data; retry, or raise --timeout',
      ),
      // A failed DNS lookup is a CONFIGURATION error, not a flap: the hostname
      // does not resolve and will not start resolving on its own. Retrying it
      // is the one case where `retryable: true` would send a harness into an
      // infinite loop over a typo'd --base, so it is separated out from the
      // refused/reset connections that genuinely are worth another attempt.
      DioExceptionType.connectionError when _isDnsFailure(e) => (
        CliErrorCodes.badBaseUrl,
        'could not resolve the host in ${o.uri.origin} — check --base / '
            'SLOPCAFE_BASE / the selected profile',
      ),
      DioExceptionType.connectionError => (
        CliErrorCodes.network,
        'could not reach the server: ${e.message ?? e.type.name}',
      ),
      DioExceptionType.cancel => (CliErrorCodes.cancelled, 'request cancelled'),
      _ => (CliErrorCodes.network, 'network error: ${e.message ?? e.type.name}'),
    };
    // Only a transient condition is worth another attempt. Cancellation was
    // asked for, and an unresolvable host is a misconfiguration — both exit 1
    // so a retry loop keyed on 75/EX_TEMPFAIL terminates.
    final permanent =
        code == CliErrorCodes.cancelled || code == CliErrorCodes.badBaseUrl;
    return CliException(
      '$detail (${o.uri})',
      exitCode: permanent ? ExitCodes.failure : ExitCodes.tempFail,
      errorCode: code,
      fields: {'uri': o.uri.toString()},
      retryable: !permanent,
    );
  }

  /// True when a connection error is really "that hostname does not resolve".
  /// `dart:io` reports it as a [SocketException] whose message begins with
  /// "Failed host lookup"; there is no typed DNS error to match on.
  static bool _isDnsFailure(DioException e) {
    final inner = e.error;
    final text = inner is SocketException ? inner.message : (e.message ?? '');
    return text.contains('Failed host lookup');
  }

  /// A command-line (argv) error. [usageText] is the `args` package's usage
  /// block, printed after the message in prose mode and carried as a `usage`
  /// field in the JSON envelope; [fields] adds machine-readable context (the
  /// offending `flag`, `path`, `root`, …) the same way a server envelope's
  /// discriminant fields do.
  ///
  /// **Prefer this over `CliException('…', exitCode: ExitCodes.usage)`**: the
  /// bare constructor defaults `errorCode` to `cli_internal`, so an argv
  /// mistake would report itself to a headless caller as an internal error.
  factory CliException.usage(
    String message, {
    String? usageText,
    Map<String, dynamic> fields = const {},
  }) =>
      CliException(
        message,
        exitCode: ExitCodes.usage,
        errorCode: CliErrorCodes.usage,
        fields: fields,
        usageText: usageText,
      );

  /// The composed human message (what prose mode prints).
  final String message;

  /// The process exit code (see [ExitCodes]).
  final int exitCode;

  /// The machine-readable code: a contract [ErrorCode] wire value when the
  /// server produced the failure, else one of [CliErrorCodes].
  final String errorCode;

  /// The HTTP status, when the failure came from a response.
  final int? status;

  /// The server's full decoded error envelope (empty for client-side errors).
  /// Its extra keys are spread into [toJson] verbatim.
  final Map<String, dynamic> fields;

  /// Whether retrying the same request is worth attempting (transient).
  final bool retryable;

  /// The usage block for an argv error (null otherwise).
  final String? usageText;

  /// Keys [toJson] owns. Server context fields that collide are dropped rather
  /// than allowed to overwrite the envelope's fixed shape — the envelope must
  /// be unambiguous even if the contract later grows a field named `status`.
  static const _reservedKeys = {
    'ok',
    'error',
    'message',
    'status',
    'exit_code',
    'retryable',
    'usage',
  };

  /// The **JSON error envelope**, written to stderr when `--json` is active.
  ///
  /// ```json
  /// {
  ///   "ok": false,
  ///   "error": "slug_taken",     // contract ErrorCode wire value, or a cli_* code
  ///   "message": "slug already in use",
  ///   "status": 409,             // omitted when the failure never reached HTTP
  ///   "exit_code": 1,
  ///   "retryable": false,
  ///   "slug": "q3-report"        // …then the server's own context fields, verbatim
  /// }
  /// ```
  ///
  /// Stability contract: `ok` is always `false`; `error`, `message`,
  /// `exit_code`, and `retryable` are always present; `status` is present iff a
  /// response was received; every other key comes straight from the server's
  /// error body (`slug`, `expected`/`actual`, `hint`, `limit`, `redirect_to`, …)
  /// and is exactly what `docs/http-api.md` documents for that code.
  ///
  /// `message` is the **server's own sentence** when there is one (the prose
  /// mode's `… [code] (HTTP n)` annotation is redundant once `error`/`status`
  /// are separate fields); it falls back to the CLI's composed line otherwise.
  Map<String, dynamic> toJson() {
    final serverMessage = fields['message'];
    return {
      'ok': false,
      'error': errorCode,
      'message': serverMessage is String && serverMessage.isNotEmpty
          ? serverMessage
          : message,
      if (status != null) 'status': status,
      'exit_code': exitCode,
      'retryable': retryable,
      for (final e in fields.entries)
        if (!_reservedKeys.contains(e.key)) e.key: e.value,
      if (usageText != null) 'usage': usageText,
    };
  }

  @override
  String toString() => message;
}

/// The one "that slug names no live document" error, shared by every path that
/// can produce it (`client.resolveDocId`, `slopcafe find`).
///
/// It is a [ExitCodes.notFound] — **not** [ExitCodes.usage] — even though the
/// slug came in on the command line: a caller must get the same code whether it
/// addressed the document by slug or by `public_id` (where the server's own
/// `404 not_found` decides), and 64 would tell a harness "you invoked the tool
/// wrong" when the truth is "the document isn't there".
CliException slugNotFound(String slug) => CliException(
  "no live document has the slug '$slug'",
  exitCode: ExitCodes.notFound,
  errorCode: CliErrorCodes.notFound,
  fields: {'slug': slug},
);

String _secs(Duration? d) => d == null ? 'the timeout' : '${d.inSeconds}s';

/// The body's own `error` string when the generated [ErrorCode] enum doesn't
/// know it — i.e. the backend shipped a code newer than this build's contract
/// pin. Guarded against a `cli_`-prefixed value so a (hypothetical) server code
/// can never impersonate a CLI-side one and break the prefix invariant.
String? _rawWireCode(ApiError error) {
  final raw = error.fields['error'];
  if (raw is! String || raw.isEmpty || raw.startsWith('cli_')) return null;
  return raw;
}

/// `408`/`429`/`5xx` are worth a retry; everything else the server says is a
/// decision, not a hiccup.
bool _isTransientStatus(int? status) =>
    status != null && (status == 408 || status == 429 || status >= 500);

int _exitCodeForApi(ApiError error) {
  final status = error.statusCode;
  if (status == 401 ||
      status == 403 ||
      error.code == ErrorCode.unauthorized) {
    return ExitCodes.noPermission;
  }
  if (status == 404 ||
      status == 410 ||
      error.code == ErrorCode.notFound ||
      error.code == ErrorCode.gone) {
    return ExitCodes.notFound;
  }
  if (_isTransientStatus(status)) return ExitCodes.tempFail;
  return ExitCodes.failure;
}
