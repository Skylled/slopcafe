// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/// Command-layer tests: **the failure contract**.
///
/// What a headless caller actually branches on — the exit code, and (under
/// `--json`) the machine-readable error envelope on stderr. These run the whole
/// funnel end to end: argv → command → client → thrown error → `runSlopcafe` →
/// `Output.fatal` → exit code. `client_test.dart` proves a response maps to the
/// right `CliException`; this proves that exception reaches the process
/// boundary as the documented bytes and the documented number.
library;

import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:test/test.dart';

import 'support/cli_harness.dart';
import 'support/fixtures.dart';

void main() {
  late CliSandbox cli;

  setUp(() => cli = CliSandbox());
  tearDown(() => cli.dispose());

  group('the --json error envelope', () {
    test('a typed API error keeps its code, status and context fields',
        () async {
      // The whole point: an agent must tell "pick another slug" (slug_taken)
      // from "re-read and retry" (precondition_failed) WITHOUT regexing prose.
      final file = cli.writeFile('doc.md', '# Hi\n');
      final r = await cli.run(
        ['--json', 'publish', file, '--slug', 'q3-report'],
        reply: routes({
          'POST /d': jsonReply(
            errorBody('slug_taken', 'slug already in use',
                {'slug': 'q3-report'}),
            status: 409,
          ),
        }),
      );

      expect(r.exitCode, 1, reason: '$r');
      expect(r.stdout, isEmpty, reason: 'stdout stays clean for the result');
      final e = r.errorEnvelope;
      expect(e['ok'], isFalse);
      expect(e['error'], 'slug_taken');
      // The server's own sentence — the "[code] (HTTP n)" prose annotation is
      // redundant once code and status are their own fields.
      expect(e['message'], 'slug already in use');
      expect(e['status'], 409);
      expect(e['exit_code'], 1);
      expect(e['retryable'], isFalse);
      // …and the discriminant-specific context, spread verbatim.
      expect(e['slug'], 'q3-report');
    });

    test('a precondition failure is distinguishable from a slug conflict',
        () async {
      final file = cli.writeFile('doc.md', '# Hi\n');
      final r = await cli.run(
        [
          '--json', 'update', 'ABCDEFGHIJKLMNOPQRSTUV', file, //
          '--if-match', 'v1',
        ],
        reply: routes({
          'PUT /d/ABCDEFGHIJKLMNOPQRSTUV': jsonReply(
            errorBody('precondition_failed', 'version mismatch'),
            status: 412,
          ),
        }),
      );

      // Same exit code as slug_taken by design — the codes are coarse, the
      // envelope is exact. That split is what the README documents.
      expect(r.exitCode, 1, reason: '$r');
      expect(r.errorEnvelope['error'], 'precondition_failed');
      expect(r.errorEnvelope['status'], 412);
    });

    test('a 404 carries not_found and exits 66', () async {
      final r = await cli.run(
        ['--json', 'read', 'ABCDEFGHIJKLMNOPQRSTUV'],
        reply: routes({
          '/d/ABCDEFGHIJKLMNOPQRSTUV/text':
              jsonReply(errorBody('not_found', 'no such document'), status: 404),
        }),
      );

      expect(r.exitCode, 66, reason: '$r');
      expect(r.errorEnvelope['error'], 'not_found');
      expect(r.errorEnvelope['status'], 404);
      expect(r.errorEnvelope['retryable'], isFalse);
    });

    test('a non-JSON 404 still exits 66 (the status decides, not the body)',
        () async {
      // `/s/:slug/text` answers a plain-text 404, so there is no `error` field
      // to lift. The exit code is the guarantee; the envelope's `error` is
      // best-effort (today a cli_* fallback), which is why only the code and
      // the status are asserted here.
      final r = await cli.run(
        ['--json', 'read', 'never-claimed'],
        reply: routes({
          '/s/never-claimed/text':
              bodyReply('not found', status: 404, contentType: 'text/plain'),
        }),
      );

      expect(r.exitCode, 66, reason: '$r');
      expect(r.errorEnvelope['status'], 404);
    });

    test('a 5xx is marked retryable and exits 75 (ride out a flap)', () async {
      final r = await cli.run(
        ['--json', 'read', 'ABCDEFGHIJKLMNOPQRSTUV'],
        reply: routes({
          '/d/ABCDEFGHIJKLMNOPQRSTUV/text':
              jsonReply(errorBody('internal', 'upstream'), status: 503),
        }),
      );

      expect(r.exitCode, 75, reason: '$r');
      expect(r.errorEnvelope['retryable'], isTrue);
      expect(r.errorEnvelope['status'], 503);
    });

    test('a rejected key exits 77', () async {
      final r = await cli.run(
        ['--json', 'read', 'ABCDEFGHIJKLMNOPQRSTUV'],
        reply: routes({
          '/d/ABCDEFGHIJKLMNOPQRSTUV/text': jsonReply(
              errorBody('unauthorized', 'valid agent key required'),
              status: 401),
        }),
      );

      expect(r.exitCode, 77, reason: '$r');
      expect(r.errorEnvelope['error'], 'unauthorized');
    });
  });

  group('human mode still reads as prose', () {
    test('an API error is one ✗ line with the machine code in brackets',
        () async {
      final file = cli.writeFile('doc.md', '# Hi\n');
      final r = await cli.run(
        ['publish', file, '--slug', 'q3-report'],
        reply: routes({
          'POST /d': jsonReply(
            errorBody('slug_taken', 'slug already in use',
                {'slug': 'q3-report'}),
            status: 409,
          ),
        }),
      );

      expect(r.exitCode, 1, reason: '$r');
      expect(r.stderr, startsWith('✗ '));
      expect(r.stderr, contains('slug already in use'));
      expect(r.stderr, contains('[slug_taken]'));
      expect(r.stderr, contains('(HTTP 409)'));
      // Emphatically NOT JSON — the interactive user never sees an envelope.
      expect(() => jsonDecode(r.stderr), throwsFormatException);
    });

    test('a usage error is the message, a blank line, then the usage block',
        () async {
      final r = await cli.run(['--nope']);

      expect(r.exitCode, 64, reason: '$r');
      expect(r.stderr, contains('nope'));
      expect(r.stderr, contains('Usage: slopcafe'));
      expect(() => jsonDecode(r.stderr), throwsFormatException);
    });
  });

  group('exit codes', () {
    test('a slug that matches no live document is 66, not 64', () async {
      // 64 would tell a harness "you invoked the tool wrong" and invite it to
      // retry with different flag spellings; the truth is "it isn't there".
      final r = await cli.run(
        ['--json', 'find', 'no-such-slug'],
        reply: routes({'/d': jsonReply(listOk([]))}),
      );

      expect(r.exitCode, 66, reason: '$r');
      expect(r.errorEnvelope['error'], 'cli_not_found');
      expect(r.errorEnvelope['slug'], 'no-such-slug');
    });

    test('an unknown flag is 64 and carries the usage block in the envelope',
        () async {
      // The flag is rejected by `parse()`, before any ArgResults exist — the
      // runner's literal `--json` pre-scan is what still gets the caller an
      // envelope here.
      final r = await cli.run(['--nope', '--json']);

      expect(r.exitCode, 64, reason: '$r');
      final e = r.errorEnvelope;
      expect(e['error'], 'cli_usage');
      expect(e['exit_code'], 64);
      expect(e['usage'], contains('Usage: slopcafe'));
    });

    test('a missing argument is 64 with cli_usage (not cli_internal)', () async {
      // Command-level argv errors go through CliException.usage; the bare
      // constructor would have reported them to a headless caller as an
      // internal error.
      final r = await cli.run(['--json', 'search']);

      expect(r.exitCode, 64, reason: '$r');
      expect(r.errorEnvelope['error'], 'cli_usage');
      expect(r.errorEnvelope['message'], contains('search query'));
    });

    test('an unusable base URL is 64 and never reaches the wire', () async {
      final r = await cli.run(['--json', '--base', 'slopcafe.com', 'read', 'x']);

      expect(r.exitCode, 64, reason: '$r');
      expect(r.errorEnvelope['error'], 'cli_bad_base_url');
      expect(r.errorEnvelope['base'], 'slopcafe.com');
      expect(r.calls, isEmpty, reason: 'the key must not be sent anywhere');
    });
  });

  group('transport failures', () {
    test('a timeout is its own error type, retryable, exit 75', () async {
      // The failure that used to hang forever: connection accepted, response
      // never arrives. It must be distinguishable from a generic network fault
      // so a caller can retry rather than abort.
      final r = await cli.run(
        ['--json', 'read', 'q3-report'],
        reply: (req) => throw DioException.receiveTimeout(
          timeout: const Duration(seconds: 60),
          requestOptions: req,
        ),
      );

      expect(r.exitCode, 75, reason: '$r');
      final e = r.errorEnvelope;
      expect(e['error'], 'cli_timeout');
      expect(e['retryable'], isTrue);
      expect(e.containsKey('status'), isFalse, reason: 'no response arrived');
      // Names the flag the caller can actually turn, not dio's internal
      // "raise RequestOptions.receiveTimeout" text.
      expect(e['message'], contains('--timeout'));
    });

    test('a connection error is cli_network, also exit 75', () async {
      final r = await cli.run(
        ['--json', 'read', 'q3-report'],
        reply: (req) => throw DioException.connectionError(
          requestOptions: req,
          reason: 'connection refused',
        ),
      );

      expect(r.exitCode, 75, reason: '$r');
      expect(r.errorEnvelope['error'], 'cli_network');
      expect(r.errorEnvelope['retryable'], isTrue);
    });

    test('a timeout in human mode is prose, not an envelope', () async {
      final r = await cli.run(
        ['read', 'q3-report'],
        reply: (req) => throw DioException.receiveTimeout(
          timeout: const Duration(seconds: 60),
          requestOptions: req,
        ),
      );

      expect(r.exitCode, 75, reason: '$r');
      expect(r.stderr, startsWith('✗ '));
      expect(r.stderr, contains('timed out'));
    });
  });

  group('whoami verifies the host before it sends the key', () {
    test('a base that answers but is not Slopcafe is reported, not accepted',
        () async {
      // The regression: `statusCode != 401` read every other answer as success,
      // so a proxy that 200s everything printed "✓ key accepted" — after the
      // key had already gone to the wrong host.
      final r = await cli.run(
        ['--json', 'whoami'],
        reply: routes({'/healthz': jsonReply({'hello': 'world'})}),
      );

      expect(r.exitCode, 1, reason: '$r');
      expect(r.errorEnvelope['error'], 'cli_not_slopcafe');
      expect(r.calls, hasLength(1), reason: 'it stops at the health probe');
      expect(
        r.calls.single.hasHeader('Authorization'),
        isFalse,
        reason: 'the health probe is unauthenticated — the key stays home',
      );
    });

    test('a real instance that rejects the key exits 77 with the evidence',
        () async {
      final r = await cli.run(
        ['--json', 'whoami'],
        reply: routes({
          '/healthz': jsonReply(healthzOk()),
          '/d/AAAAAAAAAAAAAAAAAAAAAA/text':
              jsonReply(errorBody('unauthorized', 'nope'), status: 401),
        }),
      );

      expect(r.exitCode, 77, reason: '$r');
      // A rejection is a *result*, not an error: it goes to stdout as the
      // report of what was checked.
      final json = r.stdoutJson;
      expect(json['service'], 'slopcafe');
      expect(json['status'], 401);
      expect(json['accepted'], isFalse);
      expect(json['base'], CliSandbox.baseUrl);
    });
  });
}
