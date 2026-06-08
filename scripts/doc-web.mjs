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
//   3. (publish, not yet wired) compute X-Content-SHA256 over the TRANSFORMED
//      bytes and PUT/POST so the integrity check matches what is sent.
//
// Re-running regenerates the on-platform link form every time, so the repo
// stays the source of truth and the published copies never drift.
//
// Usage:
//   node scripts/doc-web.mjs dry-run            # default: print every link rewrite + warnings
//   node scripts/doc-web.mjs emit <outDir>      # write transformed copies to <outDir> for inspection
//   node scripts/doc-web.mjs publish            # rollout (PUT/POST) — NOT wired yet (needs creds + go-ahead)

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

// The rollout: POST the not-yet-published docs (born private), refresh live docs
// whose links changed, and leave re-slugs to the operator (Manage page). Run:
//   AWH_KEY=awh_... node scripts/doc-web.mjs publish               # all docs
//   AWH_KEY=awh_... node scripts/doc-web.mjs publish <path>...      # only the given doc paths
async function runPublish() {
  const key = process.env.AWH_KEY;
  const base = (process.env.AWH_BASE || "https://slopcafe.com").replace(/\/$/, "");
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
    const { out, changes } = rewriteLinks(readFileSync(abs, "utf8"), abs);
    const body = Buffer.from(out, "utf8");
    const sha = createHash("sha256").update(body).digest("hex");
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
      if (changes.length === 0) { console.log(`ok     ${d.path} (live, 0 link changes)`); continue; }
      headers["If-Match"] = "*";
      const res = await fetch(`${base}/d/${d.publicId}`, { method: "PUT", headers, body });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { console.error(`PUT    ${d.path} → ${res.status} ${JSON.stringify(json)}`); continue; }
      console.log(`PUT    ${d.path} → ${d.publicId} (${changes.length} link form(s) refreshed)`);
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
