// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/// Test harness for the **command/runner layer**.
///
/// `client_test.dart` proves the client shapes the right *request*; this drives
/// the layer above it — argv → command → client → `Output` → exit code — the
/// seam where every `--json` / `-o` / exit-code decision actually lives.
///
/// Nothing here touches the network or the process streams. A [CliSandbox]
/// builds its own [SlopcafeRunner] per invocation with:
///   * an injected [Dio] whose adapter answers from a canned reply table and
///     records what was sent (so header/query-string assertions are on the real
///     `RequestOptions`, not on a mock of our own client);
///   * captured stdout/stderr sinks;
///   * a stub environment — no real config file, no real key, a base URL that
///     resolves nowhere.
///
/// A **fresh Dio per invocation** is deliberate, not incidental: commands
/// `close()` their client in a `finally`, and dio refuses every request after
/// `close()`, so a shared instance would fail the second command with a
/// confusing connection error. One invocation = one transport, exactly like one
/// process.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:slopcafe_cli/src/entrypoint.dart';
import 'package:slopcafe_cli/src/runner.dart';

/// Answers one request. Returning is the normal path; *throwing* a
/// [DioException] is how a transport failure (timeout, connection error) is
/// simulated — that is what dio itself does, so the CLI's funnel sees the real
/// thing.
typedef ReplyHandler = FutureOr<ResponseBody> Function(RequestOptions req);

/// One recorded request: what the CLI actually put on the wire.
class Call {
  Call(this.request, this.body);

  final RequestOptions request;

  /// The request body bytes (streamed — the byte-exact publish path sends a
  /// `Stream`, so this is folded back exactly as the server would receive it).
  final List<int> body;

  String get method => request.method;
  String get path => request.path;

  /// Query parameters as the wire carries them (all strings).
  Map<String, String> get query => request.uri.queryParameters;

  String get text => utf8.decode(body, allowMalformed: true);

  /// Case-insensitive header lookup (`dart:io` treats header names that way,
  /// and the client sets a mix of casings).
  String? header(String name) {
    final lower = name.toLowerCase();
    for (final e in request.headers.entries) {
      if (e.key.toLowerCase() == lower) return e.value?.toString();
    }
    return null;
  }

  bool hasHeader(String name) =>
      request.headers.keys.any((k) => k.toLowerCase() == name.toLowerCase());

  @override
  String toString() => '$method $path ${query.isEmpty ? '' : query}';
}

/// The outcome of one CLI invocation: the exit code the process would have
/// returned, plus both captured streams.
class CliResult {
  CliResult({
    required this.exitCode,
    required this.stdout,
    required this.stderr,
    required this.calls,
  });

  final int exitCode;
  final String stdout;
  final String stderr;
  final List<Call> calls;

  /// The result object a `--json` command wrote to stdout.
  Map<String, dynamic> get stdoutJson =>
      jsonDecode(stdout) as Map<String, dynamic>;

  /// The `--json` **error envelope** from stderr. stderr may also carry notes
  /// (`• …`), and the envelope is always written last, so this decodes from the
  /// first line that starts an object.
  Map<String, dynamic> get errorEnvelope {
    final start = stderr.indexOf(RegExp(r'^\{', multiLine: true));
    if (start < 0) {
      throw StateError('no JSON error envelope on stderr:\n$stderr');
    }
    return jsonDecode(stderr.substring(start)) as Map<String, dynamic>;
  }

  /// The first recorded request whose path matches, or null.
  Call? callTo(String path) {
    for (final c in calls) {
      if (c.path == path) return c;
    }
    return null;
  }

  Call get lastCall => calls.last;

  /// Included in `expect` failure messages — a bare "expected 1, got 64" is
  /// useless without the stderr that explains it.
  @override
  String toString() =>
      'exit $exitCode\n--- stdout ---\n$stdout--- stderr ---\n$stderr'
      '--- requests ---\n${calls.join('\n')}\n';
}

/// One or more CLI invocations against canned replies, in a scratch directory
/// under the working directory (so `-o <file>` passes path confinement without
/// mutating the process CWD, which is global and shared with other suites).
class CliSandbox {
  CliSandbox({Map<String, String> extraEnv = const {}})
      : dir = _tempUnderCwd(),
        _extraEnv = extraEnv;

  /// The base URL the stub environment configures. Nothing ever resolves it —
  /// the injected adapter answers first — but it must be a well-formed absolute
  /// https URL or `assertUsableBaseUrl` rejects it up front.
  static const baseUrl = 'https://test.example';

  final Directory dir;
  final Map<String, String> _extraEnv;

  static Directory _tempUnderCwd() {
    final parent = Directory('.dart_tool/slopcafe_cli_tests')
      ..createSync(recursive: true);
    return parent.createTempSync('run_');
  }

  /// The stub environment: a config home with no config file in it (so
  /// `loadConfigFile` finds nothing and the operator's real profile can never
  /// leak into a test), plus the base/key the tests assume.
  Map<String, String> get env => {
        'XDG_CONFIG_HOME': '${dir.path}/config',
        'HOME': dir.path,
        'SLOPCAFE_BASE': baseUrl,
        'SLOPCAFE_KEY': 'awh_test',
        ..._extraEnv,
      };

  /// Absolute-ish path of [name] inside the sandbox (relative to the CWD, which
  /// is what a caller would type).
  String path(String name) => '${dir.path}/$name';

  /// Write a fixture file into the sandbox and return the path to pass on argv.
  String writeFile(String name, String contents) {
    final f = File(path(name))..writeAsStringSync(contents);
    return f.path;
  }

  String readFile(String name) => File(path(name)).readAsStringSync();

  bool exists(String name) => File(path(name)).existsSync();

  /// Run the CLI once. [reply] answers the requests the command makes; the
  /// default answers nothing (any request is reported as an unstubbed 599, so a
  /// command that unexpectedly hits the wire fails loudly rather than silently).
  Future<CliResult> run(List<String> args, {ReplyHandler? reply}) async {
    final calls = <Call>[];
    final dio = Dio(
      BaseOptions(
        baseUrl: baseUrl,
        validateStatus: (_) => true,
        followRedirects: false,
      ),
    )..httpClientAdapter = _FakeAdapter(reply ?? unstubbed, calls);
    final out = _MemorySink();
    final err = _MemorySink();
    final runner = SlopcafeRunner(
      env: env,
      dio: dio,
      stdoutSink: out,
      stderrSink: err,
    );
    // `--no-color` keeps the captured prose free of ANSI wherever the parsed
    // globals are consulted. (The sinks strip escapes anyway, because the
    // pre-parse usage path can't know the flag yet — see GlobalOptions in the
    // runner.)
    final code = await runSlopcafe(runner, ['--no-color', ...args]);
    return CliResult(
      exitCode: code,
      stdout: out.text,
      stderr: err.text,
      calls: calls,
    );
  }

  void dispose() {
    if (dir.existsSync()) dir.deleteSync(recursive: true);
  }
}

/// A JSON reply (the shape every `/d`, `/d/search`, `/d/pack`, `/source`,
/// `/healthz` route answers with).
ResponseBody jsonReply(
  Object? body, {
  int status = 200,
  Map<String, List<String>> headers = const {},
}) =>
    ResponseBody.fromString(
      jsonEncode(body),
      status,
      headers: {
        Headers.contentTypeHeader: ['application/json'],
        ...headers,
      },
    );

/// A body reply (`/d/:id/raw`, `/d/:id/text`, `/s/:slug`) — bytes plus the
/// headers the read envelope is built from.
ResponseBody bodyReply(
  String body, {
  int status = 200,
  String contentType = 'text/markdown; charset=utf-8',
  int? version,
  String? sanitizerV,
  String? converterV,
  Map<String, List<String>> headers = const {},
}) =>
    ResponseBody.fromString(
      body,
      status,
      headers: {
        Headers.contentTypeHeader: [contentType],
        if (version != null) 'etag': ['"v$version"'],
        if (sanitizerV != null) 'x-sanitizer-version': [sanitizerV],
        if (converterV != null) 'x-converter-version': [converterV],
        ...headers,
      },
    );

/// Dispatch by `'<METHOD> <path>'` or by bare `'<path>'`; an unmatched request
/// falls through to [unstubbed] so it surfaces in the output instead of
/// silently answering 200.
ReplyHandler routes(Map<String, ResponseBody> table) => (req) {
      final byMethod = table['${req.method} ${req.path}'];
      if (byMethod != null) return byMethod;
      final byPath = table[req.path];
      if (byPath != null) return byPath;
      return unstubbed(req);
    };

/// The default answer for a request no test stubbed: a distinctive 5xx whose
/// message names the offending call, so a wrong-path bug reads as
/// "unstubbed: GET /d/x" in the captured stderr rather than as a mystery.
ResponseBody unstubbed(RequestOptions req) => jsonReply(
      {
        'error': 'internal',
        'message': 'unstubbed request: ${req.method} ${req.path}',
      },
      status: 599,
    );

class _FakeAdapter implements HttpClientAdapter {
  _FakeAdapter(this.handler, this.calls);

  final ReplyHandler handler;
  final List<Call> calls;

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    final body = requestStream == null
        ? const <int>[]
        : await requestStream.fold<List<int>>(<int>[], (a, b) => a..addAll(b));
    calls.add(Call(options, body));
    return await handler(options);
  }

  @override
  void close({bool force = false}) {}
}

/// An [IOSink] that accumulates in memory. ANSI escapes are stripped on read so
/// an assertion never depends on whether the suite happened to run on a TTY.
class _MemorySink implements IOSink {
  final BytesBuilder _buf = BytesBuilder(copy: false);

  static final _ansi = RegExp(r'\x1B\[[0-9;]*m');

  String get text => utf8.decode(_buf.toBytes(), allowMalformed: true)
      .replaceAll(_ansi, '');

  @override
  Encoding encoding = utf8;

  @override
  void add(List<int> data) => _buf.add(data);

  @override
  void write(Object? object) => _buf.add(encoding.encode('$object'));

  @override
  void writeln([Object? object = '']) => write('$object\n');

  @override
  void writeAll(Iterable<dynamic> objects, [String separator = '']) =>
      write(objects.join(separator));

  @override
  void writeCharCode(int charCode) => write(String.fromCharCode(charCode));

  @override
  void addError(Object error, [StackTrace? stackTrace]) =>
      throw StateError('unexpected sink error: $error');

  @override
  Future<void> addStream(Stream<List<int>> stream) => stream.forEach(add);

  @override
  Future<void> flush() async {}

  @override
  Future<void> close() async {}

  @override
  Future<void> get done => Future<void>.value();
}
