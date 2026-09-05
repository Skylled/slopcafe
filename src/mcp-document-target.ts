// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/** Document addressing + envelope helpers shared by the MCP tools: the visibility/publication echo, the write-target resolver, and the read_document envelope. */

import type { Visibility } from "./access.js";
import type { DocumentListing, OutboundLink } from "./contract.js";
import { findSlugTombstoneCore } from "./document-slug.js";
import { resolvePublicIdBySlug } from "./document-query.js";
import type { Env } from "./env.js";
import { textError } from "./mcp-error-result.js";
import type { ToolText } from "./mcp-tool-result.js";
import { slugReasonText } from "./mcp-write-errors.js";
import { validateSlugInput } from "./metadata.js";
import { findDocumentByPublicIdCore } from "./pack-core.js";

/**
 * The pair of "what will a human actually see?" fields every write envelope
 * echoes, read back from the document row in ONE query.
 *
 * `visibility` answers "is this URL reachable at all by a logged-out human"
 * (migration 0011); `published_version` answers "which version's bytes will they
 * get" (migration 0018, issue #43). Both exist for the same reason: an agent can
 * set NEITHER, so without the echo it would hand over a URL believing it shows
 * the bytes it just wrote. On a public document with a lagging promote, the
 * write succeeded, the version incremented, and the public page still shows
 * something older — a silent divergence the agent can neither observe nor fix.
 *
 * `published_version` is null when nothing has ever been promoted — the normal
 * state for a private document, and for a public one only if the
 * birth/flip/backfill invariant were ever broken. It is NOT null-by-definition
 * on a private document: promotion is deliberately allowed there so a version
 * can be staged BEFORE the door opens, and that staged value survives the flip
 * (setDocumentVisibilityCore coalesces). A non-null value on a private document
 * is therefore expected, not a broken invariant — it simply has no effect until
 * the document goes public. Reads through the listing row, so it costs the same
 * single query the visibility echo already paid.
 *
 * The row also carries the current-version-writer fields (`current_author_kind`/
 * `current_author_id`/`current_author_name`, issue #58, plus
 * `current_author_client_id`, issue #63) at no extra cost — the
 * same listing projection already resolves it (DOCUMENT_LISTING_COLUMNS). Only
 * `read_document` surfaces those three (a write/edit/curation response already
 * names its own author via the write cores; the read tool's default envelope
 * otherwise carried NONE, unless include_history was set) — write/edit/curation
 * call sites deliberately destructure just `visibility`/`published_version`
 * rather than spreading the whole object, so this stays additive there too.
 */
export async function currentEcho(
  env: Env,
  publicId: string,
): Promise<{
  visibility: Visibility | undefined;
  published_version: number | null;
  current_author_kind: "agent" | "operator" | null;
  current_author_id: string | null;
  current_author_name: string | null;
  current_author_client_id: string | null;
}> {
  const row = await findDocumentByPublicIdCore(env, publicId);
  return {
    visibility: row?.visibility,
    published_version: row?.published_ver ?? null,
    current_author_kind: row?.current_author_kind ?? null,
    current_author_id: row?.current_author_id ?? null,
    current_author_name: row?.current_author_name ?? null,
    current_author_client_id: row?.current_author_client_id ?? null,
  };
}

/** Resolved write target, or the ready-made error result to return. */
export type WriteTarget = { ok: true; publicId: string } | { ok: false; error: ToolText };

/**
 * Resolve every document-writing tool's EITHER `public_id` OR `slug` identity
 * down to a public_id.
 *
 * TWO PARAMS, NOT ONE POLYMORPHIC `id`: PUBLIC_ID_RE and the slug charset
 * OVERLAP on 22-char all-lowercase strings, so shape-sniffing a single field
 * would mis-route a slug that happens to look like a capability id (the same
 * reason read_document splits them). In the 3.0 contract this is consistently
 * named `slug` on every tool; update/edit use `new_slug` for the distinct
 * rename-or-clear mutation.
 *
 * Deliberately SIMPLER than read_document's resolver: a WRITE never follows a
 * retired slug's redirect. Writing "through" a forward would patch a document
 * the caller never named — a retired slug is a hard stop with the reason.
 */
export async function resolveWriteTarget(
  env: Env,
  publicId: string | undefined,
  slug: string | undefined,
): Promise<WriteTarget> {
  if (publicId !== undefined && slug !== undefined) {
    return {
      ok: false,
      error: textError(
        "bad_request",
        "pass exactly one of `public_id` or `slug`, not both",
      ),
    };
  }
  if (publicId !== undefined) return { ok: true, publicId };
  if (slug === undefined) {
    return {
      ok: false,
      error: textError("bad_request", "pass exactly one of `public_id` or `slug`"),
    };
  }
  const v = validateSlugInput(slug);
  if (!v.ok) return { ok: false, error: textError("invalid_slug", slugReasonText(v.reason)) };
  const bySlug = await resolvePublicIdBySlug(env, v.slug);
  if (bySlug !== null) return { ok: true, publicId: bySlug };
  const tomb = await findSlugTombstoneCore(env, v.slug);
  if (tomb) {
    return {
      ok: false,
      error: textError(
        "slug_retired",
        "that slug is retired (its document was revoked, or the slug was renamed or " +
          "released) and is never reused, so it addresses nothing. Find the live " +
          "document with search_documents or list_documents and write to its public_id" +
          (tomb.redirect_to
            ? `. The slug does forward to ${tomb.redirect_to} for READS, but a write is ` +
              "never routed through a redirect — name that document explicitly if it is " +
              "the one you meant."
            : "."),
      ),
    };
  }
  return {
    ok: false,
    error: textError(
      "not_found",
      "no live document has that slug, and no document ever claimed it. Check the " +
        "spelling, or find the document with search_documents or list_documents.",
    ),
  };
}

/**
 * Build the uniform read_document JSON envelope from any of the three branches
 * (rendered-markdown, rendered-html, source). Centralized so the three don't
 * drift into divergent inline objects.
 *
 * The base fields (public_id, representation, content, format, version,
 * sanitizer_v, converter_v, title/description/tags/slug) are ALWAYS present and
 * are the stable shape existing consumers (the Flutter app) depend on — keep
 * them in lockstep across branches. The SOURCE-only fields (`unsanitized`,
 * `source_format`, `stripped`, `will_not_render`) are emitted ONLY when the
 * source branch passes them, so a rendered read stays free of source-provenance
 * noise. (Provenance markers belong solely to the unsanitized source channel.)
 */
export function readEnvelope(input: {
  public_id: string;
  representation: "rendered" | "source";
  content: string;
  format: string;
  version: number;
  sanitizer_v: string;
  converter_v: string | null;
  title: string | null;
  description: string | null;
  tags: string[];
  slug: string | null;
  // Lifecycle classification (migration 0014) — document-level, so a
  // version-pinned read still reports the doc's CURRENT status/pointer.
  status: "active" | "deprecated" | "archived";
  superseded_by: string | null;
  // Anonymous readability (migration 0011) — also document-level. Undefined only
  // if the row couldn't be re-read; see currentEcho.
  visibility?: Visibility;
  // Which version the PUBLIC page serves (migration 0018 / issue #43) — also
  // document-level, so a version-pinned read still reports the live pointer.
  // Null on a private document (nothing is published). When this is behind
  // `version`, the bytes in this envelope are NOT what a logged-out human sees.
  published_version?: number | null;
  // The current version's writer (issue #58) — also document-level, also from
  // the currentEcho row. Trust-weighting signal: who last wrote the bytes in
  // this envelope, distinct from whoever created the document originally (which
  // this envelope doesn't carry at all — see DocumentListing's created_by_* for
  // that, on list/search/pack rows). Null together on a revoked doc (join
  // miss); id/name additionally null for an operator-written version.
  current_author_kind?: "agent" | "operator" | null;
  current_author_id?: string | null;
  current_author_name?: string | null;
  // WHICH OAuth client wrote it (issue #63) — the connector-grain answer
  // `current_author_id` can't give once one agent has more than one client.
  current_author_client_id?: string | null;
  // Source-only provenance. Omitted on a rendered read.
  unsanitized?: true;
  source_format?: string;
  // SHA-256 of the source bytes (migration 0015; null on a pre-0015 version) —
  // the currency token an agent caches for the cheap list-based check (#35).
  source_sha256?: string | null;
  stripped?: string[];
  will_not_render?: string[];
  // Set only when this read FOLLOWED a slug redirect (follow_redirects:true):
  // the retired slug the caller asked for, distinct from the slug actually read.
  redirected_from?: string;
  // Set only when include_history:true — the live version number + the full
  // newest-first version manifest (metadata only).
  current_version?: number;
  history?: Array<{
    version: number;
    created_at: string;
    size_bytes: number;
    source_format: string;
    title: string | null;
    is_current: boolean;
  }>;
  // Set only when include_links:true — the link-graph neighborhood (migration
  // 0016 / issue #40): who links here + where this doc links, with states.
  backlinks?: DocumentListing[];
  outbound_links?: OutboundLink[];
}): Record<string, unknown> {
  const envelope: Record<string, unknown> = {
    public_id: input.public_id,
    representation: input.representation,
    content: input.content,
    format: input.format,
    version: input.version,
    sanitizer_v: input.sanitizer_v,
    converter_v: input.converter_v,
    title: input.title,
    description: input.description,
    tags: input.tags,
    slug: input.slug,
    status: input.status,
    superseded_by: input.superseded_by,
  };
  if (input.visibility !== undefined) envelope.visibility = input.visibility;
  if (input.published_version !== undefined) envelope.published_version = input.published_version;
  if (input.current_author_kind !== undefined) envelope.current_author_kind = input.current_author_kind;
  if (input.current_author_id !== undefined) envelope.current_author_id = input.current_author_id;
  if (input.current_author_name !== undefined) envelope.current_author_name = input.current_author_name;
  if (input.current_author_client_id !== undefined)
    envelope.current_author_client_id = input.current_author_client_id;
  if (input.unsanitized !== undefined) envelope.unsanitized = input.unsanitized;
  if (input.source_format !== undefined) envelope.source_format = input.source_format;
  if (input.source_sha256 !== undefined) envelope.source_sha256 = input.source_sha256;
  if (input.stripped !== undefined) envelope.stripped = input.stripped;
  if (input.will_not_render !== undefined) envelope.will_not_render = input.will_not_render;
  if (input.redirected_from !== undefined) envelope.redirected_from = input.redirected_from;
  if (input.current_version !== undefined) envelope.current_version = input.current_version;
  if (input.history !== undefined) envelope.history = input.history;
  if (input.backlinks !== undefined) envelope.backlinks = input.backlinks;
  if (input.outbound_links !== undefined) envelope.outbound_links = input.outbound_links;
  return envelope;
}
