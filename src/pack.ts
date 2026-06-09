// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/**
 * src/pack.ts — the PURE logic behind context packs
 * (docs/design/context-packs-design.md, GitHub issue #21).
 *
 * A pack is "root → candidate documents → budgeted best-first body fill". This
 * module owns the parts of that pipeline that are plain string/array logic with
 * no I/O: the budget-fill selector (phase 2), and the manifest-block parser +
 * outbound-link extractor that turn a document into a candidate list (phase 3).
 * The impure orchestration (R2 GETs, htmlToMarkdown, D1 joins) lives in
 * core.ts.
 *
 * Standalone by design — no D1/R2/WASM/AI imports — so test/pack.test.mjs runs
 * it under the Node strip-types runner exactly like search.ts / edit.ts /
 * vector.ts / conditional.ts.
 */

/**
 * Budget knobs (context-packs-design §3.2). The budget is measured in BYTES OF
 * THE STORED RENDER H (`size_bytes`) — the only size known before fetching a
 * body — with tokens ≈ bytes/4 as the caller-facing rule of thumb. The
 * returned bodies are the markdown derivation, which is typically SMALLER than
 * the H bytes the budget counted, so the fill errs conservative.
 */
export const DEFAULT_BUDGET_BYTES = 64 * 1024; // ~16K tokens
export const MAX_BUDGET_BYTES = 256 * 1024;
export const MIN_BUDGET_BYTES = 1024;
export const DEFAULT_MAX_DOCUMENTS = 8;
export const MAX_MAX_DOCUMENTS = 25;

/**
 * Clamp caller-supplied pack knobs into their legal ranges. CLAMPED, not
 * rejected (the create_publish_credential ttl_seconds precedent): an
 * out-of-range ask degrades to the nearest legal value instead of turning a
 * generous request into a validation error. Non-integers/undefined fall back
 * to the defaults.
 */
export function clampPackKnobs(input: {
  budget_bytes?: number;
  max_documents?: number;
}): { budgetBytes: number; maxDocuments: number } {
  const clamp = (v: number | undefined, def: number, min: number, max: number): number =>
    typeof v === "number" && Number.isInteger(v) ? Math.min(max, Math.max(min, v)) : def;
  return {
    budgetBytes: clamp(input.budget_bytes, DEFAULT_BUDGET_BYTES, MIN_BUDGET_BYTES, MAX_BUDGET_BYTES),
    maxDocuments: clamp(input.max_documents, DEFAULT_MAX_DOCUMENTS, 1, MAX_MAX_DOCUMENTS),
  };
}

/** Why a candidate was left out of the fill (context-packs-design §3.2/§4). */
export type PackOmitReason =
  | "budget" // whole body didn't fit the remaining budget (include-whole-or-skip — NEVER truncated)
  | "max_documents" // the document-count cap bound first
  | "deprecated" // lifecycle status excluded it (pass include_deprecated to override)
  | "unavailable" // the body couldn't be fetched/resolved (R2 miss, unresolvable member ref)
  | "revoked"; // a manifest/link named a revoked document

export type BudgetSelection<T> = {
  included: T[];
  omitted: Array<{ item: T; reason: "budget" | "max_documents" }>;
  /** Stored-size bytes committed by the included set (the budget currency — H bytes, not markdown). */
  used_bytes: number;
};

/**
 * The budgeted best-first fill (context-packs-design §3.1/§3.2). Walks
 * `candidates` IN ORDER (the caller has already ranked them — relevance rank
 * for a query pack, authored order for a manifest) and includes each WHOLE
 * body that fits, skipping-and-reporting the ones that don't:
 *
 *   - include-whole-or-skip — a body is never truncated (loud-over-silent);
 *   - greedy skip-and-continue — a too-big candidate is reported `budget` and
 *     the walk continues, so a later smaller doc can still use the room;
 *   - first-binding-limit reporting — a candidate blocked while the count cap
 *     is already saturated reports `max_documents`; one blocked by remaining
 *     bytes reports `budget`;
 *   - no force-include — when even the FIRST candidate exceeds the whole
 *     budget the pack comes back empty with that candidate in `omitted[]`
 *     (review decision: always skip-and-report; the caller reads it directly
 *     or retries with a bigger budget).
 */
export function selectWithinBudget<T>(
  candidates: T[],
  sizeOf: (item: T) => number,
  budgetBytes: number,
  maxDocuments: number,
): BudgetSelection<T> {
  const included: T[] = [];
  const omitted: BudgetSelection<T>["omitted"] = [];
  let used = 0;
  for (const item of candidates) {
    if (included.length >= maxDocuments) {
      omitted.push({ item, reason: "max_documents" });
      continue;
    }
    const size = sizeOf(item);
    if (used + size > budgetBytes) {
      omitted.push({ item, reason: "budget" });
      continue;
    }
    included.push(item);
    used += size;
  }
  return { included, omitted, used_bytes: used };
}
