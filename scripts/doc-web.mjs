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
//   4. (check) hash those same bytes and compare against the live copy's
//      current_source_sha256 — the mirror-drift detector.
//
// Re-running regenerates the on-platform link form every time, so the repo
// stays the source of truth and the published copies never drift.
//
// Usage:
//   node scripts/doc-web.mjs dry-run            # default: print every link rewrite + warnings
//   node scripts/doc-web.mjs emit <outDir>      # write transformed copies to <outDir> for inspection
//   node scripts/doc-web.mjs publish [path...]  # byte-exact POST/PUT of the corpus (or just the named docs)
//   node scripts/doc-web.mjs check              # compare each live copy's hash to the repo's — exit 1 on drift
//
// `publish` and `check` both need a credential: AWH_KEY (or SLOPCAFE_KEY), with
// AWH_BASE / SLOPCAFE_BASE overriding the https://slopcafe.com default.

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

// The LIVE listing row for a slug, or null when nothing live answers to it.
// `GET /d?slug=` is the agent-reachable slug resolver (0 or 1 rows) and is the
// only place `current_source_sha256` is readable without pulling the whole
// body. A revoked doc still lists (with `revoked_at` set), so it counts as
// "nothing live", not as a row to compare against. Accept is explicit because a
// request with no Accept has been seen to lose response headers at the edge.
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
// would, hash it, and compare against the live copy's current_source_sha256
// (migration 0015 stamps that over the same bytes X-Content-SHA256 covers, so
// for a byte-exact publish the two hashes are equal by construction). Run:
//   AWH_KEY=awh_... node scripts/doc-web.mjs check
// Exits 1 when any mirrored doc has drifted, so it can gate a deploy; exits 0
// with a notice when there's no key, so CI can run it as a soft gate.
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
    // null on a version written before migration 0015 stamped the hash — an
    // unknown, not a mismatch, so it's reported and passes rather than crying
    // drift on every legacy row.
    const liveSha = live.current_source_sha256 ?? null;
    if (liveSha === null) {
      results.push({ d, label: "NO HASH", note: "live version predates migration 0015 — re-publish to stamp one", fails: false });
      continue;
    }
    const drifted = liveSha !== sha;
    results.push({
      d,
      label: drifted ? "DRIFTED" : "IN SYNC",
      note: drifted ? `live ${liveSha.slice(0, 12)}… ≠ repo ${sha.slice(0, 12)}…` : "",
      fails: drifted,
    });
  }

  for (const r of results) {
    const head = `${r.label.padEnd(13)} ${r.d.path}  → /s/${r.d.slug}`;
    console.log(r.note ? `${head}  (${r.note})` : head);
  }

  const bad = results.filter((r) => r.fails);
  // An ERROR is a failed lookup and an ID MISMATCH is a bad map entry — neither
  // is fixed by re-publishing, so neither belongs in the suggested command.
  const republishable = bad.filter((r) => r.label !== "ERROR" && r.label !== "ID MISMATCH");
  const inSync = results.filter((r) => r.label === "IN SYNC").length;
  // Every doc lands in exactly one of these three buckets, so the three numbers
  // always sum to the total — a summary that silently drops the passing-but-
  // not-in-sync labels (NO HASH, NO SOURCE, queued NOT PUBLISHED) reads as if
  // docs went missing.
  const other = results.length - inSync - bad.length;
  console.log(`\n${"─".repeat(60)}`);
  console.log(
    `checked ${results.length} mapped doc(s) against ${base}: ` +
      `${inSync} in sync, ${bad.length} needing attention` +
      (other ? `, ${other} not comparable (see labels above)` : "") + ".",
  );
  if (republishable.length) {
    console.log(`\nre-publish the repo copy (the repo is canonical):`);
    console.log(`    AWH_KEY=<key> node scripts/doc-web.mjs publish ${republishable.map((r) => r.d.path).join(" ")}`);
  }
  if (bad.some((r) => r.label === "ID MISMATCH")) {
    console.log(`\nID MISMATCH means scripts/doc-web-map.json is stale — fix the public_id before publishing.`);
  }
  return bad.length ? 1 : 0;
}

if (mode === "check") {
  process.exit(await runCheck());
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
