// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

import 'dart:convert';

import 'package:crypto/crypto.dart';
import 'package:dio/dio.dart';

import '../api/api.dart';
import 'errors.dart';
import 'format.dart';

/// Optional, per-write document metadata. The three-state semantics match the
/// backend's `X-Doc-*` inheritance contract:
///   * a field left `null`  → the header is **omitted** (publish: unset;
///     update: inherit the prior value);
///   * a field set to `''`  → the header is sent **empty** (clear / re-derive);
///   * a non-empty value    → the header is sent as-is.
/// [tags] follows the same rule (`null` omit, `[]` clear, list set).
class DocMetadata {
  const DocMetadata({this.title, this.description, this.tags, this.slug});

  final String? title;
  final String? description;
  final List<String>? tags;
  final String? slug;

  bool get isEmpty =>
      title == null && description == null && tags == null && slug == null;
}

/// The result of a credentialed text/raw read: the body plus the version it
/// came from (from the `ETag`), so a caller can report "v3" without a second
/// request.
class ReadResult {
  ReadResult({required this.body, this.version, this.contentType});
  final List<int> body;
  final int? version;
  final String? contentType;

  String get text => utf8.decode(body, allowMalformed: true);
}

/// A thin typed wrapper over the agent-key-reachable Slopcafe HTTP surface.
/// Every method throws a [CliException] on a non-2xx response (built from the
/// typed [ApiError] envelope when the body is JSON, else from the status code).
class SlopcafeClient {
  SlopcafeClient({required this.baseUrl, this.key, Dio? dio})
    : _dio =
          dio ??
          Dio(
            BaseOptions(
              baseUrl: baseUrl,
              // We inspect status codes ourselves and map them to ApiError.
              validateStatus: (_) => true,
              // Slug redirects / loud forwards must surface, never auto-follow.
              followRedirects: false,
            ),
          ) {
    // Default request headers, set in the body (not BaseOptions) so they apply
    // whether the Dio was created here or injected by a test — the header
    // contract is then identical on both paths. `putIfAbsent` lets a caller
    // still override.
    // User-Agent so requests are attributable in logs.
    _dio.options.headers.putIfAbsent('User-Agent', () => 'slopcafe-cli');
    // `Accept: */*` is LOAD-BEARING, not politeness. `dart:io`'s HttpClient
    // sends NO Accept header by default; when Cloudflare sees a request with no
    // Accept it serves /d/:id/raw (and /text, /source) via a chunked/transform
    // path that STRIPS the strong `ETag` the Worker set. The CLI reads the
    // current version from that ETag (`currentVersion` for `update --if-match
    // auto`; the version field on every read), so without this header the ETag
    // is gone and `update --if-match auto` fails with "no ETag" even
    // single-writer. Sending `*/*` (exactly what curl/browsers send) keeps the
    // tag — Cloudflare weakens it to `W/"v<n>"` under gzip, which
    // parseVersionTag already handles. Do not remove.
    _dio.options.headers.putIfAbsent('Accept', () => '*/*');
  }

  final String baseUrl;
  final String? key;
  final Dio _dio;

  /// Release underlying sockets (so a short-lived CLI process exits promptly).
  void close() => _dio.close(force: true);

  // --- writes --------------------------------------------------------------

  /// `POST /d` — publish a new document. Byte-exact when [integrity] is set
  /// (sends `X-Content-SHA256` over the raw [body]).
  Future<WriteResponse> publish({
    required List<int> body,
    required DocFormat format,
    DocMetadata metadata = const DocMetadata(),
    bool integrity = true,
  }) async {
    final res = await _sendBody(
      method: 'POST',
      path: '/d',
      body: body,
      format: format,
      metadata: metadata,
      integrity: integrity,
      requireAuth: true,
    );
    return WriteResponse.fromJson(_asMap(res));
  }

  /// `PUT /d/:id` — append a new version. [ifMatch] is the header value
  /// (`"v<n>"` or `*`); resolve `auto` via [currentVersion] before calling.
  Future<WriteResponse> update({
    required String publicId,
    required List<int> body,
    required DocFormat format,
    required String ifMatch,
    DocMetadata metadata = const DocMetadata(),
    bool integrity = true,
  }) async {
    final res = await _sendBody(
      method: 'PUT',
      path: '/d/$publicId',
      body: body,
      format: format,
      metadata: metadata,
      integrity: integrity,
      requireAuth: true,
      extraHeaders: {'If-Match': ifMatch},
    );
    return WriteResponse.fromJson(_asMap(res));
  }

  /// Preflight the current version of a document via a bodyless
  /// `HEAD /d/:id/raw` (reads the `ETag`). Used to resolve `--if-match auto`.
  Future<int> currentVersion(String publicId) async {
    final res = await _dio.request<void>(
      '/d/$publicId/raw',
      options: Options(method: 'HEAD', headers: _authHeaders(require: false)),
    );
    if (res.statusCode == 404) {
      throw CliException(
        'no such document: $publicId (cannot resolve --if-match auto)',
      );
    }
    // Surface any other non-2xx (401/403/5xx) as its real error, rather than
    // falling through to a confusing "no ETag" message.
    _throwIfError(res);
    final v = parseVersionTag(res.headers.value('etag'));
    if (v == null) {
      throw CliException(
        'could not read current version of $publicId (no ETag); '
        'pass --if-match "v<n>" or --force explicitly',
      );
    }
    return v;
  }

  // --- reads ---------------------------------------------------------------

  /// `GET /d/:id/text` or `GET /s/:slug/text` — the GFM-markdown derivation.
  /// Credentialed (the key is required). On a slug read, [followRedirects]
  /// opts into following a retired slug's loud redirect (`?follow_redirects`).
  Future<ReadResult> readText({
    String? publicId,
    String? slug,
    bool followRedirects = false,
  }) {
    final path = publicId != null ? '/d/$publicId/text' : '/s/$slug/text';
    return _readBody(path, requireAuth: true, slug: slug, followRedirects: followRedirects);
  }

  /// `GET /d/:id/raw` (by id) or `GET /s/:slug` (by slug) — the sanitized HTML
  /// bytes. The key is sent when present (needed for a private document). On a
  /// slug read, [followRedirects] opts into following a retired slug's redirect.
  Future<ReadResult> readRaw({
    String? publicId,
    String? slug,
    bool followRedirects = false,
  }) {
    final path = publicId != null ? '/d/$publicId/raw' : '/s/$slug';
    return _readBody(path, requireAuth: false, slug: slug, followRedirects: followRedirects);
  }

  /// `GET /d/:id/source` — the retained, unsanitized authored source (JSON).
  /// Credentialed.
  Future<ReadSourceResponse> readSource(String publicId) async {
    final res = await _dio.get<dynamic>(
      '/d/$publicId/source',
      options: Options(
        responseType: ResponseType.json,
        headers: _authHeaders(require: true),
      ),
    );
    _throwIfError(res);
    return ReadSourceResponse.fromJson(_asMap(res));
  }

  /// `GET /d/:id/links` — the link-graph neighborhood (backlinks + outbound).
  /// Credentialed.
  Future<DocumentLinksResponse> links(String publicId) async {
    final res = await _dio.get<dynamic>(
      '/d/$publicId/links',
      options: Options(
        responseType: ResponseType.json,
        headers: _authHeaders(require: true),
      ),
    );
    _throwIfError(res);
    return DocumentLinksResponse.fromJson(_asMap(res));
  }

  // --- discovery -----------------------------------------------------------

  /// `GET /d` — list documents (newest-first, cursor-paginated). Agent-or-operator
  /// (the HTTP twin of MCP `list_documents`). [tags] are AND-filtered;
  /// `GET /d?slug=` returns the 0-or-1 matching row (the slug → public_id lookup).
  Future<ListDocumentsResponse> listDocuments({
    String? slug,
    List<String>? tags,
    String? status,
    int? limit,
    String? cursor,
  }) async {
    final qp = <String, dynamic>{};
    if (slug != null && slug.isNotEmpty) qp['slug'] = slug;
    if (tags != null && tags.isNotEmpty) qp['tag'] = tags.join(',');
    if (status != null && status.isNotEmpty) qp['status'] = status;
    if (limit != null) qp['limit'] = '$limit';
    if (cursor != null && cursor.isNotEmpty) qp['cursor'] = cursor;
    final res = await _dio.get<dynamic>(
      '/d',
      queryParameters: qp.isEmpty ? null : qp,
      options: Options(
        responseType: ResponseType.json,
        headers: _authHeaders(require: true),
      ),
    );
    _throwIfError(res);
    return ListDocumentsResponse.fromJson(_asMap(res));
  }

  /// `GET /d/search` — hybrid (keyword + semantic) search. Agent-or-operator
  /// (the HTTP twin of MCP `search_documents`). [mode] is `hybrid` (default) |
  /// `keyword` | `semantic`. Not paginated.
  Future<SearchDocumentsResponse> search({
    required String q,
    String? mode,
    List<String>? tags,
    String? slug,
    String? status,
    int? limit,
  }) async {
    final qp = <String, dynamic>{'q': q};
    if (mode != null && mode.isNotEmpty) qp['mode'] = mode;
    if (tags != null && tags.isNotEmpty) qp['tag'] = tags.join(',');
    if (slug != null && slug.isNotEmpty) qp['slug'] = slug;
    if (status != null && status.isNotEmpty) qp['status'] = status;
    if (limit != null) qp['limit'] = '$limit';
    final res = await _dio.get<dynamic>(
      '/d/search',
      queryParameters: qp,
      options: Options(
        responseType: ResponseType.json,
        headers: _authHeaders(require: true),
      ),
    );
    _throwIfError(res);
    return SearchDocumentsResponse.fromJson(_asMap(res));
  }

  /// `GET /d/pack` — the document/manifest-rooted context pack (the HTTP twin
  /// of MCP `load_context_pack`): the root's own prose plus the full markdown
  /// bodies of the documents it references, budget-filled in one call. [from]
  /// is a live slug or a 22-char public_id (resolved server-side, live-slug
  /// first — no client-side resolveDocId needed). Knobs are clamped, not
  /// rejected, by the server.
  Future<PackResponse> loadPack({
    required String from,
    int? budgetBytes,
    int? maxDocuments,
    bool includeDeprecated = false,
    bool followRedirects = false,
  }) async {
    final qp = <String, dynamic>{'from': from};
    if (budgetBytes != null) qp['budget_bytes'] = '$budgetBytes';
    if (maxDocuments != null) qp['max_documents'] = '$maxDocuments';
    if (includeDeprecated) qp['include_deprecated'] = 'true';
    if (followRedirects) qp['follow_redirects'] = 'true';
    final res = await _dio.get<dynamic>(
      '/d/pack',
      queryParameters: qp,
      options: Options(
        responseType: ResponseType.json,
        headers: _authHeaders(require: true),
      ),
    );
    _throwIfError(res);
    return PackResponse.fromJson(_asMap(res));
  }

  /// Resolve a document identifier to a `public_id`. When [identifier] already
  /// looks like a `public_id` (and [isSlug] wasn't forced) it is returned
  /// unchanged with no network call; otherwise it is treated as a slug and
  /// resolved via `GET /d?slug=` (the 0-or-1 lookup). This is what lets the
  /// id-only routes (`PUT /d/:id`, `/source`, `/links`) be addressed by slug.
  /// Throws a [CliException] when a slug matches no live document.
  Future<String> resolveDocId(
    String identifier, {
    bool isSlug = false,
    bool isId = false,
  }) async {
    if (!isSlug && (isId || looksLikePublicId(identifier))) return identifier;
    final res = await listDocuments(slug: identifier, limit: 1);
    if (res.documents.isEmpty) {
      throw CliException(
        "no live document has the slug '$identifier'",
        exitCode: ExitCodes.usage,
      );
    }
    return res.documents.first.publicId;
  }

  /// `GET /healthz` — public service health.
  Future<HealthzResponse> health() async {
    final res = await _dio.get<dynamic>(
      '/healthz',
      options: Options(responseType: ResponseType.json),
    );
    _throwIfError(res);
    return HealthzResponse.fromJson(_asMap(res));
  }

  /// `GET /openapi.json` — the machine-readable contract (returned raw).
  Future<Map<String, dynamic>> openapi() async {
    final res = await _dio.get<dynamic>(
      '/openapi.json',
      options: Options(responseType: ResponseType.json),
    );
    _throwIfError(res);
    return _asMap(res);
  }

  /// Best-effort auth probe: hit a credentialed read on an all-zero (well-formed
  /// but never-minted) `public_id`. A `401` means the key is rejected; anything
  /// else (typically `404 not_found`) means the key was **accepted**. Returns
  /// true when the key is accepted.
  Future<bool> probeAuth() async {
    if (key == null) {
      throw CliException(
        'no key configured — set --key, SLOPCAFE_KEY, or run `slopcafe config set key`',
        exitCode: ExitCodes.noPermission,
      );
    }
    final res = await _dio.get<dynamic>(
      '/d/AAAAAAAAAAAAAAAAAAAAAA/text',
      options: Options(headers: _authHeaders(require: true)),
    );
    return res.statusCode != 401;
  }

  // --- internals -----------------------------------------------------------

  Future<ReadResult> _readBody(
    String path, {
    required bool requireAuth,
    String? slug,
    bool followRedirects = false,
  }) async {
    final res = await _dio.get<List<int>>(
      path,
      queryParameters: followRedirects ? {'follow_redirects': 'true'} : null,
      options: Options(
        responseType: ResponseType.bytes,
        headers: _authHeaders(require: requireAuth),
      ),
    );
    if (slug != null) _throwIfSlugIssue(res, slug);
    _throwIfError(res, bytesBody: true);
    return ReadResult(
      body: res.data ?? const [],
      version: parseVersionTag(res.headers.value('etag')),
      contentType: res.headers.value(Headers.contentTypeHeader),
    );
  }

  /// Turn the slug-specific `409 slug_redirected` / `410 Gone` responses into
  /// clear, actionable messages (a generic ApiError would bury the meaning).
  void _throwIfSlugIssue(Response<dynamic> res, String slug) {
    final status = res.statusCode ?? 0;
    if (status == 409) {
      final target = _redirectTarget(res.data);
      throw CliException(
        "the slug '$slug' has moved${target != null ? ' to $target' : ''}; "
        're-run with --follow to fetch the redirect target',
      );
    }
    if (status == 410) {
      throw CliException(
        "the slug '$slug' is retired (410 Gone) and will never resolve again",
      );
    }
  }

  /// Best-effort extraction of a redirect target from a `slug_redirected` body.
  String? _redirectTarget(dynamic data) {
    try {
      final decoded = data is List<int> ? jsonDecode(utf8.decode(data)) : data;
      final to = (decoded as Map)['redirect_to'];
      if (to is Map) return (to['slug'] ?? to['public_id'])?.toString();
    } catch (_) {}
    return null;
  }

  Future<Response<dynamic>> _sendBody({
    required String method,
    required String path,
    required List<int> body,
    required DocFormat format,
    required DocMetadata metadata,
    required bool integrity,
    required bool requireAuth,
    Map<String, String> extraHeaders = const {},
  }) async {
    final headers = <String, dynamic>{
      ..._authHeaders(require: requireAuth),
      Headers.contentLengthHeader: body.length,
      ...extraHeaders,
      ..._metadataHeaders(metadata),
    };
    if (integrity) {
      headers['X-Content-SHA256'] = sha256.convert(body).toString();
    }
    final res = await _dio.request<dynamic>(
      path,
      // A Stream is sent raw (no transformer mangling of the bytes); the
      // explicit content-length above is what dio needs for a stream body.
      data: Stream<List<int>>.fromIterable([body]),
      options: Options(
        method: method,
        contentType: format.contentType,
        responseType: ResponseType.json,
        headers: headers,
      ),
    );
    _throwIfError(res);
    return res;
  }

  Map<String, dynamic> _authHeaders({required bool require}) {
    if (key == null) {
      if (require) {
        throw CliException(
          'no key configured — set --key, SLOPCAFE_KEY, or run `slopcafe config set key`',
          exitCode: ExitCodes.noPermission,
        );
      }
      return {};
    }
    return {'Authorization': 'Bearer $key'};
  }

  Map<String, String> _metadataHeaders(DocMetadata m) {
    final h = <String, String>{};
    if (m.title != null) h['X-Doc-Title'] = _ascii('--title', m.title!, deriveHint: true);
    if (m.description != null) {
      h['X-Doc-Description'] = _ascii('--description', m.description!);
    }
    if (m.tags != null) h['X-Doc-Tags'] = _ascii('--tags', m.tags!.join(','));
    if (m.slug != null) h['X-Doc-Slug'] = _ascii('--slug', m.slug!);
    return h;
  }

  /// Guard an `X-Doc-*` header value. dart:io cannot transmit non-ASCII header
  /// bytes (see [isAsciiHeaderSafe]), so reject with a clear, actionable error
  /// rather than letting a `FormatException` surface as an opaque transport
  /// failure. For the title, point at the UTF-8-safe alternative: put it in the
  /// body as an H1 and omit the flag (the backend derives it).
  String _ascii(String flag, String value, {bool deriveHint = false}) {
    if (isAsciiHeaderSafe(value)) return value;
    final hint = deriveHint
        ? ' For a non-ASCII title, make it the document\'s first-level heading '
            '(# Heading) and omit --title — the server derives the title from it.'
        : ' Header metadata must be ASCII (the document body may be any UTF-8).';
    throw CliException(
      '$flag contains non-ASCII characters, which cannot be sent in an HTTP '
      'header from Dart.$hint',
      exitCode: ExitCodes.usage,
    );
  }

  /// Map a non-2xx response to a [CliException] via the typed [ApiError]
  /// envelope (JSON bodies) or the bare status code (HTML/text bodies).
  void _throwIfError(Response<dynamic> res, {bool bytesBody = false}) {
    final status = res.statusCode ?? 0;
    if (status >= 200 && status < 300) return;
    dynamic data = res.data;
    if (bytesBody && data is List<int>) {
      try {
        data = jsonDecode(utf8.decode(data));
      } catch (_) {
        data = null; // non-JSON body (e.g. a plain-text 404) → bare-status path
      }
    } else if (data is String) {
      try {
        data = jsonDecode(data);
      } catch (_) {
        data = null;
      }
    }
    throw CliException.fromApi(ApiError.fromResponse(status, data));
  }

  Map<String, dynamic> _asMap(Response<dynamic> res) {
    final data = res.data;
    if (data is Map) return Map<String, dynamic>.from(data);
    if (data is String) {
      final decoded = jsonDecode(data);
      if (decoded is Map) return Map<String, dynamic>.from(decoded);
    }
    if (data is List<int>) {
      final decoded = jsonDecode(utf8.decode(data));
      if (decoded is Map) return Map<String, dynamic>.from(decoded);
    }
    throw CliException('unexpected non-object response from ${res.requestOptions.path}');
  }
}
