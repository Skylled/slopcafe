// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

import 'dart:convert';
import 'dart:io';

import 'package:args/args.dart';

import 'errors.dart';

/// The global options, parsed once from the top-level results and threaded to
/// every command. Mostly presentation; [timeout] is the one transport knob that
/// belongs here because it is global rather than per-command.
class GlobalOptions {
  GlobalOptions({
    this.json = false,
    this.quiet = false,
    this.verbose = false,
    this.color = true,
    this.timeout,
  });

  /// Parse the global flags out of the top-level [ArgResults]. The single
  /// source of truth for that mapping — used both by [SlopcafeCommand.globals]
  /// (per command) and by the runner, which stashes the result so the
  /// top-level error handler in `bin/` knows whether `--json` was requested
  /// before any command threw.
  factory GlobalOptions.fromResults(ArgResults? r) {
    if (r == null) return GlobalOptions();
    return GlobalOptions(
      json: r['json'] as bool? ?? false,
      quiet: r['quiet'] as bool? ?? false,
      verbose: r['verbose'] as bool? ?? false,
      color: r['color'] as bool? ?? true,
      timeout: _parseTimeout(r['timeout'] as String?),
    );
  }

  /// Emit machine-readable JSON (the raw contract envelope where one exists)
  /// instead of human prose. The right mode for headless agents. Also switches
  /// **errors** to the JSON error envelope on stderr (see [Output.fatal]).
  final bool json;

  /// Suppress non-essential stderr chatter (progress/notes). Errors still print.
  final bool quiet;

  /// Extra diagnostics on stderr (resolved base/profile, request notes).
  final bool verbose;

  /// Allow ANSI color on a TTY.
  final bool color;

  /// `--timeout <seconds>`: the per-request transfer budget. Null = the
  /// client's defaults (see `SlopcafeClient.defaultTransferTimeout`).
  final Duration? timeout;

  static Duration? _parseTimeout(String? raw) {
    if (raw == null || raw.isEmpty) return null;
    final seconds = int.tryParse(raw);
    if (seconds == null || seconds <= 0) {
      throw CliException.usage(
        '--timeout must be a positive whole number of seconds (got "$raw")',
      );
    }
    return Duration(seconds: seconds);
  }
}

/// Output sink for a command. Convention: the command's **primary result**
/// (document body, JSON envelope) goes to **stdout**; status/notes/errors go to
/// **stderr** — so `slopcafe read … > out.md` captures only the content and a
/// pipeline can read clean data on stdout while a human still sees progress.
class Output {
  Output(this.opts, {IOSink? stdoutSink, IOSink? stderrSink})
    : _out = stdoutSink ?? stdout,
      _err = stderrSink ?? stderr;

  final GlobalOptions opts;
  final IOSink _out;
  final IOSink _err;

  bool get _useColor => opts.color && stdout.hasTerminal;

  /// The **one** encoding used for every machine-readable object the CLI emits
  /// — results (here), the error envelope ([fatal]), and the `-o <file>` copies
  /// written through `SlopcafeCommand.emitJson`. Single definition so a caller
  /// that reads stdout and a caller that reads the file get identical bytes.
  static String encodeJson(Object? json) =>
      const JsonEncoder.withIndent('  ').convert(json);

  /// Print a result. In `--json` mode the [json] object is encoded to stdout;
  /// otherwise [human] is called to build the prose form. [human] is a closure
  /// so the (often multi-line) human string isn't built in JSON mode.
  ///
  /// Commands with an `-o <file>` flag must NOT use this for their JSON branch
  /// — `-o` has to keep working in `--json` mode — see
  /// `SlopcafeCommand.emitJson`.
  void result(Object? json, String Function() human) {
    if (opts.json) {
      _out.writeln(encodeJson(json));
    } else {
      _out.writeln(human());
    }
  }

  /// Write raw content (a document body) verbatim to stdout — no trailing
  /// newline added, no JSON wrapping (content is not a result envelope).
  void content(String body) => _out.write(body);

  /// Write raw bytes to stdout (e.g. rendered HTML fetched as bytes).
  void bytes(List<int> data) => _out.add(data);

  /// A progress/status note on stderr (suppressed by `--quiet`).
  void note(String message) {
    if (!opts.quiet) _err.writeln(_dim('• $message'));
  }

  /// A verbose diagnostic on stderr (only with `--verbose`).
  void detail(String message) {
    if (opts.verbose) _err.writeln(_dim(message));
  }

  /// A warning on stderr (always shown unless `--quiet`).
  void warn(String message) {
    if (!opts.quiet) _err.writeln(_paint('⚠ $message', '33'));
  }

  /// An error on stderr (always shown).
  void error(String message) => _err.writeln(_paint('✗ $message', '31'));

  /// Report a **fatal** error — the one place a [CliException] is rendered.
  ///
  /// In `--json` mode this writes the machine error envelope
  /// ([CliException.toJson]) to **stderr**, so stdout stays reserved for the
  /// command's result and a headless caller can always parse `2>` with `jq`.
  /// Otherwise it prints the prose form: the plain message plus the usage block
  /// for an argv error, `✗ message` for everything else.
  ///
  /// stderr (not stdout) deliberately: a command that failed has no result, and
  /// mixing an error envelope into a stdout stream that a pipeline is reading
  /// as a document body / result envelope would corrupt it.
  void fatal(CliException e) {
    if (opts.json) {
      _err.writeln(encodeJson(e.toJson()));
      return;
    }
    if (e.usageText != null) {
      _err.writeln(e.message);
      _err.writeln();
      _err.writeln(e.usageText);
      return;
    }
    error(e.message);
  }

  String _paint(String s, String code) => _useColor ? '\x1b[${code}m$s\x1b[0m' : s;
  String _dim(String s) => _useColor ? '\x1b[2m$s\x1b[0m' : s;
}
