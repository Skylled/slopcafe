/**
 * Pure find-and-replace logic behind the `edit_document` MCP tool and
 * `editDocumentCore` in core.ts.
 *
 * Why a standalone module (no D1/R2/sanitizer imports): the substitution
 * rules are the part worth unit-testing, and core.ts transitively imports
 * the WASM sanitizer, which can't load under Node's --experimental-strip-
 * types test runner. Keeping the string logic here lets test/edit.test.mjs
 * import it directly, exactly like search.ts → test/search.test.mjs. The
 * D1/R2/FTS plumbing in editDocumentCore is exercised end-to-end via
 * wrangler dev (no D1 mock in v1).
 *
 * Match semantics mirror Claude Code's Edit tool, applied to the RETAINED
 * SOURCE S — the bytes as the agent authored them (Markdown for a Markdown
 * doc, the original HTML for an HTML doc), which `editDocumentCore` loads from
 * R2 and hands us as that string. This is NOT the rendered/sanitized HTML (H):
 * an agent must read with `representation: "source"` before copying an
 * `old_string`, then `editDocumentCore` re-renders (md→html or identity) and
 * re-sanitizes the edited source into a fresh (S, H) pair:
 *   - `old_string` must be present. Zero matches is an error, not a no-op —
 *     a silent miss is the failure mode we're guarding against. The
 *     representation changed (we now match S, not H), but the loud-miss
 *     safety is unchanged: an `old_string` copied from a stale *rendered*
 *     read (H, or its markdown derivation M) won't be found in S whenever the
 *     two diverge (S ≠ H — e.g. the sanitizer touched the bytes, or the
 *     source is Markdown), so the agent gets a loud `edit_no_match` instead of
 *     editing text that isn't where they think it is.
 *   - A match that occurs more than once is ambiguous: error with the count
 *     unless `replace_all` is set. Picking one silently is a bug.
 *   - Edits apply sequentially — each edit operates on the result of the
 *     previous one, so a later `old_string` can match text an earlier
 *     `new_string` produced (matching Claude Code's multi-edit behavior).
 *
 * Replacement is LITERAL: neither `old_string` nor `new_string` is treated
 * as a pattern, and `new_string` is never interpreted for `$`-replacement
 * specials (we splice by index / split-join, never String.prototype.replace
 * with a string pattern, whose replacement honors `$&`/`$1`/`$$`).
 */

/** One find-and-replace operation. */
export type EditSpec = { old_string: string; new_string: string };

/**
 * Outcome of applying a list of edits to a string. On success, `html` is the
 * fully-edited text and `replacements` is the total number of occurrences
 * substituted across all edits (≥1). On failure, `edit_index` is the
 * zero-based position of the offending edit in the input array.
 */
export type ApplyEditsResult =
  | { ok: true; html: string; replacements: number }
  | { ok: false; code: "no_edits" }
  | { ok: false; code: "empty_old_string"; edit_index: number }
  | { ok: false; code: "noop_edit"; edit_index: number }
  | { ok: false; code: "edit_no_match"; edit_index: number; old_string: string }
  | { ok: false; code: "edit_not_unique"; edit_index: number; old_string: string; count: number };

/**
 * Count NON-OVERLAPPING occurrences of `needle` in `haystack`. Non-overlapping
 * is the count that matches what split/join (replace_all) and a single index
 * splice actually substitute, so the reported count never disagrees with the
 * number of replacements performed.
 */
export function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let pos = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, pos);
    if (idx === -1) break;
    count++;
    pos = idx + needle.length;
  }
  return count;
}

/**
 * Apply `edits` to `html` in order, returning the edited string or a
 * structured error. See the module doc comment for the match contract.
 *
 * `replaceAll` applies to every edit in the batch (matching the single
 * `replace_all` flag on the tool) — there's no per-edit override in v1.
 */
export function applyEdits(
  html: string,
  edits: EditSpec[],
  replaceAll: boolean,
): ApplyEditsResult {
  if (edits.length === 0) return { ok: false, code: "no_edits" };

  let current = html;
  let replacements = 0;

  for (let i = 0; i < edits.length; i++) {
    const { old_string, new_string } = edits[i]!;

    if (old_string.length === 0) {
      return { ok: false, code: "empty_old_string", edit_index: i };
    }
    if (old_string === new_string) {
      // A no-op edit is almost always a mistake (and would make `modified`
      // ambiguous); surface it rather than silently doing nothing.
      return { ok: false, code: "noop_edit", edit_index: i };
    }

    const count = countOccurrences(current, old_string);
    if (count === 0) {
      return { ok: false, code: "edit_no_match", edit_index: i, old_string };
    }
    if (count > 1 && !replaceAll) {
      return { ok: false, code: "edit_not_unique", edit_index: i, old_string, count };
    }

    if (replaceAll) {
      // split/join is literal on both sides — no regex, no $-substitution.
      current = current.split(old_string).join(new_string);
      replacements += count;
    } else {
      // Exactly one match: splice by index so `new_string` is inserted
      // verbatim (String.prototype.replace with a string would honor
      // `$&`/`$1`/`$$` in the replacement, which we don't want).
      const idx = current.indexOf(old_string);
      current = current.slice(0, idx) + new_string + current.slice(idx + old_string.length);
      replacements += 1;
    }
  }

  return { ok: true, html: current, replacements };
}
