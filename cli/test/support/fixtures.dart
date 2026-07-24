// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/// Canned response bodies for the command-layer tests, in the **wire** shape
/// (`snake_case`, every required field present) rather than as model objects —
/// so the generated `fromJson` glue is exercised on the way in, exactly as it is
/// against the real server. If a contract re-pin drops a required field, these
/// stop decoding and the suite says so.
library;

/// A `WriteResponse` (POST /d, PUT /d/:id).
Map<String, dynamic> writeOk({
  String publicId = 'ABCDEFGHIJKLMNOPQRSTUV',
  int version = 2,
  String? title = 'Q3 report',
  String? slug,
}) =>
    {
      'public_id': publicId,
      'url': 'https://test.example/d/$publicId',
      'version': version,
      'size_bytes': 42,
      'sanitizer_v': 'ammonia-v1.5',
      'modified': false,
      'stripped': <String>[],
      'will_not_render': <String>[],
      'tags': <String>[],
      'source_sha256': null,
      'title': title,
      'description': null,
      'slug': slug,
    };

/// One `DocumentListing` row.
Map<String, dynamic> listingRow({
  String publicId = 'ABCDEFGHIJKLMNOPQRSTUV',
  String? slug = 'q3-report',
  String? title = 'Q3 report',
  int currentVer = 3,
}) =>
    {
      'public_id': publicId,
      'created_at': '2026-01-01T00:00:00.000Z',
      'created_by_kind': 'agent',
      'tags': <String>[],
      'status': 'active',
      'visibility': 'private',
      'current_ver': currentVer,
      'title': title,
      'slug': slug,
    };

/// A `ListDocumentsResponse` — `[]` is the "slug matches no live document" answer.
Map<String, dynamic> listOk([List<Map<String, dynamic>>? documents]) => {
      'documents': documents ?? [listingRow()],
      'next_cursor': null,
    };

/// A `ReadSourceResponse` (GET /d/:id/source).
Map<String, dynamic> sourceOk({
  String source = '# Q3\n\nWidget revenue.\n',
  String format = 'markdown',
  int version = 3,
  String? slug = 'q3-report',
}) =>
    {
      'source': source,
      'source_format': format,
      'version_no': version,
      'sanitizer_v': 'ammonia-v1.5',
      'stripped': <String>[],
      'will_not_render': <String>[],
      'tags': <String>['finance'],
      'status': 'active',
      'unsanitized': true,
      'source_sha256': 'a' * 64,
      'title': 'Q3 report',
      'description': null,
      'slug': slug,
      'superseded_by': null,
    };

/// One `PackDocument` (a pack member body).
Map<String, dynamic> packMember({
  String publicId = 'MEMBERAAAAAAAAAAAAAAAA',
  String? slug = 'member-one',
  String content = '# Member\n\nbody\n',
}) =>
    {
      'public_id': publicId,
      'created_at': '2026-01-01T00:00:00.000Z',
      'created_by_kind': 'agent',
      'tags': <String>[],
      'status': 'active',
      'visibility': 'private',
      'content': content,
      'format': 'markdown',
      'converter_v': 'awh-md-v1',
      'version': 1,
      'title': 'Member one',
      'slug': slug,
    };

/// A `PackResponse` — the one envelope BOTH pack roots return (`GET /d/pack`
/// and `GET /d/search?include_bodies=true`).
Map<String, dynamic> packOk({
  String source = 'manifest',
  String? query,
  bool withRoot = true,
  List<Map<String, dynamic>>? documents,
  List<Map<String, dynamic>> omitted = const [],
  int usedBytes = 120,
  int budgetBytes = 65536,
  int maxDocuments = 8,
}) =>
    {
      'pack': {
        'source': source,
        'query': query,
        'root': withRoot
            ? {
                'public_id': 'ROOTAAAAAAAAAAAAAAAAAA',
                'slug': 'pack-boot',
                'title': 'Boot pack',
                'content': '# Boot\n',
                'format': 'markdown',
              }
            : null,
        'budget_bytes': budgetBytes,
        'max_documents': maxDocuments,
        'used_bytes': usedBytes,
      },
      'documents': documents ?? [packMember()],
      'omitted': omitted,
    };

/// A `HealthzResponse` (GET /healthz) — `service` is what `whoami` checks
/// before it will send the key anywhere.
Map<String, dynamic> healthzOk({String service = 'slopcafe'}) => {
      'ok': true,
      'service': service,
      'sanitizer_version': 'ammonia-v1.5',
      'storage_cap_bytes': 1073741824,
      'd1': {'documents': 7, 'agents': 1},
      'r2': {'bucket_reachable': true, 'sample_object_count': 7},
    };

/// A contract error envelope: `error` + `message` plus whatever
/// discriminant-specific context the code carries (`slug` on `slug_taken`, …).
Map<String, dynamic> errorBody(
  String code,
  String message, [
  Map<String, dynamic> extra = const {},
]) =>
    {'error': code, 'message': message, ...extra};
