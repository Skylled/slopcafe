// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/// The CLI's **read envelope** — what `read`/`get` emit under `--json`.
///
/// Field names deliberately mirror the MCP `read_document` envelope
/// (`content` / `format` / `version` / `sanitizer_v` / `converter_v` /
/// `representation` / `public_id` / `slug`, plus the source-only
/// `unsanitized` / `source_format` / `source_sha256` / `stripped` /
/// `will_not_render` / `title` / `description` / `tags` / `status` /
/// `superseded_by`), so an agent that has read a document over the connector
/// recognises the CLI's answer without a second mental model.
///
/// **Honesty rule: a key appears only when its value is genuinely known.**
/// The rendered reads (`--as text`, `--as html`, `get`) come back as a *body*
/// with headers, not as a JSON document, so the per-document metadata MCP
/// carries (title/description/tags/status/…) simply isn't on the wire. We
/// deliberately do NOT fabricate those keys as `null` — `"title": null` would
/// assert "this document has no title", which is a different claim from "this
/// response didn't say". A caller that needs them fetches the listing row
/// (`slopcafe find <slug> --json`, `slopcafe list --slug <slug> --json`) or
/// reads `--as source`, whose JSON endpoint carries the lot. Enriching the
/// rendered envelope automatically would cost an extra round trip on every
/// read, which a body fetch should not silently pay.
///
/// `null` IS used where the server itself uses it to mean *not applicable*:
/// `converter_v` on a non-markdown read (no converter ran), exactly as
/// `src/mcp.ts` does — that keeps the shape stable across `--as` values.
library;

import '../api/api.dart';

/// Envelope for a **rendered** read (`--as text` → markdown, `--as html` /
/// `get` → the sanitized HTML bytes).
///
/// [version] comes from the response `ETag`; [sanitizerV] / [converterV] from
/// the `X-Sanitizer-Version` / `X-Converter-Version` headers the `/text` route
/// sets (the raw-HTML route sets neither, so both are absent there — except
/// `converter_v`, which is a truthful `null`: no conversion happens on the HTML
/// path).
///
/// [publicId] is set when the read was addressed by (or resolved to) an id;
/// [slug] when it was addressed by slug. A `--follow`ed slug read passes
/// neither: the slug we asked for is the *retired* one, so echoing it as the
/// document's `slug` would be a lie, and the redirect target's id is not on the
/// wire.
Map<String, dynamic> renderedReadEnvelope({
  required String content,
  required String format,
  String? publicId,
  String? slug,
  int? version,
  String? sanitizerV,
  String? converterV,
  String? contentType,
}) {
  // On the HTML path no converter runs at all, so `null` is the *answer*, not a
  // gap — emit the key (same as src/mcp.ts) to keep the shape stable across
  // `--as` values. On the markdown path a missing value means the header didn't
  // arrive, which we don't claim to know: omit it.
  final converterKnownAbsent = format == 'html';
  return <String, dynamic>{
    if (publicId != null) 'public_id': publicId,
    if (slug != null) 'slug': slug,
    'representation': 'rendered',
    'content': content,
    'format': format,
    if (version != null) 'version': version,
    if (sanitizerV != null) 'sanitizer_v': sanitizerV,
    if (converterV != null || converterKnownAbsent) 'converter_v': converterV,
    if (contentType != null) 'content_type': contentType,
  };
}

/// Envelope for a **source** read (`--as source`), built from the
/// `GET /d/:id/source` JSON body.
///
/// Every field the endpoint returns is carried through; only the two names
/// change, to line up with MCP: `source` → `content` and `version_no` →
/// `version`. `format` echoes the authored language (`source_format`) so the
/// key means the same thing on every representation, and `converter_v` is an
/// explicit `null` — a source read runs no converter.
Map<String, dynamic> sourceReadEnvelope(
  ReadSourceResponse r, {
  required String publicId,
}) {
  return <String, dynamic>{
    'public_id': publicId,
    'representation': 'source',
    // The source is PRE-sanitization. Flagged first-class (as the server and
    // MCP both do) so a consuming agent's context can never silently treat it
    // as the safe, rendered view.
    'unsanitized': r.unsanitized,
    'content': r.source,
    'format': r.sourceFormat,
    'source_format': r.sourceFormat,
    'source_sha256': r.sourceSha256,
    'version': r.versionNo,
    'sanitizer_v': r.sanitizerV,
    'converter_v': null,
    'stripped': r.stripped,
    'will_not_render': r.willNotRender,
    'title': r.title,
    'description': r.description,
    'tags': r.tags,
    'slug': r.slug,
    'status': r.status,
    'superseded_by': r.supersededBy,
  };
}
