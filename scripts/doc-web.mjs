// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

// The on-platform doc-web republish recipe (GitHub issue #27).
//
// Repo docs are published to Slopcafe byte-for-byte (curl --data-binary +
// X-Content-SHA256), so a single link form has to serve both the repo (offline
// .md perusal) and the platform (a navigable /s/<slug> web). This script
// reconciles the two deterministically:
//
//   1. Read a doc's repo source.
//   2. Rewrite its links:
//        - a relative link whose resolved target is in scripts/doc-web-map.json
//          -> /s/<slug>            (the on-platform web edge)
//        - a relative link to any OTHER repo file that exists
//          -> <githubBlobBase><path>   (resolves on-platform to the source)
//        - external / already-absolute (/s, /d, ...) / pure-anchor links
//          -> left unchanged
//   3. (publish) compute X-Content-SHA256 over the TRANSFORMED bytes and
//      PUT/POST so the integrity check matches what is sent.
//   4. (check) hash those same bytes and compare against BOTH of the live
//      copy's hashes — the mirror-drift detector.
//   5. (promote) point the live copy's published_ver at the version whose
//      stored source is byte-identical to the repo's.
//
// Re-running regenerates the on-platform link form every time, so the repo
// stays the source of truth and the published copies never drift.
//
// Steps 4 and 5 are two questions because migration 0018 (issue #43) split the
// two version pointers. `publish` moves `current_ver` — what the last write
// stored, and what every credentialed surface reads. A PUBLIC document's browser
// byte path renders `published_ver`, which ONLY the operator moves. So a doc can
// be perfectly published and still be showing the world last week's copy; the
// mirror isn't honest until both pointers carry the repo's bytes.
//
// Usage:
//   node scripts/doc-web.mjs dry-run            # default: print every link rewrite + warnings
//   node scripts/doc-web.mjs emit <outDir>      # write transformed copies to <outDir> for inspection
//   node scripts/doc-web.mjs publish [path...]  # byte-exact POST/PUT of the corpus (or just the named docs)
//   node scripts/doc-web.mjs check              # compare each live copy's hashes to the repo's — exit 1 on drift
//   node scripts/doc-web.mjs promote [path...]  # publish the version holding the repo's exact bytes (operator only)
//
// `publish` and `check` both need a credential: AWH_KEY (or SLOPCAFE_KEY), with
// AWH_BASE / SLOPCAFE_BASE overriding the https://slopcafe.com default.
// `promote` needs the OPERATOR token instead — AWH_OPERATOR_TOKEN (or
// SLOPCAFE_OPERATOR_TOKEN). That asymmetry is the point of issue #43: any agent
// key may overwrite any document, so promotion — the one verb that changes what
// the anonymous internet renders — is deliberately out of an agent's reach.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, relative, join } from "node:path";
import { createHash } from "node:crypto";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const map = JSON.parse(readFileSync(new URL("./doc-web-map.json", import.meta.url), "utf8"));

// absolute target path -> map entry
const bySlugTarget = new Map(
  map.docs.map((d) => [resolve(repoRoot, d.path), d]),
);

const SCHEME = /^[a-z][a-z0-9+.-]*:/i; // http:, https:, mailto:, data:, ...

// Split an href into its path part and a trailing #fragment (if any).
function splitFragment(href) {
  const i = href.indexOf("#");
  return i === -1 ? [href, ""] : [href.slice(0, i), href.slice(i)];
}

// Decide the rewrite for a single href, given the doc it appears in.
// Returns { newHref, kind } where kind is slug | github | external | unchanged | unresolved.
function rewriteHref(href, docAbsPath) {
  const trimmed = href.trim();
  if (!trimmed) return { newHref: href, kind: "unchanged" };
  // strip an optional link title:  path "Title"
  const pathPart = trimmed.split(/\s+/)[0];
  const [bare, frag] = splitFragment(pathPart);

  if (!bare || bare.startsWith("#")) return { newHref: href, kind: "unchanged" }; // pure anchor
  // Not a plausible repo path — almost always a regex/code span the markdown
  // link regex caught by accident (e.g. a slug pattern in prose). Leave it.
  if (/[{}()?*^$|\\`]/.test(bare)) return { newHref: href, kind: "unchanged" };
  if (SCHEME.test(bare) || bare.startsWith("//")) return { newHref: href, kind: "external" };
  if (bare.startsWith("/")) return { newHref: href, kind: "external" }; // already an absolute on-platform path

  const targetAbs = resolve(dirname(docAbsPath), bare);
  const rel = relative(repoRoot, targetAbs);
  const escapesRepo = rel.startsWith("..");

  const entry = bySlugTarget.get(targetAbs);
  if (entry) return { newHref: `/s/${entry.slug}${frag}`, kind: "slug" };

  if (!escapesRepo && existsSync(targetAbs)) {
    return { newHref: `${map.githubBlobBase}${rel}${frag}`, kind: "github" };
  }
  return { newHref: href, kind: "unresolved" };
}

// Rewrite all inline links in a markdown body. Skips image links (`![..](..)`).
const LINK = /(!?)\[([^\]]*)\]\(([^)]+)\)/g;
function rewriteLinks(text, docAbsPath) {
  const changes = [];
  const warnings = [];
  const out = text.replace(LINK, (whole, bang, label, href) => {
    if (bang) return whole; // image — leave untouched
    const { newHref, kind } = rewriteHref(href, docAbsPath);
    if (kind === "unresolved") warnings.push(href);
    if (newHref === href) return whole;
    changes.push({ label, old: href, new: newHref, kind });
    return `${bang}[${label}](${newHref})`;
  });
  return { out, changes, warnings };
}

// The ONE definition of "what bytes should the mirror hold for this doc" —
// transform, then hash. `publish` PUTs `body` under `X-Content-SHA256: sha`;
// `check` compares that same `sha` to the live copy's. Routing both through
// here is load-bearing: a check that could disagree with the publisher about
// the bytes is worse than no check, because it reports sync that isn't real.
function transformDoc(absPath) {
  const { out, changes, warnings } = rewriteLinks(readFileSync(absPath, "utf8"), absPath);
  const body = Buffer.from(out, "utf8");
  return { out, changes, warnings, body, sha: createHash("sha256").update(body).digest("hex") };
}

// Credentials for the two network modes. AWH_* is this script's documented
// pair; SLOPCAFE_* is accepted as a fallback so a shell already set up for the
// Dart CLI (cli/README.md) works here unchanged.
function creds() {
  return {
    key: process.env.AWH_KEY || process.env.SLOPCAFE_KEY || "",
    base: (process.env.AWH_BASE || process.env.SLOPCAFE_BASE || "https://slopcafe.com").replace(/\/$/, ""),
  };
}

// The operator token, for `promote` only. Kept separate from creds() rather
// than folded in as another fallback, because an agent key silently used where
// an operator token is required would fail as a 401 halfway through a run — and
// the whole reason promotion needs a different credential is that an agent key
// must never be able to do it.
function operatorToken() {
  return process.env.AWH_OPERATOR_TOKEN || process.env.SLOPCAFE_OPERATOR_TOKEN || "";
}

// The LIVE listing row for a slug, or null when nothing live answers to it.
// `GET /d?slug=` is the agent-reachable slug resolver (0 or 1 rows) and is the
// only place `current_source_sha256` / `published_source_sha256` are readable
// without pulling the whole body. A revoked doc still lists (with `revoked_at`
// set), so it counts as "nothing live", not as a row to compare against. Accept
// is explicit because a request with no Accept has been seen to lose response
// headers at the edge.
async function liveRow(base, key, slug) {
  const res = await fetch(`${base}/d?slug=${encodeURIComponent(slug)}`, {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`GET /d?slug=${slug} → ${res.status}`);
  const json = await res.json();
  const row = json.documents?.[0];
  return !row || row.revoked_at ? null : row;
}

// ---- CLI ----------------------------------------------------------------
const mode = process.argv[2] || "dry-run";
const sourced = map.docs.filter((d) => existsSync(resolve(repoRoot, d.path)));
const missing = map.docs.filter((d) => !existsSync(resolve(repoRoot, d.path)));

// HTTP header values must be ASCII; fail loud rather than silently mangle.
function hdr(name, value) {
  if (/[^\x20-\x7e]/.test(value)) {
    throw new Error(`non-ASCII in ${name}: ${JSON.stringify(value)} — keep slug-map metadata ASCII (titles auto-derive from H1 server-side and may keep Unicode).`);
  }
  return value;
}

// The rollout: POST the not-yet-published docs (born private), refresh every
// live doc whose bytes differ from the live copy, and leave re-slugs to the
// operator (Manage page). Run:
//   AWH_KEY=awh_... node scripts/doc-web.mjs publish               # all docs
//   AWH_KEY=awh_... node scripts/doc-web.mjs publish <path>...      # only the given doc paths
async function runPublish() {
  const { key, base } = creds();
  if (!key) {
    console.error("publish: set AWH_KEY=<awh_... agent key> (mint via the create_publish_credential MCP tool).");
    console.error("         optional AWH_BASE (default https://slopcafe.com). Run `dry-run` first to review transforms.");
    process.exit(1);
  }
  // Optional path filter: publish only these doc paths (else all). Lets a
  // targeted edit re-publish exactly the docs it touched, not every doc that
  // merely contains a rewritten link.
  const only = new Set(process.argv.slice(3));
  const mapPath = fileURLToPath(new URL("./doc-web-map.json", import.meta.url));
  let dirty = false;

  for (const d of map.docs) {
    if (only.size && !only.has(d.path)) continue;
    const abs = resolve(repoRoot, d.path);
    if (!existsSync(abs)) { console.log(`skip   ${d.path} (not in repo)`); continue; }
    const { changes, body, sha } = transformDoc(abs);
    const headers = {
      Authorization: `Bearer ${key}`,
      "Content-Type": "text/markdown",
      "X-Content-SHA256": sha,
    };

    if (d.status === "reslug") {
      console.log(`skip   ${d.path} (reslug → /s/${d.slug} is the operator's Manage-page task)`);
      continue;
    }
    if (d.status === "live") {
      // What to skip in a bulk run is decided on the CONTENT HASH, never on the
      // link-change count. Skipping "0 link changes" silently DROPPED the common
      // case — prose edited, links untouched — and the mirror's whole job is to
      // not drift. The only honest "nothing to do" signal is the live copy
      // already holding these exact bytes: versions.source_sha256 (migration
      // 0015), surfaced as current_source_sha256 on the listing row. Anything we
      // can't PROVE is identical (no live row, pre-0015 null hash, lookup blew
      // up) gets re-published — a redundant version bump is cheap, a silently
      // stale mirror is not. An explicit `publish <path>` still always PUTs:
      // naming a doc means "push exactly this one."
      if (only.size === 0) {
        let live = null;
        try {
          live = await liveRow(base, key, d.slug);
        } catch (e) {
          console.error(`warn   ${d.path} (${e.message}) — can't confirm the live hash, publishing anyway`);
        }
        if (live && live.current_source_sha256 === sha) {
          console.log(`ok     ${d.path} (live copy is already these bytes — skipped in bulk run)`);
          continue;
        }
      }
      headers["If-Match"] = "*";
      const res = await fetch(`${base}/d/${d.publicId}`, { method: "PUT", headers, body });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { console.error(`PUT    ${d.path} → ${res.status} ${JSON.stringify(json)}`); continue; }
      const note = changes.length === 0 ? "content only, 0 link changes" : `${changes.length} link form(s) refreshed`;
      console.log(`PUT    ${d.path} → ${d.publicId} (${note})`);
      continue;
    }

    // status === "publish": new doc, born private; title auto-derives from H1.
    headers["X-Doc-Slug"] = hdr("X-Doc-Slug", d.slug);
    if (d.description) headers["X-Doc-Description"] = hdr("X-Doc-Description", d.description);
    if (d.tags?.length) headers["X-Doc-Tags"] = hdr("X-Doc-Tags", d.tags.join(","));
    const res = await fetch(`${base}/d`, { method: "POST", headers, body });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) { console.error(`POST   ${d.path} → ${res.status} ${JSON.stringify(json)}`); continue; }
    d.publicId = json.public_id;
    d.status = "live";
    delete d.description;
    delete d.tags;
    dirty = true;
    console.log(`POST   ${d.path} → ${json.public_id} (/s/${d.slug}, private, ${changes.length} link(s) rewritten)`);
  }

  if (dirty) {
    writeFileSync(mapPath, JSON.stringify(map, null, 2) + "\n");
    console.log("\nupdated scripts/doc-web-map.json with new public_ids + status flips (re-runnable).");
  }
}

// The mirror-drift detector (GitHub issue #4). Every mapped doc is a SECOND
// copy that can go stale, and re-publishing it is a prose obligation repeated
// four times in CLAUDE.md — i.e. it rests on somebody remembering. This turns
// that into a machine check: transform the repo copy exactly as `publish`
// would, hash it, and compare against the live copy's stored source hashes
// (migration 0015 stamps those over the same bytes X-Content-SHA256 covers, so
// for a byte-exact publish they're equal by construction). Run:
//   AWH_KEY=awh_... node scripts/doc-web.mjs check
//
// The verdict is THREE-way since migration 0018 split the version pointers:
//   IN SYNC             repo == current == published  → nothing to do
//   AWAITING PROMOTION  repo == current, published behind → operator chore
//   DRIFTED             repo != current               → somebody forgot to publish
// Exits 1 on DRIFTED (and on a broken lookup or a stale map entry), so it can
// gate a deploy; exits 0 with a notice when there's no key, so CI can run it as
// a soft gate. AWAITING PROMOTION deliberately does NOT fail: see the loop.
async function runCheck() {
  const { key, base } = creds();
  if (!key) {
    console.log("check: skipping — no AWH_KEY (or SLOPCAFE_KEY) in the environment.");
    console.log("       Mint one with the create_publish_credential MCP tool and re-run to verify the mirror.");
    return 0; // soft gate: an unauthenticated CI job must not fail the build
  }

  // Per-doc verdict. `fails` is what drives the exit code — it is set ONLY when
  // the repo and the platform genuinely disagree. A doc awaiting its first
  // rollout (status "publish"/"reslug") and a pre-0015 version with no stored
  // hash are both reported and both pass: neither is evidence of drift, and a
  // check that cries wolf gets muted.
  const results = [];
  for (const d of map.docs) {
    const abs = resolve(repoRoot, d.path);
    if (!existsSync(abs)) {
      results.push({ d, label: "NO SOURCE", note: "not in the repo — nothing to compare", fails: false });
      continue;
    }
    const { sha } = transformDoc(abs);

    let live;
    try {
      live = await liveRow(base, key, d.slug);
    } catch (e) {
      results.push({ d, label: "ERROR", note: e.message, fails: true });
      continue;
    }
    if (!live) {
      // No live doc answers to this slug. Expected while a doc is queued for
      // rollout; a contradiction when the map says it's already live.
      const mapped = d.status === "live";
      results.push({
        d,
        label: "NOT PUBLISHED",
        note: mapped ? `map says live but nothing serves /s/${d.slug}` : `map status "${d.status}" — awaiting rollout`,
        fails: mapped,
      });
      continue;
    }
    // `check` finds the live copy by SLUG, but `publish` PUTs by `publicId`.
    // If the map's public_id has gone stale (the slug was re-pointed at another
    // document, or the id was mis-recorded), those are two different documents
    // and a matching hash on the slug-addressed one would report IN SYNC while
    // `publish` keeps writing somewhere else — a false all-clear, the one
    // outcome a drift detector must never produce. Assert they agree.
    if (d.publicId && live.public_id && live.public_id !== d.publicId) {
      results.push({
        d,
        label: "ID MISMATCH",
        note: `/s/${d.slug} serves ${live.public_id} but the map publishes to ${d.publicId}`,
        fails: true,
      });
      continue;
    }
    // Two hashes, two questions, and only one of them is drift.
    //
    //   current_source_sha256   — did the last WRITE carry the repo's bytes?
    //                             A mismatch means somebody edited the repo and
    //                             never re-published. That is drift, and it is
    //                             what this check exists to catch.
    //   published_source_sha256 — is that what a PUBLIC document RENDERS?
    //                             Since migration 0018 a `publish` no longer
    //                             answers this: it advances current_ver, and the
    //                             browser byte path keeps serving published_ver
    //                             until the operator promotes.
    //
    // The write question is asked first because it strictly precedes the other:
    // there is no point reporting a stale publication pointer for bytes that
    // aren't even stored yet.

    // null on a version written before migration 0015 stamped the hash — an
    // unknown, not a mismatch, so it's reported and passes rather than crying
    // drift on every legacy row.
    const liveSha = live.current_source_sha256 ?? null;
    if (liveSha === null) {
      results.push({ d, label: "NO HASH", note: "live version predates migration 0015 — re-publish to stamp one", fails: false });
      continue;
    }
    if (liveSha !== sha) {
      results.push({
        d,
        label: "DRIFTED",
        note: `live ${liveSha.slice(0, 12)}… ≠ repo ${sha.slice(0, 12)}…`,
        fails: true,
      });
      continue;
    }

    // The write is in sync. Now the publication pointer. Compare HASHES, not
    // version numbers: a restore — or a re-publish of unchanged bytes — leaves
    // an older version holding byte-identical source, and that version really is
    // publishing the repo's copy, so calling it "behind" would be a lie.
    const pubSha = live.published_source_sha256 ?? null;
    if (pubSha === sha) {
      results.push({ d, label: "IN SYNC", note: "", fails: false });
      continue;
    }
    if (live.published_ver === null) {
      // Nothing has ever been promoted. That is impossible on a public document
      // (birth binds published_ver, and the flip to public fills it), so this is
      // a private doc — and the flip will bind current_ver, which IS the repo's
      // bytes. There is no chore here, and manufacturing one for every doc in a
      // corpus that is private until launch is precisely how a check gets muted.
      results.push({
        d,
        label: "IN SYNC",
        note: "private, nothing promoted yet — going public publishes this copy",
        fails: false,
      });
      continue;
    }
    if (pubSha === null) {
      // A promoted version from before migration 0015 stamped a hash: an
      // unknown, not a known-behind. Same posture as the current-side NO HASH —
      // reported, and passing.
      results.push({
        d,
        label: "NO HASH",
        note: `published v${live.published_ver} predates migration 0015 — can't compare what readers render`,
        fails: false,
      });
      continue;
    }
    // repo == current, but published_ver names other bytes. The write landed; it
    // just isn't facing the world yet. This does NOT fail the run: it is a chore
    // for the operator (the only principal who can clear it), and a check that
    // goes red after every doc sweep gets muted — which would cost us the
    // DRIFTED signal that actually matters. Loud in the output, silent in $?.
    results.push({
      d,
      label: "AWAITING PROMOTION",
      note:
        live.visibility === "public"
          ? `readers still render v${live.published_ver}; the repo's bytes are v${live.current_ver}`
          : `staged at v${live.published_ver} — that is what goes live if this is made public before promoting`,
      fails: false,
    });
  }

  for (const r of results) {
    const head = `${r.label.padEnd(18)} ${r.d.path}  → /s/${r.d.slug}`;
    console.log(r.note ? `${head}  (${r.note})` : head);
  }

  const bad = results.filter((r) => r.fails);
  // An ERROR is a failed lookup and an ID MISMATCH is a bad map entry — neither
  // is fixed by re-publishing, so neither belongs in the suggested command.
  const republishable = bad.filter((r) => r.label !== "ERROR" && r.label !== "ID MISMATCH");
  const inSync = results.filter((r) => r.label === "IN SYNC").length;
  // Counted separately from both `inSync` and `bad` because it is neither: the
  // bytes agree, the exit code stays 0, and there is still something to do. A
  // summary that folded it into either number would hide the whole state.
  const awaiting = results.filter((r) => r.label === "AWAITING PROMOTION");
  // Every doc lands in exactly one of these four buckets, so the four numbers
  // always sum to the total — a summary that silently drops the passing-but-
  // not-in-sync labels (NO HASH, NO SOURCE, queued NOT PUBLISHED) reads as if
  // docs went missing.
  const other = results.length - inSync - awaiting.length - bad.length;
  console.log(`\n${"─".repeat(60)}`);
  console.log(
    `checked ${results.length} mapped doc(s) against ${base}: ` +
      `${inSync} in sync, ${awaiting.length} awaiting promotion, ${bad.length} needing attention` +
      (other ? `, ${other} not comparable (see labels above)` : "") + ".",
  );
  if (republishable.length) {
    console.log(`\nre-publish the repo copy (the repo is canonical):`);
    console.log(`    AWH_KEY=<key> node scripts/doc-web.mjs publish ${republishable.map((r) => r.d.path).join(" ")}`);
  }
  if (bad.some((r) => r.label === "ID MISMATCH")) {
    console.log(`\nID MISMATCH means scripts/doc-web-map.json is stale — fix the public_id before publishing.`);
  }
  if (awaiting.length) {
    // Printed even though the run passes — this is the only place the chore is
    // visible, and it needs a credential `check` itself doesn't hold.
    console.log(
      `\nAWAITING PROMOTION: the repo's bytes are stored but not the version readers render.` +
        `\nPromotion is operator-only (an agent key cannot do it):`,
    );
    console.log(`    AWH_OPERATOR_TOKEN=<token> node scripts/doc-web.mjs promote ${awaiting.map((r) => r.d.path).join(" ")}`);
  }
  return bad.length ? 1 : 0;
}

// The pointer-mover (GitHub issue #43, migration 0018). `publish` writes bytes;
// this decides which of a document's versions the anonymous web renders.
//
// The rule is one sentence: promote the version whose STORED SOURCE HASH equals
// the repo's transformed bytes, or promote nothing. There is no "latest"
// fallback, and the refusal is not a rough edge — it IS the security property.
// Promotion is the verb that expands the anonymous surface, so an operator
// running it is asserting "publish exactly what my repo says"; a version that
// isn't in the repo cannot satisfy that assertion however new it is, and the
// only honest response is to refuse and let the operator `publish` first. The
// same rule quietly covers a stale map entry too: a public_id pointing at some
// other document won't be holding these bytes, so it refuses rather than
// promoting a stranger.
//
// Matching is by hash rather than by version number for the reason `check` gives:
// a restore, or a re-publish of unchanged bytes, leaves several versions holding
// byte-identical source. Any of them publishes the repo's copy; we take the
// newest (the history comes back newest-first), because its render was produced
// by the newest sanitizer. Only the 200 most recent versions are listed — a doc
// whose matching version is older than that reports as a refusal, which is the
// correct answer for "I cannot prove these are your bytes." Run:
//   AWH_OPERATOR_TOKEN=<token> node scripts/doc-web.mjs promote            # every live doc
//   AWH_OPERATOR_TOKEN=<token> node scripts/doc-web.mjs promote <path>...  # only these
async function runPromote() {
  const { base } = creds();
  const token = operatorToken();
  if (!token) {
    console.error("promote: set AWH_OPERATOR_TOKEN=<operator token> (or SLOPCAFE_OPERATOR_TOKEN).");
    console.error("         An agent key CANNOT promote — only the operator decides what the public page renders.");
    console.error("         optional AWH_BASE (default https://slopcafe.com). Run `check` first to see what needs it.");
    process.exit(1);
  }
  // Same optional path filter as `publish`, so the command `check` prints can be
  // pasted verbatim and touches exactly the docs it named.
  const only = new Set(process.argv.slice(3));
  const auth = { Authorization: `Bearer ${token}`, Accept: "application/json" };
  let failures = 0;

  for (const d of map.docs) {
    if (only.size && !only.has(d.path)) continue;
    const line = `${d.path}  → /s/${d.slug}`;
    const abs = resolve(repoRoot, d.path);
    if (!existsSync(abs)) { console.log(`SKIP       ${line}  (not in the repo — nothing to assert)`); continue; }
    if (d.status !== "live" || !d.publicId) {
      console.log(`SKIP       ${line}  (map status "${d.status}" — publish it before promoting)`);
      continue;
    }
    const { sha } = transformDoc(abs);

    // The version history is the operator's own view (GET /admin/documents/:id/
    // versions), which is where source_sha256 per version lives — a listing row
    // only carries the current and published hashes, and the version we want may
    // be neither.
    let history;
    try {
      const res = await fetch(`${base}/admin/documents/${d.publicId}/versions`, { headers: auth });
      if (!res.ok) throw new Error(`GET /admin/documents/${d.publicId}/versions → ${res.status}`);
      history = await res.json();
    } catch (e) {
      console.error(`ERROR      ${line}  (${e.message})`);
      failures++;
      continue;
    }

    const match = (history.versions ?? []).find((v) => v.source_sha256 === sha);
    if (!match) {
      // Refuse. Loudly, with the reason, and with the command that fixes it —
      // the fix is never "promote something else", it is "make the repo's bytes
      // a version first".
      console.error(`REFUSED    ${line}  (no version holds the repo's bytes — current is v${history.current_ver})`);
      console.error(`           publish first:  AWH_KEY=<key> node scripts/doc-web.mjs publish ${d.path}`);
      failures++;
      continue;
    }
    if (match.is_published) {
      console.log(`ALREADY    ${line}  (v${match.version_no} is already the published version)`);
      continue;
    }

    try {
      const res = await fetch(`${base}/admin/documents/${d.publicId}/promote`, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ version: match.version_no }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        console.error(`ERROR      ${line}  (POST promote → ${res.status} ${JSON.stringify(json)})`);
        failures++;
        continue;
      }
      const lag = history.current_ver - match.version_no;
      console.log(
        `PROMOTED   ${line}  (v${json.published_ver} — the version holding these exact bytes` +
          (lag > 0 ? `; current is v${history.current_ver}, ${lag} newer version(s) stay unpublished)` : ")"),
      );
    } catch (e) {
      console.error(`ERROR      ${line}  (${e.message})`);
      failures++;
    }
  }

  // A REFUSED doc is the operator asking for something this script won't do, and
  // an ERROR is a request that didn't land — both leave the public page showing
  // what it showed before, so a scripted caller has to be able to see it.
  if (failures) {
    console.log(`\n${"─".repeat(60)}`);
    console.log(`${failures} doc(s) were not promoted (see REFUSED/ERROR above).`);
  }
  return failures ? 1 : 0;
}

if (mode === "check") {
  process.exit(await runCheck());
}

if (mode === "promote") {
  process.exit(await runPromote());
}

if (mode === "publish") {
  await runPublish();
  process.exit(0);
}

let outDir = null;
if (mode === "emit") {
  outDir = process.argv[3];
  if (!outDir) { console.error("emit: need an output dir, e.g. `node scripts/doc-web.mjs emit /tmp/doc-web`"); process.exit(1); }
}

let totalChanges = 0;
const allWarnings = [];
for (const d of sourced) {
  const abs = resolve(repoRoot, d.path);
  const src = readFileSync(abs, "utf8");
  const { out, changes, warnings } = rewriteLinks(src, abs);
  totalChanges += changes.length;
  for (const w of warnings) allWarnings.push(`${d.path} -> ${w}`);

  if (outDir) {
    const dest = join(outDir, d.path);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, out);
  }

  const tag = d.status === "live" ? "live" : d.status === "reslug" ? "reslug" : "PUBLISH";
  console.log(`\n• ${d.path}  [${tag} → /s/${d.slug}]  (${changes.length} link${changes.length === 1 ? "" : "s"} rewritten)`);
  for (const c of changes) {
    console.log(`    ${c.kind === "slug" ? "→slug  " : "→github"}  ${c.old}  ⇒  ${c.new}`);
  }
}

console.log(`\n${"─".repeat(60)}`);
console.log(`docs in map: ${map.docs.length}  (repo-sourced: ${sourced.length}, not in repo: ${missing.length})`);
if (missing.length) console.log(`  not in repo (publish/reslug via metadata, not this recipe): ${missing.map((m) => m.path).join(", ")}`);
console.log(`total links rewritten: ${totalChanges}`);
if (allWarnings.length) {
  console.log(`\n⚠ unresolved relative links (no slug, not a repo file) — left as-is:`);
  for (const w of allWarnings) console.log(`    ${w}`);
} else {
  console.log(`no unresolved relative links.`);
}
if (outDir) console.log(`\nwrote transformed copies under ${outDir}`);
