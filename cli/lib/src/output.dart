// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

import 'dart:convert';
import 'dart:io';

/// The global presentation flags, parsed once from the top-level results and
/// threaded to every command.
class GlobalOptions {
  GlobalOptions({
    this.json = false,
    this.quiet = false,
    this.verbose = false,
    this.color = true,
  });

  /// Emit machine-readable JSON (the raw contract envelope where one exists)
  /// instead of human prose. The right mode for headless agents.
  final bool json;

  /// Suppress non-essential stderr chatter (progress/notes). Errors still print.
  final bool quiet;

  /// Extra diagnostics on stderr (resolved base/profile, request notes).
  final bool verbose;

  /// Allow ANSI color on a TTY.
  final bool color;
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

  /// Print a result. In `--json` mode the [json] object is encoded to stdout;
  /// otherwise [human] is called to build the prose form. [human] is a closure
  /// so the (often multi-line) human string isn't built in JSON mode.
  void result(Object? json, String Function() human) {
    if (opts.json) {
      _out.writeln(const JsonEncoder.withIndent('  ').convert(json));
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

  String _paint(String s, String code) => _useColor ? '\x1b[${code}m$s\x1b[0m' : s;
  String _dim(String s) => _useColor ? '\x1b[2m$s\x1b[0m' : s;
}
