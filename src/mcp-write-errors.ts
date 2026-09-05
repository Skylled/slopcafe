// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/** The MCP core-failure → agent-readable message mappers (publish/update/edit/status + slug rejects). */

import type { editDocumentCore, publishDocumentCore, updateDocumentCore } from "./document-write.js";
import type { setDocumentStatusCore } from "./document-lifecycle.js";
import type { SlugReject } from "./metadata.js";

/**
 * The one `not_found` message for a document addressed by public_id. Names both
 * recovery moves, and the field-shape mistake that produces this error most
 * often: passing a human-readable NAME where a 22-char capability id belongs.
 */
export const DOC_NOT_FOUND_TEXT =
  "no live document has that public_id (it may have been revoked). If you passed a " +
  "human-readable NAME like \"slopcafe-http-api\", that's a slug, not a public_id — " +
  "pass it as the `slug` field instead.";

/**
 * Map a publishDocumentCore failure into model-readable text. See
 * skills/connector-guide.md "Error mapping" for the canonical translations.
 *
 * These return the MESSAGE only — `textError(err.code, …)` prefixes the code, so
 * a message must never restate its own code (that's how you get
 * "invalid_slug: invalid slug: …"). Every message names a NEXT ACTION: a
 * condition with no recovery reads to an agent as "stop", and it stopped on
 * paths where a two-call workaround existed.
 */
export function translatePublishError(
  err: Extract<Awaited<ReturnType<typeof publishDocumentCore>>, { ok: false }>,
): string {
  switch (err.code) {
    case "empty_body":
      return "connector bug: empty content argument";
    case "too_large":
      return `document too large: ${err.size} bytes exceeds limit of ${err.limit}`;
    case "too_deep":
      return `document nesting too deep: ${err.depth} levels exceeds limit of ${err.limit} — flatten the markup (fewer wrapper elements)`;
    case "storage_cap_exceeded":
      return (
        `fleet storage cap exceeded: ${err.used}/${err.cap} bytes used, this write ` +
        `would add ${err.this_write}. Nothing an agent can free — revoke is ` +
        "operator-only — so report the cap to the operator instead of retrying"
      );
    case "invalid_slug":
      return slugReasonText(err.reason);
    case "slug_taken":
      return `slug "${err.slug}" is already in use by another LIVE document; choose a different slug (this one is claimable again only never — a revoked doc's slug is NOT freed either, it is retired)`;
    case "slug_retired":
      return `slug "${err.slug}" was previously used and is now retired; slugs are never reusable, so choose a different one`;
  }
}

/**
 * Map an updateDocumentCore failure. Handles the two update-only codes and
 * delegates the rest to translatePublishError — one copy of the shared write
 * failures, and the delegation still typechecks exhaustively (a new PublishErr
 * code with no case fails tsc there).
 */
export function translateUpdateError(
  err: Extract<Awaited<ReturnType<typeof updateDocumentCore>>, { ok: false }>,
): string {
  switch (err.code) {
    case "not_found":
      return DOC_NOT_FOUND_TEXT;
    case "version_conflict":
      return `version conflict, current is v${err.current_version} (you sent v${err.expected}); re-read the document, re-apply your change on top of v${err.current_version}, and retry`;
    // Migration 0018 / issue #43 — an UpdateErr code with no PublishErr twin, so
    // it must be handled here rather than falling through to the delegate (which
    // is typed to PublishErr and would not compile). Phrased as a retry
    // instruction because `textError` prefixes the code and the tool
    // descriptions promise these tokens drive an agent's retry loop: the
    // actionable move is to re-send without `new_slug`, not to give up.
    case "slug_locked":
      return "this document is public, and only the operator can change a public document's slug; re-send the update without a `new_slug` field to change the content, or ask the operator to rename it";
    default:
      return translatePublishError(err);
  }
}

/**
 * Map an editDocumentCore failure into model-readable text. Covers the
 * find/replace-specific codes, re-words the three body-size failures that read
 * differently after an edit, and delegates the rest to translateUpdateError
 * (the edit delegates its write to updateDocumentCore, so the messages should
 * match). The edit-specific messages echo the agent's own `old_string` back
 * (truncated) to help it self-correct — that's the agent's own input returned to
 * it, not a logged secret.
 */
/**
 * `set_document_status` failures. Small union, but it earns a translator for the
 * `bad_target` case: the core rejects a slug there with no explanation, and
 * "bad_target: bad target" would send an agent into a retry loop re-sending the
 * same slug. Name the two distinct causes and the fix.
 */
export function translateSetStatusError(
  err: Extract<Awaited<ReturnType<typeof setDocumentStatusCore>>, { ok: false }>,
): string {
  switch (err.code) {
    case "not_found":
      return DOC_NOT_FOUND_TEXT;
    case "bad_target":
      return (
        `superseded_by "${err.target}" does not name a usable replacement. It must be ` +
        "the 22-char PUBLIC_ID of a different LIVE document — a slug is never accepted " +
        "here (resolve one to its public_id with list_documents first), a revoked or " +
        "nonexistent document cannot be a successor, and a document cannot supersede " +
        "itself. Omit the field for \"superseded, no replacement\"."
      );
    case "invalid_status":
      // Unreachable from a schema-valid call: the input is z.enum(["active",
      // "deprecated"]), so anything else fails SDK validation before reaching
      // the core. Kept because SetStatusErr declares it and the switch is
      // exhaustive — and deliberately NOT advertised on the tool's ERRORS: line,
      // since a schema rejection is not a code-prefixed result.
      return "status must be \"active\" or \"deprecated\"";
  }
}

export function translateEditError(
  err: Extract<Awaited<ReturnType<typeof editDocumentCore>>, { ok: false }>,
): string {
  switch (err.code) {
    case "no_edits":
      return "no edits provided: pass at least one { old_string, new_string }";
    case "empty_old_string":
      return `edit ${err.edit_index + 1}: old_string is empty — provide the exact text to find`;
    case "noop_edit":
      return `edit ${err.edit_index + 1}: old_string and new_string are identical — nothing to change`;
    case "edit_no_match":
      return (
        `edit ${err.edit_index + 1}: old_string not found in the document's source. ` +
        "Match against the RETAINED SOURCE (read_document with " +
        "representation:\"source\") — Markdown for a Markdown doc, original HTML for an " +
        "HTML doc — NOT the rendered output or your original input. " +
        `Looking for: "${previewEditString(err.old_string)}"`
      );
    case "edit_not_unique":
      return (
        `edit ${err.edit_index + 1}: old_string matches ${err.count} times; make it ` +
        "unique by adding surrounding context, or pass replace_all: true to replace " +
        "every occurrence"
      );
    case "source_unavailable":
      // The old text said it "must be backfilled" — passive, no actor, and it
      // pointed at an operator route that DOES NOT EXIST (there is no source
      // backfill endpoint). Agents read that as "stop" and abandoned the task
      // even though a two-call recovery they can run unaided was available.
      return (
        "this document predates source retention, so find/replace has nothing to " +
        "match against. Recover WITHOUT the operator, in two calls: read_document " +
        "format:\"html\", apply your change to those bytes locally, then " +
        "update_document format:\"html\" (the whole-body replace). The re-published " +
        "version retains its source, so edit_document works on it from then on."
      );
    case "empty_body":
      return "the edit would leave the document empty — check the new_string values";
    case "too_large":
      return `document too large after edit: ${err.size} bytes exceeds limit of ${err.limit}`;
    case "too_deep":
      return `document nesting too deep after edit: ${err.depth} levels exceeds limit of ${err.limit} — flatten the markup`;
    default:
      return translateUpdateError(err);
  }
}

/**
 * Collapse + truncate an `old_string` for an error message so a multi-line or
 * very long find target doesn't dominate the response. Whitespace is flattened
 * to single spaces for readability; the agent has the original.
 */
export function previewEditString(s: string): string {
  const MAX = 80;
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= MAX ? flat : `${flat.slice(0, MAX)}…`;
}

/**
 * Map a SlugReject code to a one-line agent-readable message. Mirrors
 * formatSlugReject in src/index.ts so both transports surface the same
 * rule wording when the validator rejects an input.
 */
export function slugReasonText(reason: SlugReject): string {
  switch (reason) {
    case "empty":
      return "must be non-empty (pass \"\" to release an existing slug)";
    case "too_long":
      return "exceeds 64 characters";
    case "bad_charset":
      return "may only contain lowercase letters, digits, '-', '_'";
    case "must_start_alnum":
      return "must start with a lowercase letter or digit";
    case "must_end_alnum":
      return "must end with a lowercase letter or digit";
    case "reserved_prefix":
      return "uses the `slopcafe-docs-` prefix, which is reserved for platform documentation";
  }
}
