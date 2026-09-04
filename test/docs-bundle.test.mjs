// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

// Coverage for the bundled platform-documentation corpus (GitHub issue #4).
//
// TWO JOBS.
//
// 1. FRESHNESS. `src/generated/` is committed build output, exactly like
//    `openapi.json`, and the whole point of the change is that an instance
//    serves documentation matching its own build. A stale bundle would restore
//    the drift this replaced — quietly, since nothing at runtime can tell. So
//    this re-runs scripts/build-docs.mjs into a temp directory and diffs the
//    result against what is committed. It re-runs the REAL builder rather than
//    re-implementing the transform: a check that could disagree with the
//    builder about the bytes is worse than no check.
//
// 2. INVARIANTS the rest of the system leans on: route names are unique and
//    URL-safe, seeded docs carry the corpus metadata the seeder publishes, the
//    reserved-slug rule agrees with metadata.ts, and no bundled doc links to a
//    route the bundle doesn't contain (a broken cross-link would 404 inside the
//    docs the change exists to make reliable).

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

let failures = 0;
function check(label, cond) {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const committed = resolve(repoRoot, "src/generated");
const map = JSON.parse(readFileSync(resolve(repoRoot, "scripts/platform-docs.json"), "utf8"));

// Explicit "current contract" claims are easy to strand when the canonical
// version changes: the generated spec stays fresh while hand-authored prose can
// keep confidently naming the old release. Pin only the four intentional
// current-state claims, leaving historical migration/version examples alone.
const openApiSource = readFileSync(resolve(repoRoot, "src/openapi.ts"), "utf8");
const canonicalVersion = openApiSource.match(/OPENAPI_INFO_VERSION\s*=\s*"([^"]+)"/)?.[1];
check("openapi.ts declares OPENAPI_INFO_VERSION", canonicalVersion !== undefined);

const currentVersionClaims = [
  {
    name: "README API overview",
    path: "README.md",
    pattern: /contract carries a strict-semver version, currently \*\*`([^`]+)`\*\*/,
  },
  {
    name: "HTTP quickstart",
    path: "docs/http-api-quickstart.md",
    pattern: /\*\*strict semver\*\* \(currently `([^`]+)`\)/,
  },
  {
    name: "HTTP API reference",
    path: "docs/http-api.md",
    pattern: /public launch and is \*\*currently `([^`]+)`/,
  },
  {
    name: "API contract design",
    path: "docs/design/api-contract-design.md",
    pattern: /contract itself is stable and versioned — \*\*currently `([^`]+)`/,
  },
];

for (const claim of currentVersionClaims) {
  const text = readFileSync(resolve(repoRoot, claim.path), "utf8");
  const statedVersion = text.match(claim.pattern)?.[1];
  check(
    `${claim.name} current-version claim matches OPENAPI_INFO_VERSION (${statedVersion ?? "missing"})`,
    canonicalVersion !== undefined && statedVersion === canonicalVersion,
  );
}

const roadmap = readFileSync(resolve(repoRoot, "docs/feature-roadmap.md"), "utf8");
check(
  "the roadmap marks the implemented key-pruning route as shipped",
  /\| Expired\/revoked key cleanup \| \*\*Shipped\*\* \(`POST \/admin\/keys\/prune`/.test(roadmap),
);

// ---------------------------------------------------------------------------
// 1. freshness — rebuild into a temp dir and diff
// ---------------------------------------------------------------------------

// The rebuild renders through the real WASM sanitizer, which lives in the
// gitignored sanitizer/pkg. Fail with the actual remedy rather than an opaque
// module-resolution error — a fresh checkout hits this before anything else.
if (!existsSync(resolve(repoRoot, "sanitizer/pkg/sanitizer_bg.wasm"))) {
  console.log("FAIL sanitizer/pkg is missing — run `npm run build:wasm` first (needed to re-render the docs bundle)");
  process.exit(1);
}

const tmp = mkdtempSync(resolve(tmpdir(), "slopcafe-docs-"));
try {
  execFileSync("node", [resolve(repoRoot, "scripts/build-docs.mjs")], {
    cwd: repoRoot,
    env: { ...process.env, DOCS_BUILD_OUT: tmp },
    stdio: "pipe",
  });

  const listOf = (root) =>
    readdirSync(resolve(root, "docs"))
      .sort()
      .join("\n");
  check("rebuild produces the same file set", listOf(tmp) === listOf(committed));

  let drifted = [];
  for (const name of readdirSync(resolve(tmp, "docs"))) {
    const a = readFileSync(resolve(tmp, "docs", name));
    let b;
    try {
      b = readFileSync(resolve(committed, "docs", name));
    } catch {
      drifted.push(`${name} (missing from the committed bundle)`);
      continue;
    }
    if (!a.equals(b)) drifted.push(name);
  }
  check(
    `every bundled doc is up to date (${drifted.length ? drifted.join(", ") : "clean"}) — run \`npm run build:docs\``,
    drifted.length === 0,
  );

  const manifestFresh =
    readFileSync(resolve(tmp, "platform-docs.ts"), "utf8") ===
    readFileSync(resolve(committed, "platform-docs.ts"), "utf8");
  check("the generated manifest is up to date — run `npm run build:docs`", manifestFresh);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 2. invariants
// ---------------------------------------------------------------------------

const names = map.docs.map((d) => d.name);
check("every mapped doc declares a route name", names.every((n) => typeof n === "string" && n.length > 0));
check("route names are unique", new Set(names).size === names.length);
check(
  "route names are URL-safe lowercase slugs",
  names.every((n) => /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(n)),
);

// The seeder publishes description + tags as corpus metadata; a seeded doc with
// neither would land in search results as a bare title.
const seeded = map.docs.filter((d) => d.seed === true);
check("at least one doc is seeded into the corpus", seeded.length > 0);
check(
  "every seeded doc carries a description",
  seeded.every((d) => typeof d.description === "string" && d.description.length > 0),
);
check(
  "every seeded doc carries tags",
  seeded.every((d) => Array.isArray(d.tags) && d.tags.length > 0),
);

// The seed set is deliberately small — it is "what a tool description tells an
// agent to read", not "the corpus". If this ever grows past a handful, the rule
// has drifted into "mirror everything", which is what issue #4 removed.
check(`the seed set stays small (${seeded.length})`, seeded.length <= 4);

// The reserved prefix must agree with metadata.ts, which is where resolveSlug
// enforces it. A drift here means seeded docs claim slugs the write path would
// reject — or, worse, that agents can claim the names the seeder needs.
const metadataSrc = readFileSync(resolve(repoRoot, "src/metadata.ts"), "utf8");
const prefixDecl = metadataSrc.match(/RESERVED_SLUG_PREFIX\s*=\s*"([^"]+)"/);
check("metadata.ts declares RESERVED_SLUG_PREFIX", prefixDecl !== null);
check(
  `the reserved prefix is a valid slug prefix (${prefixDecl?.[1]})`,
  prefixDecl !== null && /^[a-z0-9][a-z0-9_-]*-$/.test(prefixDecl[1]),
);
check(
  "a seeded slug is a valid slug once the prefix is applied",
  prefixDecl !== null &&
    seeded.every((d) => /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/.test(`${prefixDecl[1]}${d.name}`)),
);

// No bundled doc may link to a /docs/ route the bundle doesn't have. The link
// rewriter only emits /docs/<name> for docs in the map, so a hit here means a
// hand-written absolute link in the prose — exactly the class of stale pointer
// this whole change exists to eliminate.
const known = new Set(names);
const broken = [];
for (const name of names) {
  const md = readFileSync(resolve(committed, "docs", `${name}.md`), "utf8");
  for (const m of md.matchAll(/\]\(\/docs\/([a-z0-9-]+)/g)) {
    if (!known.has(m[1])) broken.push(`${name}.md -> /docs/${m[1]}`);
  }
}
check(`no bundled doc links to a missing /docs route (${broken.length ? broken.join(", ") : "clean"})`, broken.length === 0);

// Nothing in the bundled corpus may still point a reader at a RETIRED MIRROR
// SLUG. Those documents are being revoked, so every such reference is either a
// dead link or — worse — a live-looking instruction to run a deleted script.
//
// The retired set is derived, not hardcoded: for every route `name` in the
// registry, `slopcafe-<name>` is exactly the slug that doc used to be mirrored
// under. `slopcafe-docs-<name>` (the reserved corpus namespace) is excluded by
// the negative lookbehind — those are the two slugs that DO exist.
//
// Deliberately NOT limited to markdown-link syntax. An earlier version of this
// check only matched `](/s/slopcafe-…)`, and passed green while ~24 references
// sat in the shipped corpus as inline code, curl commands and pack-manifest
// lines. A dead slug misleads a reader wherever it appears, so this scans the
// prose.
const retiredSlugs = new Set(names.map((n) => `slopcafe-${n}`));
const stale = [];
for (const name of names) {
  const md = readFileSync(resolve(committed, "docs", `${name}.md`), "utf8");
  for (const m of md.matchAll(/(?<!slopcafe-docs-)\bslopcafe-([a-z0-9-]+)/g)) {
    if (retiredSlugs.has(`slopcafe-${m[1]}`)) {
      const line = md.slice(0, m.index).split("\n").length;
      stale.push(`${name}.md:${line} slopcafe-${m[1]}`);
    }
  }
}
check(
  `no bundled doc references a retired mirror slug (${stale.length ? `${stale.length}: ${stale.slice(0, 8).join(", ")}${stale.length > 8 ? " …" : ""}` : "clean"})`,
  stale.length === 0,
);

console.log(failures === 0 ? "\nall docs-bundle tests passed" : `\n${failures} docs-bundle test(s) failed`);
process.exit(failures === 0 ? 0 : 1);
