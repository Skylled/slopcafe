// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/// Command-layer tests for the two CLASSIFICATION verbs (`tags`, `status`).
///
/// The property that matters most here is negative: neither command may write a
/// body or append a version. The server defines both as no-version-bump changes,
/// and the reason they exist as commands at all is that the alternative —
/// re-tagging via `update` — costs a whole-body re-upload and burns a version.
/// So these assert the exact request shape, not just a happy exit code.
library;

import 'package:test/test.dart';

import 'support/cli_harness.dart';
import 'support/fixtures.dart';

void main() {
  late CliSandbox cli;

  setUp(() => cli = CliSandbox());
  tearDown(() => cli.dispose());

  group('tags', () {
    test('PUTs the tag list and writes no body, no version', () async {
      final r = await cli.run(
        ['--json', 'tags', 'ABCDEFGHIJKLMNOPQRSTUV', 'finance,q3'],
        reply: routes({
          'PUT /d/ABCDEFGHIJKLMNOPQRSTUV/tags':
              jsonReply(setTagsOk(tags: ['finance', 'q3'])),
        }),
      );

      expect(r.exitCode, 0, reason: '$r');
      expect(r.stdoutJson['tags'], ['finance', 'q3']);
      final call = r.calls.single;
      expect(call.method, 'PUT');
      expect(call.path, '/d/ABCDEFGHIJKLMNOPQRSTUV/tags');
      expect(call.jsonBody['tags'], ['finance', 'q3']);
      // The whole point: no document write anywhere in this exchange.
      expect(r.calls.any((c) => c.path == '/d/ABCDEFGHIJKLMNOPQRSTUV'), isFalse);
    });

    test('--clear sends an explicit empty list', () async {
      final r = await cli.run(
        ['--json', 'tags', 'ABCDEFGHIJKLMNOPQRSTUV', '--clear'],
        reply: routes({
          'PUT /d/ABCDEFGHIJKLMNOPQRSTUV/tags':
              jsonReply(setTagsOk(tags: const [])),
        }),
      );

      expect(r.exitCode, 0, reason: '$r');
      expect(r.calls.single.jsonBody['tags'], isEmpty);
    });

    test('a bare id with no tags and no --clear is a usage error', () async {
      // Full replacement means an omitted list would WIPE the classification.
      // That has to be explicit, not the accidental result of a typo.
      final r = await cli.run(['--json', 'tags', 'ABCDEFGHIJKLMNOPQRSTUV']);
      expect(r.exitCode, 64, reason: '$r');
      expect(r.calls, isEmpty);
    });

    test('warns when the server normalized the tags it stored', () async {
      // Tags are sanitized silently rather than rejected, so a caller that
      // assumes round-tripping is wrong. The response echoes what was STORED.
      final r = await cli.run(
        ['tags', 'ABCDEFGHIJKLMNOPQRSTUV', 'bad tag!,ok'],
        reply: routes({
          'PUT /d/ABCDEFGHIJKLMNOPQRSTUV/tags':
              jsonReply(setTagsOk(tags: ['badtag', 'ok'])),
        }),
      );

      expect(r.exitCode, 0, reason: '$r');
      expect(r.stdout, contains('badtag'));
      expect(r.stderr, contains('normalized'));
    });
  });

  group('status', () {
    test('deprecate with a successor sends both fields', () async {
      final r = await cli.run(
        [
          '--json', 'status', 'ABCDEFGHIJKLMNOPQRSTUV', 'deprecated', //
          '--superseded-by', 'ZZZZZZZZZZZZZZZZZZZZZZ',
        ],
        reply: routes({
          'PUT /d/ABCDEFGHIJKLMNOPQRSTUV/status': jsonReply(
              setStatusOk(supersededBy: 'ZZZZZZZZZZZZZZZZZZZZZZ')),
        }),
      );

      expect(r.exitCode, 0, reason: '$r');
      final body = r.calls.single.jsonBody;
      expect(body['status'], 'deprecated');
      expect(body['superseded_by'], 'ZZZZZZZZZZZZZZZZZZZZZZ');
    });

    test('active omits superseded_by entirely', () async {
      final r = await cli.run(
        ['--json', 'status', 'ABCDEFGHIJKLMNOPQRSTUV', 'active'],
        reply: routes({
          'PUT /d/ABCDEFGHIJKLMNOPQRSTUV/status':
              jsonReply(setStatusOk(status: 'active')),
        }),
      );

      expect(r.exitCode, 0, reason: '$r');
      expect(r.calls.single.jsonBody.containsKey('superseded_by'), isFalse);
    });

    test('active + --superseded-by is refused before the wire', () async {
      final r = await cli.run([
        '--json', 'status', 'ABCDEFGHIJKLMNOPQRSTUV', 'active', //
        '--superseded-by', 'ZZZZZZZZZZZZZZZZZZZZZZ',
      ]);
      expect(r.exitCode, 64, reason: '$r');
      expect(r.calls, isEmpty);
    });

    test('archived is rejected locally, naming it as reserved', () async {
      // The server rejects it too, but spending a round trip to be told costs
      // an agent a retry cycle it can avoid.
      final r = await cli.run(
        ['--json', 'status', 'ABCDEFGHIJKLMNOPQRSTUV', 'archived'],
      );
      expect(r.exitCode, 64, reason: '$r');
      expect(r.calls, isEmpty);
      expect(r.errorEnvelope['message'], contains('reserved'));
    });

    test('a slug in --superseded-by surfaces the server bad_target', () async {
      // superseded_by is a public_id ONLY. The CLI cannot tell a slug from an
      // id reliably, so the server is the authority — but the code must reach
      // the caller intact so a retry loop can branch on it.
      final r = await cli.run(
        [
          '--json', 'status', 'ABCDEFGHIJKLMNOPQRSTUV', 'deprecated', //
          '--superseded-by', 'some-slug',
        ],
        reply: routes({
          'PUT /d/ABCDEFGHIJKLMNOPQRSTUV/status': jsonReply(
            errorBody('bad_target', 'superseded_by must be a public_id'),
            status: 422,
          ),
        }),
      );

      expect(r.exitCode, 1, reason: '$r');
      expect(r.errorEnvelope['error'], 'bad_target');
    });
  });
}
