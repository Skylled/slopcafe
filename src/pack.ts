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

// -- manifest parsing (design §3.3) -------------------------------------------

/** One parsed manifest line: a member reference (slug or public_id), its tier,
 * and the optional free-text hint ("when you'd want this"). */
export type ManifestMember = {
  ref: string;
  tier: "required" | "optional";
  hint: string | null;
};

/**
 * Parse the FIRST fenced ```pack block out of a document's retained source
 * (design §3.3b). Grammar is deliberately a dumb list:
 *
 *   - one member per line: `<slug-or-public_id>` optionally followed by
 *     whitespace + a free-text HINT (echoed on the member, and on its
 *     omitted[] entry — the menu-for-free);
 *   - `#` starts a comment — full-line, or trailing (whitespace + `#`).
 *     A hint therefore cannot start with `#`;
 *   - `[optional]` on its own line switches every subsequent member to the
 *     optional tier (required is the default; the switch is one-way — list
 *     must-reads first);
 *   - order preserved; duplicate refs keep their FIRST occurrence;
 *   - blank lines ignored.
 *
 * Returns `found: false` when no ```pack fence exists (the caller falls back
 * to outbound-link expansion — the §2 continuum). A present-but-empty block is
 * `found: true` with zero members: an explicit, deliberate empty pack.
 *
 * Member refs are NOT validated here (slug-vs-public_id classification and
 * resolution need the DB) — an unresolvable ref surfaces downstream as a loud
 * omitted[] entry, never a parse error.
 */
export function parsePackManifest(source: string): { found: boolean; members: ManifestMember[] } {
  // The opening fence: start-of-line ``` (3+ backticks) + "pack" + EOL. The
  // closing fence is a line of (at least as many) backticks. Tolerates \r\n.
  const open = /^(`{3,})pack[ \t]*\r?$/m.exec(source);
  if (!open) return { found: false, members: [] };
  const fence = open[1]!;
  const bodyStart = open.index + open[0].length + 1; // past the newline
  const rest = source.slice(bodyStart);
  const close = new RegExp(`^${fence}\`*[ \t]*\\r?$`, "m").exec(rest);
  const body = close ? rest.slice(0, close.index) : rest; // unterminated fence: read to EOF

  const members: ManifestMember[] = [];
  const seen = new Set<string>();
  let tier: ManifestMember["tier"] = "required";
  for (const rawLine of body.split("\n")) {
    const line = rawLine.replace(/\r$/, "").trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    if (/^\[optional\]$/i.test(line)) {
      tier = "optional";
      continue;
    }
    // Split `<ref>[ <hint or # comment>]` on the first whitespace run.
    const space = line.search(/\s/);
    const ref = space === -1 ? line : line.slice(0, space);
    let hint: string | null = space === -1 ? null : line.slice(space).trim();
    if (hint !== null && (hint.length === 0 || hint.startsWith("#"))) hint = null;
    if (seen.has(ref)) continue;
    seen.add(ref);
    members.push({ ref, tier, hint });
  }
  return { found: true, members };
}

// -- outbound-link extraction (design §3.3a) -----------------------------------

/** A link target extracted from a document body: which namespace it addressed. */
export type ExtractedLink =
  | { kind: "public_id"; value: string }
  | { kind: "slug"; value: string };

// Local copies of the two id shapes so this module stays dependency-free
// (PUBLIC_ID_RE canonically lives in serve.ts; the slug shape in metadata.ts —
// both are frozen contracts pinned by their own tests).
const LINK_PUBLIC_ID_RE = /^[A-Za-z0-9_-]{22}$/;
const LINK_SLUG_RE = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;

/**
 * Extract the on-platform document links from a SANITIZED HTML body (design
 * §3.3a — the zero-ceremony "any index page is a pack" path). Walks every
 * `href="…"` attribute (ammonia serializes attributes double-quoted) and
 * collects, in first-appearance order, deduped:
 *
 *   - relative `/d/<public_id>` and `/s/<slug>` links;
 *   - absolute `http(s)://<host>/d/…` and `/s/…` links ONLY when `host`
 *     matches the serving origin's host (passed by the caller) — a link to
 *     another site's /d/ path is someone else's namespace, not a member.
 *
 * Trailing sub-paths (`/raw`, `/text`, …), queries, and fragments are ignored
 * — only the bare document/slug address counts as a member reference (a link
 * to a doc's raw bytes is plumbing, not curation). Self-exclusion is the
 * caller's job (it knows the root's id/slug).
 */
export function extractOutboundLinks(html: string, originHost?: string): ExtractedLink[] {
  const links: ExtractedLink[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/href="([^"]*)"/g)) {
    const raw = m[1]!;
    let path: string;
    if (raw.startsWith("/")) {
      path = raw;
    } else if (/^https?:\/\//i.test(raw)) {
      // Absolute: only this deployment's own host counts.
      let host: string;
      let parsedPath: string;
      try {
        const u = new URL(raw);
        host = u.host.toLowerCase();
        parsedPath = u.pathname;
      } catch {
        continue;
      }
      if (!originHost || host !== originHost.toLowerCase()) continue;
      path = parsedPath;
    } else {
      continue; // anchors, mailto:, etc.
    }
    // Strip query/fragment from relative forms (URL pathname already did for
    // absolute ones).
    const clean = path.split(/[?#]/, 1)[0]!;
    const dm = /^\/d\/([^/]+)$/.exec(clean);
    const sm = /^\/s\/([^/]+)$/.exec(clean);
    let link: ExtractedLink | null = null;
    if (dm && LINK_PUBLIC_ID_RE.test(dm[1]!)) link = { kind: "public_id", value: dm[1]! };
    else if (sm && LINK_SLUG_RE.test(sm[1]!)) link = { kind: "slug", value: sm[1]! };
    if (!link) continue;
    const key = `${link.kind}:${link.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push(link);
  }
  return links;
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
