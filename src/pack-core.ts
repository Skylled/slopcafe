// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/**
 * Context-pack assembly (docs/design/context-packs-design.md, issue #21) — a
 * PURE MOVE out of core.ts (GitHub issue #53, zero logic edits). Both pack
 * roots — the query root (`packSearchHitsCore`, fed by searchDocumentsCore's
 * already-ranked hits) and the document/manifest root (`loadContextPackCore`,
 * resolving a slug/public_id to a live root then a manifest-or-links member
 * list) — converge on the shared budgeted fill stage `fillPack`.
 *
 * Edge is strictly ONE-WAY: this module imports core.ts (the listing
 * projection constants, the read cores, `parseStoredTags`) and the pure
 * `pack.ts` helpers; core.ts imports nothing from here. `findDocumentByPublicIdCore`
 * moved too — it's pack-specific (revoked rows included, so a manifest naming
 * a killed doc reports `revoked` rather than a generic miss) but is also the
 * lookup behind `GET /admin/documents/:public_id`, hence still imported from
 * outside the pack surface.
 */

import type { Env } from "./env.js";
import { PUBLIC_ID_RE } from "./ids.js";
import { validateSlugInput } from "./metadata.js";
import {
  extractOutboundLinks,
  type ManifestMember,
  parsePackManifest,
  selectWithinBudget,
} from "./pack.js";
import { htmlToMarkdown } from "./sanitizer.js";
import {
  type DocumentListing,
  findDocumentBySlugCore,
  findSlugTombstoneCore,
  LISTING_JOINS,
  LISTING_SELECT_COLUMNS,
  type PackDocument,
  type PackOmitted,
  type PackResponse,
  parseStoredTags,
  readDocumentCore,
  readDocumentSourceCore,
  readDocumentTextCore,
  resolvePublicIdBySlug,
  type SearchHit,
} from "./core.js";

// -- context packs (docs/design/context-packs-design.md, issue #21) -----------

/** The fill knobs every pack root shares (already clamped via clampPackKnobs). */
export type PackFillOptions = {
  budgetBytes: number;
  maxDocuments: number;
  /** Include deprecated docs in the fill instead of omitting them (default false). */
  includeDeprecated: boolean;
};

/** One ranked/ordered fill candidate — a listing row plus the per-root extras
 * (query attribution from a SearchHit; the original reference + tier/hint for
 * a manifest/link member). */
type PackCandidate = DocumentListing & {
  /** The member reference as written (manifest line / link); falls back to the public_id. */
  ref?: string;
  score?: number;
  matched_field?: SearchHit["matched_field"];
  snippet?: string;
  tier?: "required" | "optional";
  hint?: string | null;
};

/** Project a candidate into its omitted[] entry (the pack's fetch-it-yourself menu). */
function packOmitEntry(c: PackCandidate, reason: PackOmitted["reason"]): PackOmitted {
  return {
    ref: c.ref ?? c.public_id,
    public_id: c.public_id,
    title: c.title,
    reason,
    size_bytes: c.current_size,
    superseded_by: c.superseded_by,
    hint: c.hint ?? null,
  };
}

/**
 * The shared "budgeted best-first body fill" stage every pack root converges on
 * (design §2): take candidates ALREADY IN ORDER (relevance rank for a query
 * root; authored order for a manifest), apply the lifecycle exclusion, run the
 * pure budget selector over the STORED render size (`current_size` — known
 * without a fetch), then fetch only the included bodies as markdown.
 *
 * Loud-over-silent throughout: a body is included WHOLE or omitted-and-reported
 * (never truncated); a deprecated candidate is reported with its
 * `superseded_by` so the caller can fetch the replacement instead; a fetch that
 * fails after selection is reported `unavailable` (and its bytes refunded from
 * `used_bytes`) rather than silently dropped. Body fetches are parallel —
 * bounded by maxDocuments (≤25).
 *
 * `used_bytes` counts STORED H bytes (the budget currency), not the returned
 * markdown (typically smaller) — so callers comparing `used_bytes` to summed
 * content lengths will see headroom, by design.
 */
async function fillPack(
  env: Env,
  candidates: PackCandidate[],
  opts: PackFillOptions,
): Promise<{ documents: PackDocument[]; omitted: PackOmitted[]; used_bytes: number }> {
  const omitted: PackOmitted[] = [];

  // Lifecycle exclusion (design §3.4): anything not active is held out of an
  // automatic fill unless explicitly included. v1 only ever stores
  // active/deprecated (archived is reserved + unsettable), so the omit reason
  // is uniformly "deprecated".
  const eligible: PackCandidate[] = [];
  for (const c of candidates) {
    if (c.status !== "active" && !opts.includeDeprecated) {
      omitted.push(packOmitEntry(c, "deprecated"));
    } else {
      eligible.push(c);
    }
  }

  const sel = selectWithinBudget(
    eligible,
    (c) => c.current_size ?? 0,
    opts.budgetBytes,
    opts.maxDocuments,
  );
  for (const o of sel.omitted) omitted.push(packOmitEntry(o.item, o.reason));

  // Fetch the winners' bodies (markdown — the uniform ingest representation;
  // design §3.2: a pack has deliberately NO format/representation axis).
  let used = sel.used_bytes;
  const documents: PackDocument[] = [];
  const reads = await Promise.all(
    sel.included.map((c) => readDocumentTextCore(env, c.public_id)),
  );
  reads.forEach((r, i) => {
    const c = sel.included[i]!;
    if (!r.ok) {
      // Selected but unfetchable (revoked between rank and read, R2 miss).
      // Refund its budget commitment — the slight under-fill is acceptable and
      // the omission is loud.
      omitted.push(packOmitEntry(c, "unavailable"));
      used -= c.current_size ?? 0;
      return;
    }
    // Destructure `ref` OFF before the spread. A PackCandidate is a listing row
    // plus per-root extras; every extra except `ref` is re-assigned below, so a
    // bare `...c` would carry `ref` onto the response. PackDocument doesn't
    // declare it and openapi.json emits `additionalProperties: false`, so a
    // generated strict client (cli/, the Flutter app) would reject the member —
    // and only manifest/link packs set it, so the same /d/pack endpoint's shape
    // would differ between its two roots. `ref` still rides omitted[] entries
    // (packOmitEntry), which is where "which manifest line produced this" is
    // actually contracted.
    const { ref: _ref, ...listing } = c;
    documents.push({
      ...listing,
      content: r.text,
      format: "markdown",
      converter_v: r.converter_v,
      version: r.version_no,
      score: c.score ?? null,
      matched_field: c.matched_field ?? null,
      snippet: c.snippet ?? null,
      tier: c.tier ?? null,
      hint: c.hint ?? null,
    });
  });

  return { documents, omitted, used_bytes: used };
}

/**
 * The AUTOMATIC (query-root) pack — design §2/§3.1: amplify a search result
 * into a budgeted bulk read. The caller has already run searchDocumentsCore;
 * this packs its ranked hits. Lives on the search axis (no storage, ephemeral).
 */
export async function packSearchHitsCore(
  env: Env,
  query: string,
  hits: SearchHit[],
  opts: PackFillOptions,
): Promise<PackResponse> {
  const fill = await fillPack(env, hits, opts);
  return {
    pack: {
      source: "query",
      query,
      root: null,
      budget_bytes: opts.budgetBytes,
      max_documents: opts.maxDocuments,
      used_bytes: fill.used_bytes,
    },
    documents: fill.documents,
    omitted: fill.omitted,
  };
}

/**
 * Single-row listing lookup by public_id — the same projection as
 * listDocumentsCore / findDocumentBySlugCore (LISTING_SELECT_COLUMNS), but
 * INCLUDING revoked rows: the pack member-resolver needs to tell "revoked"
 * apart from "never existed" so a manifest naming a killed doc is reported
 * loudly (`omitted: revoked`) rather than as a generic miss. Callers that want
 * live-only must check `revoked_at` themselves.
 */
export async function findDocumentByPublicIdCore(
  env: Env,
  publicId: string,
): Promise<DocumentListing | null> {
  if (!PUBLIC_ID_RE.test(publicId)) return null;
  type Row = Omit<DocumentListing, "tags"> & { id: string; tags: string | null };
  const row = await env.META.prepare(
    `select ${LISTING_SELECT_COLUMNS}
     ${LISTING_JOINS}
     where d.public_id = ?
     limit 1`,
  )
    .bind(publicId)
    .first<Row>();
  if (!row) return null;
  const { id: _id, tags, ...rest } = row;
  return { ...rest, tags: parseStoredTags(tags) };
}

/**
 * Resolve one pack member reference — a slug or a public_id, one string —
 * to a listing row. Resolution order (deterministic, documented in the tool
 * description): a valid-slug-shaped ref tries the LIVE slug namespace first
 * (pack members are usually addressed by their human-given names), then a
 * PUBLIC_ID_RE-shaped ref tries the public_id namespace (which also catches
 * the revoked case). The shapes overlap only for a 22-char all-lowercase
 * string — vanishingly rare for a real base64url public_id, and the slug
 * interpretation winning there is the documented tiebreak.
 */
async function resolvePackRef(
  env: Env,
  ref: string,
): Promise<DocumentListing | null> {
  const slugShape = validateSlugInput(ref);
  if (slugShape.ok) {
    const bySlug = await findDocumentBySlugCore(env, slugShape.slug);
    if (bySlug.ok) return bySlug.document;
  }
  return findDocumentByPublicIdCore(env, ref);
}

/** Upper bound on member references resolved per pack load — a D1 fan-out
 * guard for pathological roots, far above the 25-doc fill cap. */
const PACK_MAX_MEMBER_REFS = 200;

export type LoadPackErr =
  | { ok: false; code: "not_found" }
  // The root reference was a slug that once existed and is permanently
  // retired (revoked / renamed / released — migration 0009).
  | { ok: false; code: "root_retired"; slug: string };

/**
 * The DOCUMENT/MANIFEST-root pack — design §2/§3.3 and the heart of "any
 * document can become a pack". Resolves `from` (slug or public_id) to a live
 * root document, derives its member list, and runs the same budgeted fill as
 * the query pack:
 *
 *   1. The retained source S is checked for a fenced ```pack manifest block
 *      (parsePackManifest). When present it WINS (precise overrides implicit):
 *      `source: "manifest"`, members in authored order, required tier before
 *      optional, per-entry hints echoed. A root with NO retained source (a
 *      pre-0008/un-backfilled doc) simply has no manifest — that's the §2
 *      continuum, not a legacy fallback, so it falls through to links rather
 *      than hard-failing source_unavailable like the edit path does.
 *   2. Otherwise the member list is the root's OUTBOUND LINKS — the
 *      `/d/<id>` + `/s/<slug>` (+ same-host absolute) targets in its sanitized
 *      H, in first-appearance order (`source: "document"`; zero ceremony).
 *
 * The root's own prose is returned as `pack.root.content` (markdown) and is
 * NOT counted against the budget — the caller asked for that document
 * explicitly; the budget governs the expansion. Self-references are dropped.
 * Unresolvable refs are loud `omitted: unavailable` entries; refs naming a
 * revoked doc are `omitted: revoked`.
 *
 * `followRedirects` is the loud supersession-substitution opt-in (§3.1): a
 * deprecated member with a `superseded_by` pointer gets its REPLACEMENT added
 * to the fill in its place — while the deprecated original STILL appears in
 * `omitted[]` (reason `deprecated`, pointer echoed), so the swap is always
 * visible, never silent. Single-hop: a replacement that is itself deprecated
 * is not chased further. Without the flag the pointer is only surfaced.
 */
export async function loadContextPackCore(
  env: Env,
  from: string,
  opts: PackFillOptions & { followRedirects: boolean },
  originHost?: string,
): Promise<({ ok: true } & PackResponse) | LoadPackErr> {
  // --- resolve the root -------------------------------------------------------
  let rootId: string | null = null;
  const slugShape = validateSlugInput(from);
  if (slugShape.ok) {
    rootId = await resolvePublicIdBySlug(env, slugShape.slug);
    if (rootId === null) {
      // Distinguish a retired (once-real) slug from a never-claimed one, like
      // the read path does — but only when the ref can't be a public_id too.
      const tomb = await findSlugTombstoneCore(env, slugShape.slug);
      if (tomb && !PUBLIC_ID_RE.test(from)) {
        return { ok: false, code: "root_retired", slug: slugShape.slug };
      }
    }
  }
  if (rootId === null && PUBLIC_ID_RE.test(from)) rootId = from;
  if (rootId === null) return { ok: false, code: "not_found" };

  // Root render H: the prose for pack.root.content AND the link-expansion
  // source. (readDocumentCore also rejects revoked/missing → not_found.)
  const rootRead = await readDocumentCore(env, rootId);
  if (!rootRead.ok) return { ok: false, code: "not_found" };
  const rootHtml = new TextDecoder().decode(rootRead.bytes);
  const rootContent = htmlToMarkdown(rootHtml);

  // Manifest detection runs over the retained source S — the authored bytes.
  // No source (pre-0008/un-backfilled) ⇒ no manifest, NOT an error (see doc
  // comment above).
  let manifest: { found: boolean; members: ManifestMember[] } = { found: false, members: [] };
  const rootSource = await readDocumentSourceCore(env, rootId);
  if (rootSource.ok) manifest = parsePackManifest(rootSource.source);

  // --- assemble the ordered candidate list ------------------------------------
  type MemberRef = { ref: string; tier: "required" | "optional" | null; hint: string | null };
  const memberRefs: MemberRef[] = manifest.found
    ? manifest.members.map((m) => ({ ref: m.ref, tier: m.tier, hint: m.hint }))
    : extractOutboundLinks(rootHtml, originHost).map((l) => ({
        ref: l.value,
        tier: null,
        hint: null,
      }));

  const omittedPre: PackOmitted[] = [];
  const candidates: PackCandidate[] = [];
  const seenIds = new Set<string>([rootId]); // self-reference always excluded
  const pushCandidate = (listing: DocumentListing, m: MemberRef): void => {
    if (seenIds.has(listing.public_id)) return;
    seenIds.add(listing.public_id);
    candidates.push({
      ...listing,
      ref: m.ref,
      tier: m.tier ?? undefined,
      hint: m.hint,
    });
  };

  // Resolve every reference up front, in parallel (order-preserving). Capped
  // at PACK_MAX_MEMBER_REFS so a pathological root (a page with hundreds of
  // links) bounds its D1 fan-out — the cap is far above max_documents (25),
  // documented in the tool description, and only trims what could never have
  // been filled anyway.
  const cappedRefs = memberRefs.slice(0, PACK_MAX_MEMBER_REFS);
  const resolved = await Promise.all(cappedRefs.map((m) => resolvePackRef(env, m.ref)));

  for (let i = 0; i < cappedRefs.length; i++) {
    const m = cappedRefs[i]!;
    const listing = resolved[i]!;
    if (!listing) {
      // Also catches a self-reference by the root's own (cleared) slug — fine:
      // an unresolvable ref is loud either way.
      if (m.ref !== rootId) {
        omittedPre.push({
          ref: m.ref,
          public_id: null,
          title: null,
          reason: "unavailable",
          size_bytes: null,
          superseded_by: null,
          hint: m.hint,
        });
      }
      continue;
    }
    if (listing.revoked_at !== null) {
      omittedPre.push({
        ref: m.ref,
        public_id: listing.public_id,
        title: listing.title,
        reason: "revoked",
        size_bytes: null,
        superseded_by: listing.superseded_by,
        hint: m.hint,
      });
      continue;
    }
    // Loud supersession substitution (opt-in): swap in the replacement, keep
    // the original visible in omitted[]. Plain deprecated (no flag / no
    // pointer) is left for fillPack's lifecycle exclusion to report.
    if (
      opts.followRedirects &&
      listing.status !== "active" &&
      !opts.includeDeprecated &&
      listing.superseded_by !== null
    ) {
      omittedPre.push(packOmitEntry({ ...listing, ref: m.ref, hint: m.hint }, "deprecated"));
      const target = await findDocumentByPublicIdCore(env, listing.superseded_by);
      if (target && target.revoked_at === null) pushCandidate(target, { ...m, ref: target.public_id });
      continue;
    }
    pushCandidate(listing, m);
  }

  // Manifest tiering: required members fill before optional ones (stable
  // within each tier). The one-way [optional] switch already orders most
  // manifests this way; the partition makes it a guarantee.
  const ordered = manifest.found
    ? [
        ...candidates.filter((c) => c.tier !== "optional"),
        ...candidates.filter((c) => c.tier === "optional"),
      ]
    : candidates;

  const fill = await fillPack(env, ordered, opts);
  return {
    ok: true,
    pack: {
      source: manifest.found ? "manifest" : "document",
      query: null,
      root: {
        public_id: rootId,
        slug: rootRead.slug,
        title: rootRead.title,
        content: rootContent,
        format: "markdown",
      },
      budget_bytes: opts.budgetBytes,
      max_documents: opts.maxDocuments,
      used_bytes: fill.used_bytes,
    },
    documents: fill.documents,
    omitted: [...omittedPre, ...fill.omitted],
  };
}
