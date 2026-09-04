// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/**
 * Lifecycle adjustment for the default hybrid-search ranking.
 *
 * Deprecated documents remain candidates: this is a modest score penalty, not
 * a filter or an active-first partition. A deprecated hit that ranks strongly
 * in both retrieval legs can therefore still beat a weaker active hit. The
 * multiplier is intentionally close to 1; at the default RRF k=60 it moves a
 * one-leg hit roughly three ranks, enough to break a comparable-relevance tie
 * without burying historical material.
 */
export const DEPRECATED_HYBRID_SCORE_MULTIPLIER = 0.95;

/** Extra FTS candidates retained so the post-fusion adjustment can cross the public cutoff. */
export const HYBRID_RERANK_CANDIDATE_BUFFER = 10;

export function applyHybridLifecyclePenalty<
  T extends { public_id: string; score: number; status: string },
>(hits: readonly T[], enabled: boolean): T[] {
  if (!enabled) return [...hits];

  return hits
    .map((hit) =>
      hit.status === "deprecated"
        ? { ...hit, score: hit.score * DEPRECATED_HYBRID_SCORE_MULTIPLIER }
        : hit,
    )
    .sort((a, b) =>
      (b.score - a.score) ||
      (a.public_id < b.public_id ? -1 : a.public_id > b.public_id ? 1 : 0),
    );
}
