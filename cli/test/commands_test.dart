// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/// Command-layer tests: **the output contract**.
///
/// Everything asserted here is a promise the README makes to a headless caller
/// — "`--json` means the same thing everywhere", "`-o` is never silently
/// ignored", the flag→wire mapping for the pack knobs and the edit metadata —
/// and every one of them is a decision made in `commands/*.dart`, above the
/// client that `client_test.dart` covers. The error/exit-code half of the
/// contract lives in `cli_errors_test.dart`.
library;

import 'dart:convert';

import 'package:test/test.dart';

import 'support/cli_harness.dart';
import 'support/fixtures.dart';

void main() {
  late CliSandbox cli;

  setUp(() => cli = CliSandbox());
  tearDown(() => cli.dispose());

  group('--json is one object on stdout, whatever the command', () {
    // The regression this pins: `read` used to honor --json for `--as source`
    // and ignore it for `--as text|html`, and `get` ignored it entirely — so
    // `slopcafe read x --json | jq` failed to parse for two of three
    // representations and an agent could not predict the shape from the flag.

    test('read --as text emits the read envelope (body + provenance)', () async {
      final r = await cli.run(
        ['--json', 'read', 'q3-report'],
        reply: routes({
          '/s/q3-report/text': bodyReply(
            '# Q3\n\nrevenue\n',
            version: 3,
            sanitizerV: 'ammonia-v1.5',
            converterV: 'awh-md-v1',
          ),
        }),
      );

      expect(r.exitCode, 0, reason: '$r');
      final json = r.stdoutJson;
      expect(json['content'], '# Q3\n\nrevenue\n');
      expect(json['format'], 'markdown');
      expect(json['representation'], 'rendered');
      expect(json['slug'], 'q3-report');
      expect(json['version'], 3); // from the ETag
      expect(json['sanitizer_v'], 'ammonia-v1.5');
      expect(json['converter_v'], 'awh-md-v1');
      expect(json['content_type'], startsWith('text/markdown'));
    });

    test('read --as html emits the same envelope shape', () async {
      final r = await cli.run(
        ['--json', 'read', 'q3-report', '--as', 'html'],
        reply: routes({
          '/s/q3-report': bodyReply(
            '<p>hi</p>',
            contentType: 'text/html; charset=utf-8',
            version: 3,
          ),
        }),
      );

      expect(r.exitCode, 0, reason: '$r');
      final json = r.stdoutJson;
      expect(json['content'], '<p>hi</p>');
      expect(json['format'], 'html');
      // No converter runs on the HTML path, so null is the *answer* — the key
      // is present. sanitizer_v, which the /raw route simply doesn't send, is
      // absent rather than faked as null.
      expect(json.containsKey('converter_v'), isTrue);
      expect(json['converter_v'], isNull);
      expect(json.containsKey('sanitizer_v'), isFalse);
    });

    test('read --as source emits the MCP-named source envelope', () async {
      final r = await cli.run(
        ['--json', 'read', 'q3-report', '--as', 'source'],
        reply: routes({
          '/d': jsonReply(listOk()), // slug → public_id (/source is id-only)
          '/d/ABCDEFGHIJKLMNOPQRSTUV/source': jsonReply(sourceOk()),
        }),
      );

      expect(r.exitCode, 0, reason: '$r');
      final json = r.stdoutJson;
      expect(json['public_id'], 'ABCDEFGHIJKLMNOPQRSTUV');
      expect(json['representation'], 'source');
      expect(json['unsanitized'], isTrue);
      expect(json['content'], '# Q3\n\nWidget revenue.\n'); // was `source`
      expect(json['version'], 3); // was `version_no`
      expect(json['format'], 'markdown');
      expect(json['tags'], ['finance']); // the JSON endpoint carries metadata
    });

    test('get emits an envelope too (it is read --as html by another name)',
        () async {
      final r = await cli.run(
        ['--json', 'get', 'q3-report'],
        reply: routes({
          '/s/q3-report': bodyReply('<p>hi</p>',
              contentType: 'text/html; charset=utf-8', version: 4),
        }),
      );

      expect(r.exitCode, 0, reason: '$r');
      expect(r.stdoutJson['format'], 'html');
      expect(r.stdoutJson['version'], 4);
    });

    test('pack emits the PackResponse envelope', () async {
      final r = await cli.run(
        ['--json', 'pack', 'pack-boot'],
        reply: routes({'/d/pack': jsonReply(packOk())}),
      );

      expect(r.exitCode, 0, reason: '$r');
      final json = r.stdoutJson;
      expect(json['pack'], isA<Map<String, dynamic>>());
      expect(json['documents'], hasLength(1));
      expect(json['omitted'], isEmpty);
    });

    test('every one of them parses as a JSON object — the uniformity claim',
        () async {
      // The point of the contract is that a caller can predict the shape from
      // the flag alone, without knowing which command (or which --as) it is
      // running. So: same assertion, every body-returning surface.
      final invocations = <List<String>, ReplyHandler>{
        ['--json', 'read', 'q3-report']: routes({
          '/s/q3-report/text': bodyReply('# Q3\n', version: 1),
        }),
        ['--json', 'read', 'q3-report', '--as', 'html']: routes({
          '/s/q3-report': bodyReply('<p>x</p>',
              contentType: 'text/html', version: 1),
        }),
        ['--json', 'read', 'q3-report', '--as', 'source']: routes({
          '/d': jsonReply(listOk()),
          '/d/ABCDEFGHIJKLMNOPQRSTUV/source': jsonReply(sourceOk()),
        }),
        ['--json', 'get', 'q3-report']: routes({
          '/s/q3-report': bodyReply('<p>x</p>', contentType: 'text/html'),
        }),
        ['--json', 'pack', 'pack-boot']: routes({
          '/d/pack': jsonReply(packOk()),
        }),
      };

      for (final entry in invocations.entries) {
        final r = await cli.run(entry.key, reply: entry.value);
        expect(r.exitCode, 0, reason: '${entry.key}\n$r');
        expect(
          jsonDecode(r.stdout),
          isA<Map<String, dynamic>>(),
          reason: '${entry.key.join(' ')} did not emit a JSON object:\n$r',
        );
      }
    });

    test('without --json stdout is still the raw body, byte for byte', () async {
      // The counterpart promise: `slopcafe read … > out.md` must capture the
      // document, not an envelope.
      final r = await cli.run(
        ['read', 'q3-report'],
        reply: routes({'/s/q3-report/text': bodyReply('# Q3\n\nrevenue\n')}),
      );
      expect(r.exitCode, 0, reason: '$r');
      expect(r.stdout, '# Q3\n\nrevenue\n');
    });
  });

  group('-o <file> is honored in BOTH modes', () {
    // The regression this pins: `pack --json -o ctx.json` wrote the envelope to
    // stdout and never created the file, exiting 0 with no warning — the
    // caller's next step then read a file that was never there.

    test('human mode writes the raw body to the file, not stdout', () async {
      final out = cli.path('page.html');
      final r = await cli.run(
        ['read', 'q3-report', '--as', 'html', '-o', out],
        reply: routes({
          '/s/q3-report': bodyReply('<p>hi</p>', contentType: 'text/html'),
        }),
      );

      expect(r.exitCode, 0, reason: '$r');
      expect(r.stdout, isEmpty);
      expect(cli.readFile('page.html'), '<p>hi</p>');
      expect(r.stderr, contains('wrote 9 bytes'));
    });

    test('json mode writes the envelope to the file, not stdout', () async {
      final out = cli.path('ctx.json');
      final r = await cli.run(
        ['--json', 'pack', 'pack-boot', '-o', out],
        reply: routes({'/d/pack': jsonReply(packOk())}),
      );

      expect(r.exitCode, 0, reason: '$r');
      expect(r.stdout, isEmpty, reason: 'the envelope belongs in the file');
      final written = jsonDecode(cli.readFile('ctx.json'));
      expect(written, isA<Map<String, dynamic>>());
      expect((written as Map)['documents'], hasLength(1));
    });

    test('json mode honors -o on read --as source as well', () async {
      final out = cli.path('src.json');
      final r = await cli.run(
        ['--json', 'read', 'q3-report', '--as', 'source', '-o', out],
        reply: routes({
          '/d': jsonReply(listOk()),
          '/d/ABCDEFGHIJKLMNOPQRSTUV/source': jsonReply(sourceOk()),
        }),
      );

      expect(r.exitCode, 0, reason: '$r');
      expect(r.stdout, isEmpty);
      final written = jsonDecode(cli.readFile('src.json')) as Map;
      expect(written['representation'], 'source');
      expect(written['content'], contains('Widget'));
    });

    test('the file bytes and the stdout bytes are identical', () async {
      // One encoder (Output.encodeJson) for both, so a caller that reads the
      // file and one that reads the pipe can never disagree.
      final piped = await cli.run(
        ['--json', 'pack', 'pack-boot'],
        reply: routes({'/d/pack': jsonReply(packOk())}),
      );
      final out = cli.path('same.json');
      await cli.run(
        ['--json', 'pack', 'pack-boot', '-o', out],
        reply: routes({'/d/pack': jsonReply(packOk())}),
      );
      expect(cli.readFile('same.json'), piped.stdout);
    });
  });

  group('search --include-bodies (the query-rooted pack)', () {
    test('sends the context-pack knobs under the server\'s param names',
        () async {
      final r = await cli.run(
        [
          'search', 'context', 'pack', //
          '--include-bodies',
          '--budget', '20000',
          '--max-docs', '3',
          '--include-deprecated',
          '--mode', 'keyword',
          '--tag', 'a,b',
          '--limit', '5',
        ],
        reply: routes({
          '/d/search': jsonReply(packOk(
            source: 'query',
            query: 'context pack',
            withRoot: false,
          )),
        }),
      );

      expect(r.exitCode, 0, reason: '$r');
      final q = r.callTo('/d/search')!.query;
      // The pack knobs — the names are the server's (docs/http-api.md
      // §GET /d/search), not the flag spellings.
      expect(q['include_bodies'], 'true');
      expect(q['budget_bytes'], '20000');
      expect(q['max_documents'], '3');
      expect(q['include_deprecated'], 'true');
      // …and the ordinary search filters still ride along.
      expect(q['q'], 'context pack');
      expect(q['mode'], 'keyword');
      expect(q['tag'], 'a,b');
      expect(q['limit'], '5');
    });

    test('omits knobs that were not passed, so server defaults apply', () async {
      final r = await cli.run(
        ['search', 'onboarding', '--include-bodies'],
        reply: routes({
          '/d/search': jsonReply(
              packOk(source: 'query', query: 'onboarding', withRoot: false)),
        }),
      );

      expect(r.exitCode, 0, reason: '$r');
      final q = r.callTo('/d/search')!.query;
      expect(q['include_bodies'], 'true');
      expect(q.containsKey('budget_bytes'), isFalse);
      expect(q.containsKey('max_documents'), isFalse);
      expect(q.containsKey('include_deprecated'), isFalse);
    });

    test('renders the pack like `slopcafe pack` does: markdown out, notes err',
        () async {
      // Both pack roots share packContent/packNotes, so a boot prompt reading
      // stdout gets the same bytes whichever way the pack was assembled.
      final r = await cli.run(
        ['search', 'onboarding', '--include-bodies'],
        reply: routes({
          '/d/search': jsonReply(packOk(
            source: 'query',
            query: 'onboarding',
            withRoot: false,
            omitted: [
              {'ref': 'other-doc', 'reason': 'max_documents'},
            ],
          )),
        }),
      );

      expect(r.exitCode, 0, reason: '$r');
      expect(r.stdout, contains('<!-- pack member: member-one'));
      expect(r.stdout, isNot(contains('omitted')));
      expect(r.stderr, contains('pack (query) for "onboarding"'));
      expect(r.stderr, contains('omitted (max_documents)'));
    });

    test('without --include-bodies it is the plain hit list, no pack params',
        () async {
      final r = await cli.run(
        ['--json', 'search', 'onboarding'],
        reply: routes({'/d/search': jsonReply({'documents': <dynamic>[]})}),
      );

      expect(r.exitCode, 0, reason: '$r');
      expect(r.callTo('/d/search')!.query.containsKey('include_bodies'), isFalse);
      expect(r.stdoutJson['documents'], isEmpty);
    });
  });

  group('global flags reach the transport', () {
    test('every request carries a budget, so a stalled origin cannot wedge it',
        () async {
      final r = await cli.run(
        ['read', 'q3-report'],
        reply: routes({'/s/q3-report/text': bodyReply('# Q3\n')}),
      );

      expect(r.exitCode, 0, reason: '$r');
      final sent = r.lastCall.request;
      expect(sent.receiveTimeout, const Duration(seconds: 60));
      expect(sent.connectTimeout, const Duration(seconds: 15));
      // send is deliberately NOT the receive budget: dio's sendTimeout caps
      // total upload duration rather than idle time, so sharing 60s would abort
      // a perfectly healthy 5 MiB byte-exact publish on a slow link. Pinned
      // separately so a future tidy-up can't quietly collapse the two.
      expect(sent.sendTimeout, const Duration(seconds: 300));
      expect(
        sent.sendTimeout!.compareTo(sent.receiveTimeout!) > 0,
        isTrue,
        reason: 'the upload cap must stay above the idle bound',
      );
    });

    test('--timeout lowers every budget (and can never raise one)', () async {
      final r = await cli.run(
        ['--timeout', '3', 'read', 'q3-report'],
        reply: routes({'/s/q3-report/text': bodyReply('# Q3\n')}),
      );

      expect(r.exitCode, 0, reason: '$r');
      final sent = r.lastCall.request;
      expect(sent.receiveTimeout, const Duration(seconds: 3));
      expect(sent.connectTimeout, const Duration(seconds: 3));
      expect(sent.sendTimeout, const Duration(seconds: 3));
    });

    test('--timeout above a default does not raise that default', () async {
      final r = await cli.run(
        ['--timeout', '600', 'read', 'q3-report'],
        reply: routes({'/s/q3-report/text': bodyReply('# Q3\n')}),
      );

      expect(r.exitCode, 0, reason: '$r');
      final sent = r.lastCall.request;
      // receive follows --timeout (it is the patience knob), but connect and
      // send stay at their ceilings — a longer wait must not widen a handshake
      // window or an upload cap chosen for a reason.
      expect(sent.connectTimeout, const Duration(seconds: 15));
      expect(sent.sendTimeout, const Duration(seconds: 300));
    });

    test('a malformed --timeout fails before any request', () async {
      final r = await cli.run(['--json', '--timeout', 'abc', 'read', 'x']);

      expect(r.exitCode, 64, reason: '$r');
      expect(r.errorEnvelope['error'], 'cli_usage');
      expect(r.calls, isEmpty);
    });
  });

  group('edit metadata flags', () {
    // The regression this pins: `edit` registered no metadata flags at all, so
    // "rename a term AND fix the title" needed a second full-body update — an
    // extra round trip and an extra version.

    ReplyHandler editReplies() => routes({
          '/d/ABCDEFGHIJKLMNOPQRSTUV/source': jsonReply(sourceOk()),
          'PUT /d/ABCDEFGHIJKLMNOPQRSTUV': jsonReply(writeOk(version: 4)),
        });

    test('sends X-Doc-* on the republish, including the ""-clears case',
        () async {
      final r = await cli.run(
        [
          'edit', 'ABCDEFGHIJKLMNOPQRSTUV', //
          '-f', 'Widget', '-r', 'Gadget',
          '--title', 'Gadget report',
          '--tags', '', // explicit clear
        ],
        reply: editReplies(),
      );

      expect(r.exitCode, 0, reason: '$r');
      final put = r.lastCall;
      expect(put.method, 'PUT');
      expect(put.header('X-Doc-Title'), 'Gadget report');
      // '' is a *sent* empty header (clear), not an omission — the difference
      // between "clear the tags" and "inherit them".
      expect(put.hasHeader('X-Doc-Tags'), isTrue);
      expect(put.header('X-Doc-Tags'), '');
      // Flags that were never passed stay off the wire entirely (inherit).
      expect(put.hasHeader('X-Doc-Description'), isFalse);
      expect(put.hasHeader('X-Doc-Slug'), isFalse);
    });

    test('omitting every metadata flag sends no X-Doc-* header at all', () async {
      final r = await cli.run(
        ['edit', 'ABCDEFGHIJKLMNOPQRSTUV', '-f', 'Widget', '-r', 'Gadget'],
        reply: editReplies(),
      );

      expect(r.exitCode, 0, reason: '$r');
      final sent = r.lastCall.request.headers.keys
          .where((k) => k.toLowerCase().startsWith('x-doc-'));
      expect(sent, isEmpty);
    });

    test('the republished body is the edited source, guarded by its version',
        () async {
      final r = await cli.run(
        ['edit', 'ABCDEFGHIJKLMNOPQRSTUV', '-f', 'Widget', '-r', 'Gadget'],
        reply: editReplies(),
      );

      expect(r.exitCode, 0, reason: '$r');
      final put = r.lastCall;
      expect(put.text, '# Q3\n\nGadget revenue.\n');
      // --if-match auto guards the version the SOURCE was read at, so a
      // concurrent write between the read and the PUT 412s instead of
      // clobbering it with stale-source edits.
      expect(put.header('If-Match'), '"v3"');
      expect(put.hasHeader('X-Content-SHA256'), isTrue);
    });
  });
}
