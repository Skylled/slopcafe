// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/**
 * Seeds the small set of bundled platform docs that agents must be able to
 * reach through the MCP tool surface (GitHub issue #4).
 *
 * WHY ONLY SOME DOCS. Every bundled doc is served at `/docs/<name>` — that is
 * Layer 1, and it is always correct because it ships with the code. But an
 * HTTP route is not reachable from `read_document` / `search_documents` /
 * `load_context_pack`, which is the entire tool surface a connector-only agent
 * has. So a doc that a TOOL DESCRIPTION or the discovery document instructs an
 * agent to read must also exist in the corpus, or the server is issuing an
 * instruction its own tools cannot satisfy. That rule — seed exactly what
 * something points at, everything else is a route — is why `seed: true` sits on
 * two entries in scripts/platform-docs.json and not on twenty-two.
 *
 * WHY THIS MAY WRITE TO THE ANONYMOUS SURFACE. Seeded docs are born public and
 * published in one step, skipping the operator promote that migration 0018
 * otherwise requires for bytes crossing to the open web. That is a deliberate,
 * narrow carve-out: the bytes come from the DEPLOYED CODE, so the operator who
 * ran the deploy is the same authority a promote would ask. It is bounded three
 * ways and must stay so — the content comes only from the build (never a
 * request), the slug is always in the reserved `slopcafe-docs-` namespace no
 * other writer may claim, and nothing here is reachable from an agent door.
 *
 * One request-derived value does reach the write, and the bound is worth stating
 * exactly rather than overclaiming: the `origin` this pass runs under comes from
 * the `/mcp` request that triggered it, and it scopes which absolute hrefs
 * `extractDocumentLinks` treats as on-platform. It cannot affect the stored
 * bytes — those are the bundle's — only which `document_links` rows are
 * recorded, a curation view that self-heals on the next write.
 *
 * DERIVED, NOT AUTHORITATIVE. The corpus copy is an index, exactly like the
 * Vectorize rows: best-effort, scheduled off the response path, and healed by
 * the next run. If it fails the docs still serve from `/docs/<name>`, which is
 * why failure here is logged rather than raised.
 */

import { PLATFORM_DOCS, type PlatformDoc } from "./generated/platform-docs.js";
import { RESERVED_SLUG_PREFIX } from "./metadata.js";
import {
  findSlugTombstoneCore,
  promoteVersionCore,
  publishDocumentCore,
  setDocumentStatusCore,
  updateDocumentCore,
} from "./core.js";
import type { WaitUntil } from "./vector-io.js";
import type { Env } from "./env.js";

/**
 * Isolate-scoped latch: the seed check runs at most once per isolate.
 *
 * There is no deploy hook on Workers, so "once per deploy" is approximated by
 * "once per isolate" — a fresh isolate after a deploy does one cheap check and
 * the first one through writes. It costs a couple of indexed D1 reads per
 * isolate, off the response path, and is self-healing: if a pass fails, the
 * next isolate retries.
 *
 * Concurrent isolates can race into the same first-publish. The loser hits the
 * partial UNIQUE INDEX on `documents.slug` and reports `failed`; the next pass
 * sees the winner's row and settles on `unchanged`. Losing that race is
 * harmless, which is why this is a plain latch rather than a lock.
 */
let seedCheckedInIsolate = false;

/** The seeder writes as the operator: a deploy is an operator action. */
const SEED_AUTHOR = { kind: "operator" } as const;

/** Slug a seeded doc is published under. The reserved namespace is what makes
 *  the name mean the same thing on every instance. */
export function seededSlug(name: string): string {
  return `${RESERVED_SLUG_PREFIX}${name}`;
}

/** One line per doc, for the operator-facing report. */
export type SeedOutcome = {
  name: string;
  slug: string;
  /**
   * `created`   — published for the first time.
   * `updated`   — bundle bytes differed from the stored source.
   * `unchanged` — stored source already matched the bundle exactly.
   * `blocked`   — the slug is retired; a human must release the tombstone.
   * `failed`    — the write errored; the next run retries.
   */
  action: "created" | "updated" | "unchanged" | "blocked" | "failed";
  detail?: string;
};

type SeedRow = {
  public_id: string;
  source_sha256: string | null;
  revoked_at: string | null;
  status: string;
  visibility: string;
};

/**
 * Run one seeding pass.
 *
 * Idempotent, and cheap in the steady state: for each seeded doc it reads one
 * row and compares the stored source hash to the bundle's. Equal means the
 * corpus already holds exactly these bytes and nothing is written — the same
 * question migration 0015's `source_sha256` was added to answer, and the same
 * one the identical-write collapse asks inside `updateDocumentCore`. (The
 * collapse would catch a redundant write anyway; checking here avoids sending
 * the body at all.)
 */
export async function seedPlatformDocsCore(
  env: Env,
  origin: string,
  waitUntil?: WaitUntil,
): Promise<SeedOutcome[]> {
  const results: SeedOutcome[] = [];

  for (const doc of PLATFORM_DOCS.filter((d) => d.seed)) {
    const slug = seededSlug(doc.name);
    try {
      results.push(await seedOne(env, doc, slug, origin, waitUntil));
    } catch (err) {
      // Never let one doc's failure abandon the rest, and never let any of it
      // reach the caller: this runs off the response path.
      results.push({
        name: doc.name,
        slug,
        action: "failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Wrapped, and deliberately NOT allowed to fail the pass: retirement is
  // housekeeping for docs this build no longer seeds, while `results` is the
  // report the operator route returns. Letting a housekeeping error propagate
  // would turn a run where every doc seeded correctly into an opaque 500 with
  // no per-doc detail — losing exactly the `blocked` line the caller needs.
  try {
    await retireUnseededDocs(env, results);
  } catch (err) {
    console.error(
      "platform-doc seed: retiring unseeded docs failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
  return results;
}

async function seedOne(
  env: Env,
  doc: PlatformDoc,
  slug: string,
  origin: string,
  waitUntil?: WaitUntil,
): Promise<SeedOutcome> {
  const row = await env.META.prepare(
    `select d.public_id as public_id, v.source_sha256 as source_sha256, d.revoked_at as revoked_at,
            d.status as status, d.visibility as visibility
       from documents d
       left join versions v on v.document_id = d.id and v.version_no = d.current_ver
      where d.slug = ?`,
  )
    .bind(slug)
    .first<SeedRow>();

  const meta = {
    title: doc.title,
    description: doc.description ?? undefined,
    tags: doc.tags,
    slug,
  };

  if (!row) {
    // No live document holds the slug. Before publishing, check whether the
    // name is RETIRED — a tombstone means someone (an operator revoking a
    // seeded doc, or a rename) permanently spent it, and `resolveSlug` would
    // refuse the claim. We do not force-release it: the tombstone contract
    // (migration 0009, issue #6) says a retired name is never reclaimed, and
    // the deploy has no standing to overrule a human who retired one. Report it
    // and move on — `/docs/<name>` is unaffected, so nothing is actually down.
    const tombstone = await findSlugTombstoneCore(env, slug);
    if (tombstone) {
      return {
        name: doc.name,
        slug,
        action: "blocked",
        detail: `slug is retired; release it with DELETE /admin/slugs/${slug} to allow seeding`,
      };
    }

    const created = await publishDocumentCore(
      env,
      doc.markdown,
      SEED_AUTHOR,
      origin,
      "markdown",
      meta,
      // Born public AND published in one step — the carve-out documented at the
      // top of this file. Every other publish path takes the instance default
      // (private) and waits for an operator.
      "public",
      waitUntil,
      // The one caller permitted to claim a reserved slug.
      true,
    );
    return created.ok
      ? { name: doc.name, slug, action: "created", detail: created.public_id }
      : { name: doc.name, slug, action: "failed", detail: created.code };
  }

  // A revoked row still holds no slug (revoke nulls it), so reaching here with
  // `revoked_at` set would mean the slug is live on a killed document — an
  // invariant violation rather than a state to paper over. Report, don't write.
  if (row.revoked_at !== null) {
    return { name: doc.name, slug, action: "failed", detail: "slug is live on a revoked document" };
  }

  if (row.source_sha256 === doc.sourceSha256) {
    // Bytes match — but CLASSIFICATION can have moved underneath us, and the
    // hash says nothing about it. `status` is agent-reachable by design (three
    // doors: PUT /d/:id/status, the operator route, and MCP set_document_status)
    // and carries no author guard, so any agent key can mark a seeded doc
    // `deprecated` with a `superseded_by` of its choosing. That matters here
    // more than for an ordinary document: a deprecated doc drops out of context
    // packs by default and reports its replacement, so the authoring contract
    // that MCP tool descriptions instruct every model to read would come back
    // marked superseded by an attacker-chosen document — with this server's own
    // tool descriptions vouching for the slug.
    //
    // Repairing it here is what makes "healed by the next run" true. Without
    // this branch the hash short-circuit above returns first and the state is
    // PERMANENT: retireUnseededDocs only ever sets `deprecated`, never back.
    if (row.status !== "active") {
      const repaired = await setDocumentStatusCore(env, row.public_id, "active", null);
      return repaired.ok
        ? { name: doc.name, slug, action: "updated", detail: `restored status active (was ${row.status})` }
        : { name: doc.name, slug, action: "failed", detail: `could not restore status (${repaired.code})` };
    }
    return { name: doc.name, slug, action: "unchanged" };
  }

  const updated = await updateDocumentCore(
    env,
    row.public_id,
    doc.markdown,
    // No expected version: the seeder is the only writer of this document by
    // construction (the slug is reserved), so there is no concurrent author to
    // guard against — and a stale-version refusal would strand the corpus copy
    // behind the deployed build until someone intervened.
    null,
    SEED_AUTHOR,
    origin,
    "markdown",
    meta,
    waitUntil,
    true,
  );
  if (!updated.ok) return { name: doc.name, slug, action: "failed", detail: updated.code };
  if (updated.unchanged) return { name: doc.name, slug, action: "unchanged" };

  // MOVE THE PUBLICATION POINTER. This is not optional and must never be
  // dropped: `publishDocumentCore` binds `published_ver` at public birth, but
  // `updateDocumentCore` writes NOTHING to it (by design — moving it is the
  // operator's promote verb). Without this call the seeded document's FIRST
  // version would be the one anonymous readers, agents and the operator all
  // keep seeing forever, while `/docs/<name>` served the new bytes: two public
  // URLs for one document, silently disagreeing. That is precisely the drift
  // this whole change exists to abolish, so re-creating it inside the seeder
  // would be the worst possible bug to ship here.
  //
  // The carve-out that justifies publishing at birth justifies this identically
  // — the bytes still come from the deployed code, and an operator who deployed
  // is the same authority a promote would ask.
  const promoted = await promoteVersionCore(env, row.public_id, updated.version);
  if (!promoted.ok) {
    return {
      name: doc.name,
      slug,
      action: "failed",
      detail: `stored v${updated.version} but could not promote it (${promoted.code}) — readers still see the previous version`,
    };
  }
  return { name: doc.name, slug, action: "updated", detail: `v${updated.version}` };
}

/**
 * Mark any document in the reserved namespace that this build no longer seeds
 * as `deprecated` — never revoked.
 *
 * Deprecating rather than revoking is the deliberate choice: revoke purges the
 * R2 bytes out from under anyone holding the URL, and — the reason that matters
 * here — it TOMBSTONES the slug, permanently, so a later build that re-adds the
 * doc could never reclaim its own name. Deprecation says the true thing ("this
 * is no longer current") while leaving the name recoverable and the page up.
 * A deprecated doc is already excluded from context-pack fills by default and
 * marked in every listing and read.
 */
async function retireUnseededDocs(env: Env, results: SeedOutcome[]): Promise<void> {
  const keep = new Set(results.map((r) => r.slug));
  const { results: rows } = await env.META.prepare(
    `select public_id, slug from documents
      where slug like ? escape '\\' and revoked_at is null and status = 'active'`,
  )
    .bind(`${RESERVED_SLUG_PREFIX.replace(/_/g, "\\_")}%`)
    .all<{ public_id: string; slug: string }>();

  for (const row of rows ?? []) {
    if (keep.has(row.slug)) continue;
    // The Result is checked rather than discarded: a failure here is benign
    // (most likely the row was revoked between the SELECT above and this call),
    // but silently dropping it would make a doc that never gets deprecated
    // indistinguishable from one that did.
    const marked = await setDocumentStatusCore(env, row.public_id, "deprecated", null);
    if (!marked.ok) {
      console.warn(`platform-doc seed: could not deprecate ${row.slug} (${marked.code})`);
    }
  }
}

/**
 * Fire-and-forget seed check, for the request path.
 *
 * Called on `/mcp` because that is the surface the corpus copy exists for: an
 * agent connecting over MCP is exactly the caller who needs `read_document
 * slug:"slopcafe-docs-…"` to resolve. Scheduled through `waitUntil` so it never
 * delays a response, and latched so it is one check per isolate rather than one
 * per request. Errors are swallowed and logged — the docs are already being
 * served from `/docs/<name>` regardless.
 */
export function maybeSeedPlatformDocs(env: Env, origin: string, waitUntil?: WaitUntil): void {
  if (seedCheckedInIsolate || !waitUntil) return;
  seedCheckedInIsolate = true;
  waitUntil(
    seedPlatformDocsCore(env, origin, waitUntil)
      .then((results) => {
        // Only the interesting outcomes. A steady-state pass is all `unchanged`
        // and logs nothing, so a line here always means something moved.
        const notable = results.filter((r) => r.action !== "unchanged");
        for (const r of notable) console.log(`platform-doc seed: ${r.slug} ${r.action}${r.detail ? ` (${r.detail})` : ""}`);
      })
      .catch((err) => {
        console.error("platform-doc seed failed:", err instanceof Error ? err.message : String(err));
      }),
  );
}
