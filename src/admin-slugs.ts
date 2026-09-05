// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/**
 * Operator-only retired-slug endpoints (migrations 0009/0010; issue #72 phase 4:
 * moved verbatim out of the former src/admin.ts). All three await the shared
 * `requireOperator` (src/session.ts) first.
 *
 *   POST   /admin/slugs/:slug/redirect         point a retired slug at a live doc
 *   DELETE /admin/slugs/:slug/redirect         drop a retired slug's redirect (back to 410)
 *   DELETE /admin/slugs/:slug                  force-release a retired slug (escape hatch)
 *
 * A retired slug is never reused silently: a redirect is LOUD (browser
 * interstitial / 409 slug_redirected), and `DELETE /admin/slugs/:slug` is the
 * ONLY path that un-retires a name. Neither the seeder nor the restore path
 * releases a tombstone on its own (remedy: this module).
 */

import { jsonError } from "./admin-response.js";
import { clearSlugRedirectCore, releaseSlugTombstoneCore, setSlugRedirectCore } from "./document-slug.js";
import type { Env } from "./env.js";
import { validateSlugInput } from "./metadata.js";
import { requireOperator } from "./session.js";
import type { WaitUntil } from "./vector-io.js";

/**
 * POST /admin/slugs/:slug/redirect — operator-only. Point a RETIRED slug
 * (migration 0009 tombstone) at a live target document, so `/s/:slug` forwards
 * loudly instead of 410ing (migration 0010). The deliberate "this name moved"
 * case: a branding rename or consolidating two docs, WITHOUT reusing the name.
 *
 * Body: `{ "target_public_id": "<22-char id>" }`. The target must be a live
 * document. Returns the resolved target (public_id + its current slug/title).
 *
 * 404 if the slug isn't retired (a live slug serves its own doc — revoke or
 * rename it first; a never-claimed slug has no tombstone). 422 if the target
 * is missing/revoked/malformed.
 */
export async function setSlugRedirect(
  slug: string,
  req: Request,
  env: Env,
  waitUntil?: WaitUntil,
): Promise<Response> {
  const denied = await requireOperator(req, env);
  if (denied) return denied;
  const v = validateSlugInput(slug);
  if (!v.ok) return jsonError(404, "not_found", "no such retired slug");

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "bad_json", "invalid JSON body");
  }
  const target = (body as { target_public_id?: unknown })?.target_public_id;
  if (typeof target !== "string" || target.length === 0) {
    return jsonError(400, "bad_request", "missing or invalid 'target_public_id' (string)");
  }

  const result = await setSlugRedirectCore(env, v.slug, target, waitUntil);
  if (!result.ok) {
    if (result.code === "tombstone_not_found") {
      return jsonError(404, "not_found", `slug "${v.slug}" is not retired — nothing to redirect`);
    }
    return jsonError(
      422,
      "bad_target",
      `target "${result.target}" is not a live document (unknown, revoked, or malformed public_id)`,
      { target: result.target },
    );
  }
  return Response.json({
    slug: v.slug,
    redirect_to: result.target.public_id,
    target_slug: result.target.slug,
    target_title: result.target.title,
  });
}

/**
 * DELETE /admin/slugs/:slug/redirect — operator-only. Drop a retired slug's
 * redirect, reverting it to a plain 410-Gone tombstone. The slug stays retired
 * (still not reusable); only the forwarding target is removed.
 */
export async function clearSlugRedirect(
  slug: string,
  req: Request,
  env: Env,
  waitUntil?: WaitUntil,
): Promise<Response> {
  const denied = await requireOperator(req, env);
  if (denied) return denied;
  const v = validateSlugInput(slug);
  if (!v.ok) return jsonError(404, "not_found", "no such retired slug");

  const result = await clearSlugRedirectCore(env, v.slug, waitUntil);
  if (!result.ok) return jsonError(404, "not_found", `slug "${v.slug}" is not retired`);
  return Response.json({ slug: v.slug, redirect_to: null });
}

/**
 * DELETE /admin/slugs/:slug — operator-only ESCAPE HATCH. Force-release a
 * retired slug by deleting its tombstone entirely, returning the name to the
 * pool so a future publish can claim it again. For the genuine "I revoked by
 * mistake" / "I really do want to repurpose this name" case — the only path
 * that un-retires a slug. Distinct from clearing the redirect (which keeps the
 * slug retired); this removes the reservation outright.
 */
export async function releaseSlugTombstone(
  slug: string,
  req: Request,
  env: Env,
  waitUntil?: WaitUntil,
): Promise<Response> {
  const denied = await requireOperator(req, env);
  if (denied) return denied;
  const v = validateSlugInput(slug);
  if (!v.ok) return jsonError(404, "not_found", "no such retired slug");

  const result = await releaseSlugTombstoneCore(env, v.slug, waitUntil);
  if (!result.ok) return jsonError(404, "not_found", `slug "${v.slug}" is not retired`);
  return Response.json({ released: true, slug: v.slug });
}
