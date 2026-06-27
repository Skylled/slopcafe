// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

import 'dart:convert';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:dio/dio.dart';
import 'package:slopcafe_cli/src/client.dart';
import 'package:slopcafe_cli/src/errors.dart';
import 'package:slopcafe_cli/src/format.dart';
import 'package:test/test.dart';

/// A dio adapter that records the outgoing request and returns a canned
/// response — so we assert request *shape* with no network.
class _Capture implements HttpClientAdapter {
  _Capture({this.status = 200, this.json = const {}, this.headers = const {}});

  int status;
  Map<String, dynamic> json;
  Map<String, List<String>> headers;

  RequestOptions? last;
  List<int> body = const [];

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    last = options;
    if (requestStream != null) {
      body = await requestStream.fold<List<int>>([], (a, b) => a..addAll(b));
    }
    return ResponseBody.fromString(
      jsonEncode(json),
      status,
      headers: {
        Headers.contentTypeHeader: ['application/json'],
        ...headers,
      },
    );
  }

  @override
  void close({bool force = false}) {}
}

SlopcafeClient _client(_Capture cap, {String? key = 'awh_test'}) {
  final dio = Dio(
    BaseOptions(
      baseUrl: 'https://test.example',
      validateStatus: (_) => true,
      followRedirects: false,
    ),
  )..httpClientAdapter = cap;
  return SlopcafeClient(baseUrl: 'https://test.example', key: key, dio: dio);
}

Map<String, dynamic> _writeOk({int version = 1}) => {
  'public_id': 'abcdefghijklmnopqrstuv',
  'url': 'https://test.example/d/abcdefghijklmnopqrstuv',
  'version': version,
  'size_bytes': 5,
  'sanitizer_v': 'ammonia-test',
  'modified': false,
  'stripped': <String>[],
  'will_not_render': <String>[],
  'tags': <String>[],
  'source_sha256': null,
  'title': 'T',
  'description': null,
  'slug': null,
};

void main() {
  group('publish', () {
    test('shapes a byte-exact POST /d with metadata', () async {
      final cap = _Capture(status: 201, json: _writeOk());
      final client = _client(cap);
      final body = utf8.encode('# Hi\n\nbody\n');

      final res = await client.publish(
        body: body,
        format: DocFormat.markdown,
        metadata: const DocMetadata(title: 'My Title', slug: 'my-slug'),
      );

      expect(res.publicId, 'abcdefghijklmnopqrstuv');
      expect(cap.last!.method, 'POST');
      expect(cap.last!.path, '/d');
      final h = cap.last!.headers;
      expect(h['Authorization'], 'Bearer awh_test');
      expect(cap.last!.contentType, 'text/markdown');
      expect(h['X-Content-SHA256'], sha256.convert(body).toString());
      expect(h[Headers.contentLengthHeader], body.length);
      expect(h['X-Doc-Title'], 'My Title');
      expect(h['X-Doc-Slug'], 'my-slug');
      expect(h.containsKey('X-Doc-Description'), isFalse); // null → omitted
      expect(h.containsKey('X-Doc-Tags'), isFalse);
      expect(cap.body, body); // bytes sent verbatim
    });

    test('--no-integrity omits the sha header', () async {
      final cap = _Capture(status: 201, json: _writeOk());
      await _client(cap).publish(
        body: utf8.encode('x'),
        format: DocFormat.markdown,
        integrity: false,
      );
      expect(cap.last!.headers.containsKey('X-Content-SHA256'), isFalse);
    });

    test('empty tags list sends an explicit clear; null omits', () async {
      final cap = _Capture(status: 201, json: _writeOk());
      await _client(cap).publish(
        body: utf8.encode('x'),
        format: DocFormat.html,
        metadata: const DocMetadata(tags: []),
      );
      expect(cap.last!.headers['X-Doc-Tags'], '');
      expect(cap.last!.contentType, 'text/html');
    });

    test('non-ASCII metadata throws a usage error BEFORE any request', () async {
      final cap = _Capture(status: 201, json: _writeOk());
      expect(
        () => _client(cap).publish(
          body: utf8.encode('x'),
          format: DocFormat.markdown,
          metadata: const DocMetadata(title: 'Café'),
        ),
        throwsA(isA<CliException>().having((e) => e.exitCode, 'exitCode', ExitCodes.usage)),
      );
      expect(cap.last, isNull); // never hit the wire
    });
  });

  group('update', () {
    test('sends PUT with the If-Match header', () async {
      final cap = _Capture(status: 200, json: _writeOk(version: 2));
      final res = await _client(cap).update(
        publicId: 'abcdefghijklmnopqrstuv',
        body: utf8.encode('x'),
        format: DocFormat.markdown,
        ifMatch: '"v1"',
      );
      expect(res.version, 2);
      expect(cap.last!.method, 'PUT');
      expect(cap.last!.path, '/d/abcdefghijklmnopqrstuv');
      expect(cap.last!.headers['If-Match'], '"v1"');
    });
  });

  group('currentVersion', () {
    test('reads the version from the ETag on a HEAD', () async {
      final cap = _Capture(status: 200, headers: {'etag': ['"v5"']});
      final v = await _client(cap).currentVersion('abcdefghijklmnopqrstuv');
      expect(v, 5);
      expect(cap.last!.method, 'HEAD');
      expect(cap.last!.path, '/d/abcdefghijklmnopqrstuv/raw');
    });
  });

  group('reads', () {
    test('readText hits /text and returns body + version', () async {
      // For a text read the body is the markdown string itself.
      final dio = Dio(
        BaseOptions(baseUrl: 'https://test.example', validateStatus: (_) => true),
      )..httpClientAdapter = _StringBody('# Doc\n', 200, {'etag': ['"v3"']});
      final client = SlopcafeClient(baseUrl: 'https://test.example', key: 'awh_test', dio: dio);
      final r = await client.readText(publicId: 'abcdefghijklmnopqrstuv');
      expect(r.text, '# Doc\n');
      expect(r.version, 3);
    });

    test('credentialed read with no key throws noPermission before the wire', () async {
      final cap = _Capture(status: 200);
      final client = _client(cap, key: null);
      expect(
        () => client.readText(publicId: 'abcdefghijklmnopqrstuv'),
        throwsA(isA<CliException>().having((e) => e.exitCode, 'exitCode', ExitCodes.noPermission)),
      );
      expect(cap.last, isNull);
    });
  });

  group('slug redirects', () {
    test('410 Gone on a slug read → "retired" message', () async {
      final cap = _Capture(status: 410, json: {'error': 'gone'});
      expect(
        () => _client(cap).readRaw(slug: 'old-name'),
        throwsA(isA<CliException>().having((e) => e.message, 'message', contains('retired'))),
      );
    });

    test('409 slug_redirected → "moved" + --follow hint, with target', () async {
      final cap = _Capture(status: 409, json: {
        'redirect_to': {'public_id': 'NEWID', 'slug': 'new-name'},
        'hint': 'opt in',
      });
      expect(
        () => _client(cap).readText(slug: 'old-name'),
        throwsA(isA<CliException>()
            .having((e) => e.message, 'message', contains('moved'))
            .having((e) => e.message, 'message', contains('--follow'))
            .having((e) => e.message, 'message', contains('new-name'))),
      );
    });

    test('--follow appends ?follow_redirects=true', () async {
      final cap = _Capture(status: 200, headers: {'etag': ['"v1"']});
      await _client(cap).readRaw(slug: 'old-name', followRedirects: true);
      expect(cap.last!.uri.queryParameters['follow_redirects'], 'true');
    });
  });

  group('error mapping', () {
    test('409 slug_taken → failure exit, code in message', () async {
      final cap = _Capture(status: 409, json: {'error': 'slug_taken', 'message': 'in use', 'slug': 's'});
      expect(
        () => _client(cap).publish(body: utf8.encode('x'), format: DocFormat.markdown),
        throwsA(isA<CliException>()
            .having((e) => e.exitCode, 'exitCode', ExitCodes.failure)
            .having((e) => e.message, 'message', contains('slug_taken'))),
      );
    });

    test('401 → noPermission exit', () async {
      final cap = _Capture(status: 401, json: {'error': 'unauthorized', 'message': 'nope'});
      expect(
        () => _client(cap).publish(body: utf8.encode('x'), format: DocFormat.markdown),
        throwsA(isA<CliException>().having((e) => e.exitCode, 'exitCode', ExitCodes.noPermission)),
      );
    });
  });
}

/// Adapter that returns a fixed string body (for byte/text reads).
class _StringBody implements HttpClientAdapter {
  _StringBody(this.text, this.status, this.headers);
  final String text;
  final int status;
  final Map<String, List<String>> headers;

  @override
  Future<ResponseBody> fetch(RequestOptions options, Stream<Uint8List>? requestStream, Future<void>? cancelFuture) async {
    return ResponseBody.fromString(text, status, headers: {
      Headers.contentTypeHeader: ['text/markdown'],
      ...headers,
    });
  }

  @override
  void close({bool force = false}) {}
}
