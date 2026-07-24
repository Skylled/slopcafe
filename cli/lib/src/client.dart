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

/// The result of a credentialed text/raw read: the body plus **every piece of
/// metadata the response actually carried** — the version (from the `ETag`),
/// the content type, and the `X-Sanitizer-Version` / `X-Converter-Version`
/// policy tags. Capturing the headers is what lets `--json` return a read
/// envelope (body + provenance) without a second request; `/text` sets both
/// version tags, `/raw` sets neither.
class ReadResult {
  ReadResult({
    required this.body,
    this.version,
    this.contentType,
    this.sanitizerVersion,
    this.converterVersion,
  });
  final List<int> body;
  final int? version;
  final String? contentType;

  /// `X-Sanitizer-Version` — which allowlist policy produced the stored bytes.
  final String? sanitizerVersion;

  /// `X-Converter-Version` — which HTML→Markdown emitter produced a `/text`
  /// body. Absent on the raw-HTML path (nothing is converted there).
  final String? converterVersion;

  String get text => utf8.decode(body, allowMalformed: true);
}

/// The outcome of [SlopcafeClient.probeAuth] — enough for `whoami` to say
/// something true rather than "not a 401, must be fine".
enum ProbeOutcome {
  /// `/healthz` is a Slopcafe instance AND the key was accepted.
  accepted,

  /// It is a Slopcafe instance, but the key was rejected (401/403).
  rejected,

  /// Something answered, but it is not a Slopcafe instance — almost always a
  /// wrong `base` (a proxy, a parked domain, another host entirely).
  notSlopcafe,

  /// A Slopcafe instance answered the auth probe with a status that means
  /// neither "accepted" nor "rejected" (a 5xx, a challenge page, …).
  unexpected,
}

/// What `whoami` learned: the outcome plus the evidence behind it.
class ProbeResult {
  const ProbeResult(this.outcome, {this.service, this.statusCode});

  final ProbeOutcome outcome;

  /// The `service` field `GET /healthz` reported (null when it wasn't a
  /// Slopcafe health envelope) — the proof the base URL is the right host.
  final String? service;

  /// The status of the step that decided the outcome (the health probe for
  /// [ProbeOutcome.notSlopcafe], else the auth probe).
  final int? statusCode;

  bool get accepted => outcome == ProbeOutcome.accepted;
}

/// A thin typed wrapper over the agent-key-reachable Slopcafe HTTP surface.
/// Every method throws a [CliException] on a non-2xx response (built from the
/// typed [ApiError] envelope when the body is JSON, else from the status code).
class SlopcafeClient {
  SlopcafeClient({required this.baseUrl, this.key, Dio? dio, Duration? timeout})
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
    // Transport budgets. dio's defaults are all null — i.e. NO bound at all on
    // the receive side — so a half-open connection (the Cloudflare/D1 flap the
    // operator's notes say to ride out: TLS accepted, Worker never answers)
    // wedges a headless run forever with no output and no exit code.
    //
    // The values are generous on purpose, because the legitimate slow cases are
    // real: a byte-exact publish streams a large body, and `GET /d/pack` can
    // return 256 KB after the server has run an embedding + N R2 fetches.
    //
    // The two dio budgets are NOT the same kind of bound — verified against
    // dio 5.9.2's `IOHttpClientAdapter`, do not assume symmetry:
    //   * `receiveTimeout` IS an inactivity bound — it caps
    //     "request sent → response headers" (`request.close().timeout(…)`) and
    //     then the gap between body chunks (`response_stream_handler.dart`), so
    //     a big-but-steady 256 KB pack download never trips it, only a stall.
    //   * `sendTimeout` is a **total-duration cap on the whole upload**:
    //     the adapter wraps `request.addStream(body).timeout(sendTimeout)`,
    //     which only completes once the LAST byte is written. A perfectly
    //     healthy but slow uplink therefore aborts at the deadline even while
    //     bytes are flowing every few milliseconds.
    //
    // That asymmetry is why send gets its OWN, much larger default rather than
    // sharing the receive budget. Sizing: the server's `MAX_INPUT_BYTES` is
    // 5 MiB, so the default has to cover a worst-case legitimate publish on a
    // bad link. At [defaultSendTimeout] that is a floor of ~17 KB/s sustained —
    // slow enough to cover tethering or a throttled hotel uplink, while still
    // capping a genuinely wedged upload at a few minutes instead of forever.
    // A shared 60s budget would have meant ~87 KB/s, which real links miss, and
    // byte-exact publishing (the CLI's headline feature) would fail on exactly
    // the large documents it exists to serve.
    //
    // Connect is the other exception: a TCP+TLS handshake to the edge either
    // happens in a second or is not happening, so it gets its own short cap.
    // `--timeout` can only LOWER connect and send, never raise them past their
    // defaults — it is a patience knob for a stuck run, not a way to widen the
    // handshake window.
    final transfer = timeout ?? defaultTransferTimeout;
    _dio.options
      // Set on `.options` (not only in BaseOptions above) so the injected-Dio
      // path a test uses gets the identical budget — same reasoning as the
      // headers below.
      ..connectTimeout = transfer < defaultConnectTimeout
          ? transfer
          : defaultConnectTimeout
      ..sendTimeout = timeout != null && timeout < defaultSendTimeout
          ? timeout
          : defaultSendTimeout
      ..receiveTimeout = transfer;

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

  /// Cap on the TCP+TLS handshake. `--timeout` can lower it, never raise it.
  static const defaultConnectTimeout = Duration(seconds: 15);

  /// Default RECEIVE budget (overridden by `--timeout`). An inactivity bound —
  /// a steady download of any size never trips it, only a stall does.
  static const defaultTransferTimeout = Duration(seconds: 60);

  /// Default SEND budget — a hard cap on total upload duration, not an
  /// inactivity bound (see the constructor comment). Sized so a 5 MiB
  /// byte-exact publish survives a ~17 KB/s link; do not collapse it back into
  /// [defaultTransferTimeout].
  static const defaultSendTimeout = Duration(seconds: 300);

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
        exitCode: ExitCodes.notFound,
        errorCode: ErrorCode.notFound.wire,
        status: 404,
        fields: {'public_id': publicId},
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
    final res = await _searchRequest(
      q: q,
      mode: mode,
      tags: tags,
      slug: slug,
      status: status,
      limit: limit,
    );
    return SearchDocumentsResponse.fromJson(_asMap(res));
  }

  /// `GET /d/search?include_bodies=true` — the **query-rooted context pack**:
  /// the same hybrid search, amplified into a budgeted bulk read. The server
  /// walks the ranked hits best-first and includes each **whole** body (as
  /// markdown) until a knob binds; the rest are reported in `omitted[]`, never
  /// truncated.
  ///
  /// This is the "brief me on TOPIC" read for an agent with no known starting
  /// document — the counterpart to [loadPack], which needs a root. `200`
  /// switches from `{documents}` to the same [PackResponse] envelope
  /// [loadPack] returns, which is why both decode into one type here.
  ///
  /// Knobs are **clamped, not rejected** by the server (`budget_bytes` 1024 –
  /// 262144, default 65536; `max_documents` max 25, default 8), so the CLI
  /// passes them through unvalidated beyond "is it an integer".
  Future<PackResponse> searchPack({
    required String q,
    String? mode,
    List<String>? tags,
    String? slug,
    String? status,
    int? limit,
    int? budgetBytes,
    int? maxDocuments,
    bool includeDeprecated = false,
  }) async {
    final res = await _searchRequest(
      q: q,
      mode: mode,
      tags: tags,
      slug: slug,
      status: status,
      limit: limit,
      pack: {
        'include_bodies': 'true',
        if (budgetBytes != null) 'budget_bytes': '$budgetBytes',
        if (maxDocuments != null) 'max_documents': '$maxDocuments',
        if (includeDeprecated) 'include_deprecated': 'true',
      },
    );
    return PackResponse.fromJson(_asMap(res));
  }

  /// The one `GET /d/search` request builder — shared so the plain and
  /// `include_bodies` forms can never drift on the filter params.
  Future<Response<dynamic>> _searchRequest({
    required String q,
    String? mode,
    List<String>? tags,
    String? slug,
    String? status,
    int? limit,
    Map<String, dynamic> pack = const {},
  }) async {
    final qp = <String, dynamic>{'q': q};
    if (mode != null && mode.isNotEmpty) qp['mode'] = mode;
    if (tags != null && tags.isNotEmpty) qp['tag'] = tags.join(',');
    if (slug != null && slug.isNotEmpty) qp['slug'] = slug;
    if (status != null && status.isNotEmpty) qp['status'] = status;
    if (limit != null) qp['limit'] = '$limit';
    qp.addAll(pack);
    final res = await _dio.get<dynamic>(
      '/d/search',
      queryParameters: qp,
      options: Options(
        responseType: ResponseType.json,
        headers: _authHeaders(require: true),
      ),
    );
    _throwIfError(res);
    return res;
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

  /// Resolve a document identifier to a `public_id`. When [identifier] is
  /// unambiguously `public_id`-shaped (and [isSlug] wasn't forced) it is
  /// returned unchanged with no network call; otherwise it is treated as a slug
  /// and resolved via `GET /d?slug=` (the 0-or-1 lookup). This is what lets the
  /// id-only routes (`PUT /d/:id`, `/source`, `/links`) be addressed by slug.
  /// Throws a [CliException] when a slug matches no live document.
  ///
  /// A 22-char lowercase name is AMBIGUOUS — it parses as both a `public_id`
  /// and a slug ([isAmbiguousDocIdentifier]) — and is resolved live-slug-first:
  /// probe `GET /d?slug=`, fall back to the `public_id` reading on a miss. The
  /// order mirrors the server's own either-or resolution (`GET /d/pack?from=`
  /// resolves live-slug before public_id). Keyless callers skip the probe (it
  /// is a credentialed GET) and keep the assume-id behavior.
  Future<String> resolveDocId(
    String identifier, {
    bool isSlug = false,
    bool isId = false,
  }) async {
    if (!isSlug && isId) return identifier;
    if (!isSlug && looksLikePublicId(identifier)) {
      // Ids with a char no slug can carry (any uppercase — virtually every
      // real id) skip the probe entirely, as do keyless callers.
      if (!isAmbiguousDocIdentifier(identifier) || key == null) {
        return identifier;
      }
      final probe = await listDocuments(slug: identifier, limit: 1);
      return probe.documents.isEmpty
          ? identifier
          : probe.documents.first.publicId;
    }
    final res = await listDocuments(slug: identifier, limit: 1);
    if (res.documents.isEmpty) throw slugNotFound(identifier);
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

  /// Two-step probe behind `whoami`: **is this a Slopcafe instance, and does
  /// the key work there?**
  ///
  /// Step 1 — `GET /healthz` (public) must return the health envelope with a
  /// `service` name. This is what makes the answer trustworthy: a base URL
  /// pointing at some other host (a proxy that 200s everything, a parked
  /// domain, a typo'd origin) is reported as [ProbeOutcome.notSlopcafe]
  /// instead of reading as success.
  ///
  /// Step 2 — a credentialed read of an all-zero (well-formed but never-minted)
  /// `public_id`. `401`/`403` = the key is **rejected**; `404` (the expected
  /// answer — the key got far enough to be told the document doesn't exist) or
  /// any `2xx` = **accepted**. Anything else is reported as
  /// [ProbeOutcome.unexpected] rather than silently counted as success, which
  /// is what the old `statusCode != 401` check did.
  Future<ProbeResult> probeAuth() async {
    if (key == null) throw _noKey();

    final health = await _dio.get<dynamic>(
      '/healthz',
      options: Options(responseType: ResponseType.json),
    );
    final service = _serviceName(health);
    if (service == null) {
      return ProbeResult(
        ProbeOutcome.notSlopcafe,
        statusCode: health.statusCode,
      );
    }

    final res = await _dio.get<dynamic>(
      '/d/AAAAAAAAAAAAAAAAAAAAAA/text',
      options: Options(headers: _authHeaders(require: true)),
    );
    final status = res.statusCode ?? 0;
    final outcome = switch (status) {
      401 || 403 => ProbeOutcome.rejected,
      404 => ProbeOutcome.accepted,
      >= 200 && < 300 => ProbeOutcome.accepted,
      _ => ProbeOutcome.unexpected,
    };
    return ProbeResult(outcome, service: service, statusCode: status);
  }

  /// The `service` field of a `GET /healthz` response, or null when the answer
  /// is not a Slopcafe health envelope (wrong status, non-JSON body, missing
  /// `ok`/`service`). Deliberately shape-based rather than value-based: a fork
  /// or a local `wrangler dev` reports its own service name and must still pass.
  String? _serviceName(Response<dynamic> res) {
    if (res.statusCode != 200) return null;
    Object? data = res.data;
    if (data is List<int>) {
      try {
        data = jsonDecode(utf8.decode(data));
      } catch (_) {
        return null;
      }
    } else if (data is String) {
      try {
        data = jsonDecode(data);
      } catch (_) {
        return null;
      }
    }
    if (data is! Map) return null;
    final service = data['service'];
    if (service is! String || service.isEmpty) return null;
    // `ok` pins it to the contract's envelope rather than any JSON that
    // happens to carry a `service` key.
    return data['ok'] is bool ? service : null;
  }

  CliException _noKey() => CliException(
    'no key configured — set --key, SLOPCAFE_KEY, or run `slopcafe config set key`',
    exitCode: ExitCodes.noPermission,
    errorCode: CliErrorCodes.noKey,
  );

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
      sanitizerVersion: res.headers.value('x-sanitizer-version'),
      converterVersion: res.headers.value('x-converter-version'),
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
        errorCode: ErrorCode.slugRedirected.wire,
        status: 409,
        fields: {'slug': slug, if (target != null) 'redirect_to': target},
      );
    }
    if (status == 410) {
      throw CliException(
        "the slug '$slug' is retired (410 Gone) and will never resolve again",
        exitCode: ExitCodes.notFound,
        errorCode: ErrorCode.gone.wire,
        status: 410,
        fields: {'slug': slug},
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
      if (require) throw _noKey();
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
      errorCode: CliErrorCodes.usage,
      fields: {'flag': flag},
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
    throw CliException(
      'unexpected non-object response from ${res.requestOptions.path}',
      errorCode: CliErrorCodes.badResponse,
      status: res.statusCode,
    );
  }
}
