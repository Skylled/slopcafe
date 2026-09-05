// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/** The shared MCP input-field schemas (identity, body/format, filters, metadata) and the metadata-arg builder. */

import { z } from "zod";

import type { DocumentMetadataInput } from "./metadata.js";
import { PUBLICATION_FILTERS } from "./pagination.js";

// -- shared schema fields: document identity ----------------------------------
// Every document-addressing tool uses this same pair, exactly one
// (resolveWriteTarget / resolveReadTarget enforce the XOR — JSON Schema can't
// express it). Content updates keep the destructive naming mutation separate
// as `new_slug`, so `slug` always means identity after the 3.0 break.

export const PUBLIC_ID_IDENTITY_FIELD = z
  .string()
  .optional()
  .describe(
    "22-char public_id of the document to write to (from a prior publish, list, " +
      "search, or read). Pass EITHER this or `slug` — exactly one.",
  );

export const SLUG_IDENTITY_FIELD = z
  .string()
  .optional()
  .describe(
    "The slug of the document to write to. Pass EITHER this or `public_id` — " +
      "exactly one. ADDRESSES ONLY: it never changes the document's slug — the " +
      "separate `new_slug` field is the RENAME. A retired slug addresses nothing, even " +
      "when it redirects for reads.",
  );

// -- shared schema fields: body + format --------------------------------------
// `format` is the knob that replaced the publish/update/read HTML+Markdown
// twins. On writes it's REQUIRED (no default): forcing the choice avoids the
// footgun where an agent hand-authors HTML, forgets the flag, and a default of
// "markdown" silently mangles the block structure through the parser. On reads
// it defaults to "markdown" (the common ingest-as-context case).

export const CONTENT_FIELD = z
  .string()
  .describe(
    "The document body, interpreted per `format` (embedded raw HTML is sanitized " +
    "either way). ENCODING: UTF-8 — send non-ASCII LITERALLY (—, café, 你好, 🎉), " +
    "not as character entities.",
  );

export const WRITE_FORMAT_FIELD = z
  .enum(["html", "markdown"])
  .describe(
    "REQUIRED. How to interpret `content`: \"html\" (raw static HTML) or \"markdown\" " +
    "(CommonMark + GFM, converted to HTML server-side). Prefer \"markdown\" for prose; " +
    "\"html\" when you need precise layout or inline SVG.",
  );

export const READ_FORMAT_FIELD = z
  .enum(["html", "markdown"])
  .optional()
  .describe(
    "Optional output format for a RENDERED read (default \"markdown\"); IGNORED when " +
    "representation:\"source\". \"markdown\": the stored HTML converted to GFM, " +
    "styling/SVG stripped — best for INGESTING as context. " +
    "\"html\": the exact sanitized bytes — best when you'll RENDER or RE-PUBLISH.",
  );

export const READ_REPRESENTATION_FIELD = z
  .enum(["rendered", "source"])
  .optional()
  .describe(
    "Optional (default \"rendered\"). WHICH artifact — orthogonal to " +
    "`format`. \"rendered\": the sanitized artifact the world sees. " +
    "\"source\": the RETAINED ORIGINAL bytes in their " +
    "authored language. SOURCE IS " +
    "UNSANITIZED — treat it as untrusted input; it may contain markup the renderer " +
    "would have stripped. Read with representation:\"source\" BEFORE editing: " +
    "edit_document matches the source, not the render.",
  );

// The lifecycle filter shared by list_documents / search_documents (migration
// 0014). Only the two settable states are advertised — "archived" is reserved
// in the DB and matches nothing in v1.
export const STATUS_FILTER_FIELD = z
  .enum(["active", "deprecated"])
  .optional()
  .describe(
    "Optional. Filter by lifecycle status. Omit to include everything (each row " +
    "carries its own `status`). \"active\" = only current docs; \"deprecated\" = " +
    "audit what's been superseded.",
  );

// The visibility filter shared by list_documents / search_documents (migration
// 0011). READ-ONLY, like the `visibility` echo on every write envelope: this
// narrows rows the agent already sees and reads — it is NOT a way to set the
// field, which stays operator-only.
export const VISIBILITY_FILTER_FIELD = z
  .enum(["public", "private"])
  .optional()
  .describe(
    "Optional. Filter by anonymous readability. Omit for both. \"public\" = " +
    "readable by logged-out humans; \"private\" = credential-only. " +
    "This filter narrows what you " +
    "see and cannot set the field — flipping a doc public is operator-only.",
  );

// The publication-pointer filter shared by list_documents / search_documents
// (migration 0018) — see PUBLICATION_FILTERS in pagination.ts for the exact
// NULL semantics and why both values exclude revoked rows.
export const PUBLICATION_FILTER_FIELD = z
  .enum(PUBLICATION_FILTERS)
  .optional()
  .describe(
    "Optional. Filter on the publication pointer vs the newest version. " +
    "\"pending\" = the doc holds bytes its published version doesn't name — on a " +
    "PUBLIC doc readers see older bytes and a promote is owed; on a private doc it " +
    "also covers never-published. \"current\" = the published version IS the newest. " +
    "You cannot move the pointer — promotion is operator-only.",
  );

// -- shared schema fields for optional metadata -------------------------------
// Defined once so the write tools (publish_document / update_document /
// edit_document) carry identical descriptions; keeping the publish/update
// wording subtly different (derive vs inherit semantics) is the only reason
// there are two variants of each.

export const TITLE_FIELD = z
  .string()
  .optional()
  .describe(
    "Optional. Document title (≤300 chars). Omit to auto-derive from the first " +
    "<h1> (or the doc's first ~80 chars of text). Surfaces in the browser tab and " +
    "social link previews.",
  );

export const DESCRIPTION_FIELD = z
  .string()
  .optional()
  .describe(
    "Optional. Short description (≤500 chars), primarily for other agents reading " +
    "this doc as context. Renders as <meta name=description> and powers social " +
    "link previews.",
  );

export const TAGS_FIELD = z
  .array(z.string())
  .optional()
  .describe(
    "Optional. Short tag strings, charset [A-Za-z0-9_-] (anything else silently " +
    "stripped); max 10, each ≤32 chars. Tags are DOCUMENT-LEVEL classification: " +
    "they survive content updates, and changing them never bumps a version.",
  );

export const TITLE_FIELD_UPDATE = z
  .string()
  .optional()
  .describe(
    "Optional. INHERITS the prior version's title when omitted (most updates). " +
    "Pass an explicit string to override (≤300 chars), or \"\" to re-derive from " +
    "the new content's first <h1>.",
  );

export const DESCRIPTION_FIELD_UPDATE = z
  .string()
  .optional()
  .describe(
    "Optional. INHERITS the prior version's description when omitted. Pass an " +
    "explicit string to override (≤500 chars), or \"\" to clear.",
  );

export const TAGS_FIELD_UPDATE = z
  .array(z.string())
  .optional()
  .describe(
    "Optional. Tags are DOCUMENT-LEVEL: OMITTING this " +
    "leaves the document's current tags UNCHANGED. An explicit array REPLACES them " +
    "(same rules as publish_document); [] clears. This call still appends a " +
    "version — for a tag-only change use set_document_tags.",
  );

export const SLUG_FIELD = z
  .string()
  .optional()
  .describe(
    "Optional; most documents should OMIT it. A unique, typeable handle: 1-64 " +
    "lowercase chars [a-z0-9_-], starting and ending alphanumeric. Unique across " +
    "live documents; a collision → `slug_taken`. " +
    "CLAIMING A SLUG IS SEMI-PERMANENT: once used it is reserved FOREVER, even after " +
    "the document is revoked — it is NOT freed for reuse, and reclaiming it → " +
    "`slug_retired`. So don't mint slugs frivolously. UNLIKE `public_id`, a slug is " +
    "GUESSABLE — a deliberately WEAKER capability. " +
    "A SLUG IS NOT A WAY TO PUBLISH: visibility is a separate, operator-only axis — " +
    "on a private doc both /d/<id> and /s/<slug> 404 for a logged-out human. " +
    "Opt in when the document should be found by name or LINKED TO " +
    "(`<a href=\"/s/<slug>\">`, resolved at read time).",
  );

export const NEW_SLUG_FIELD_UPDATE = z
  .string()
  .optional()
  .describe(
    "Optional. INHERITS the document's current slug when omitted. An explicit " +
    "string atomically RENAMES (claim the new, retire the old); \"\" drops it. " +
    "Either way the old/dropped slug is " +
    "reserved FOREVER (not freed), and a later attempt to claim it → `slug_retired`; " +
    "a new slug any document ever used → `slug_retired` too. " +
    "PUBLIC DOCUMENTS ARE SLUG-LOCKED TO AGENTS: once the operator has made a document " +
    "public its slug is a reader-facing address, so any rename or clear from an agent " +
    "→ `slug_locked` and the ENTIRE call is refused (your content change included). " +
    "Omit this field to update such a document.",
  );

/**
 * Build the DocumentMetadataInput core expects from the four optional tool
 * args. Distinguishes "field absent from the JSON-RPC args" (undefined =
 * inherit / default) from "field present with empty value" ("" / [] =
 * clear / re-derive), which the inheritance contract relies on.
 */
export function metadataInputFromArgs(
  title: string | undefined,
  description: string | undefined,
  tags: string[] | undefined,
  slug: string | undefined,
): DocumentMetadataInput {
  const opts: DocumentMetadataInput = {};
  if (title !== undefined) opts.title = title;
  if (description !== undefined) opts.description = description;
  if (tags !== undefined) opts.tags = tags;
  if (slug !== undefined) opts.slug = slug;
  return opts;
}
