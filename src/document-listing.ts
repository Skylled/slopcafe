// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared vocabulary for querying and decoding document listings.
 *
 * List, search, packs, and link-graph reads all project the same
 * `DocumentListing` shape. Keep that projection, its joins, and the filters
 * whose SQL semantics must agree in this module rather than making those
 * read-oriented modules depend on the broad document write/read core.
 *
 * This is deliberately not a repository or a generic SQL helper. Operations
 * still own their queries; this module owns only the small pieces that must be
 * identical across those queries.
 */

import type { DocumentListing } from "./contract.js";
import { sanitizeTagsInput } from "./metadata.js";
import type { PublicationFilter } from "./pagination.js";

/** D1 row shape before the internal id is removed and tags are decoded. */
export type DocumentListingRow = Omit<DocumentListing, "tags"> & {
  id: string;
  tags: string | null;
};

/**
 * Parse the JSON-encoded tags column back into a string[]. Defensive against
 * legacy rows (NULL → []) and malformed JSON (→ []). The write contract is
 * valid JSON containing valid tags or NULL, but one bad row must not break a
 * listing surface.
 */
export function parseStoredTags(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    return sanitizeTagsInput(JSON.parse(raw));
  } catch {
    return [];
  }
}

/** Remove the internal id and decode document-level tags for the wire shape. */
export function decodeDocumentListing(row: DocumentListingRow): DocumentListing {
  const { id: _id, tags, ...rest } = row;
  return { ...rest, tags: parseStoredTags(tags) };
}

/**
 * The single shared DocumentListing projection. Consumers must alias the
 * documents table as `d`. The current-version and author joins intentionally
 * degrade to nulls for revoked documents whose version blobs were purged.
 */
export const DOCUMENT_LISTING_COLUMNS = `d.id, d.public_id, d.current_ver, d.published_ver, d.created_at, d.updated_at, d.revoked_at, d.slug, d.visibility, d.tags,
       d.status, d.superseded_by,
       a.name as created_by_name, d.created_by as created_by_id, d.created_by_kind,
       v.size_bytes as current_size, v.source_sha256 as current_source_sha256,
       v.created_at as current_version_at,
       v.author_kind as current_author_kind, v.author_agent_id as current_author_id,
       va.name as current_author_name, v.author_client_id as current_author_client_id,
       pv.source_sha256 as published_source_sha256,
       v.title, v.description`;

export const DOCUMENT_LISTING_JOINS = `from documents d
     left join agents a on a.id = d.created_by
     left join versions v on v.document_id = d.id and v.version_no = d.current_ver
     left join agents va on va.id = v.author_agent_id
     left join versions pv on pv.document_id = d.id and pv.version_no = d.published_ver`;

/**
 * Build one AND-style LIKE pattern for the JSON-encoded tags column.
 * Quotes anchor the complete tag, and `_` is escaped because it is both legal
 * in a tag and a SQLite LIKE wildcard. `%` cannot occur in a sanitized tag.
 */
export function documentTagLikePattern(tag: string): string {
  return `%"${tag.replace(/_/g, "\\_")}"%`;
}

/**
 * Null-safe publication-pointer filter shared by list and both search legs.
 * Revoked rows have no publication state and are excluded in both directions.
 * Visibility remains an orthogonal filter: public + pending is the operator's
 * review queue, while pending alone can intentionally include private drafts.
 */
export function documentPublicationClause(filter: PublicationFilter): string {
  return filter === "pending"
    ? "(d.revoked_at is null and d.published_ver is not d.current_ver)"
    : "(d.revoked_at is null and d.published_ver is not null and d.published_ver is d.current_ver)";
}
