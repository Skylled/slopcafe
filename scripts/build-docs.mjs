// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

// Regenerates the bundled platform-documentation corpus under
// `src/generated/`. Run with:
//
//   npm run build:docs
//
// which is wired into `predeploy` so a deploy can't ship documentation that
// disagrees with the code it documents. `test/docs-bundle.test.mjs` IS the
// freshness gate: it re-runs this script into a temp directory (via the
// DOCS_BUILD_OUT override) and diffs the result against the committed bundle,
// so `npm test` fails on stale output. That is why CI builds the WASM sanitizer
// — this script renders through the real one.
//
// WHY THIS EXISTS (GitHub issue #4). The reference corpus used to reach readers
// by being *published onto the running platform* as ordinary Documents — an
// agent key, a byte-exact PUT, and a separate operator promote, all driven by
// hand. That made documentation drift a live possibility (a `DRIFTED` state the
// old `doc-web.mjs check` existed to detect) and made every runtime pointer at
// a doc a claim about whether someone had run a script. Documentation ABOUT THE
// CODE is a build artifact of the code — exactly like `openapi.json` — so it
// now ships with the Worker and is served from `/docs/…`. Drift stops being
// monitored and becomes unrepresentable.
//
// WHAT IT EMITS, per entry in `platform-docs.json`:
//   src/generated/docs/<name>.md    — the transformed Markdown source (S)
//   src/generated/docs/<name>.html  — the sanitized render (H)
//   src/generated/platform-docs.ts  — the manifest + imports of both
//
// S AND H ARE BOTH BUNDLED, deliberately. Rendering H at request time instead
// would halve the bundle, but `markdown_to_html`+`sanitize` over the largest
// doc measures ~32 ms — most of a Worker's CPU budget, on a route whose whole
// selling point is that it is boringly reliable. Keeping both mirrors what the
// storage model already does for every document (retained source + rendered
// bytes) and leaves the request path doing nothing but picking a string.
//
// DETERMINISM. Entries are emitted in sorted order and every byte is a pure
// function of the repo contents + the sanitizer version, so regeneration is
// byte-stable and the freshness gate is meaningful.

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, relative } from "node:path";
import { createHash } from "node:crypto";

import { initSync, sanitize, markdown_to_html, sanitizer_version } from "../sanitizer/pkg/sanitizer.js";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const map = JSON.parse(readFileSync(new URL("./platform-docs.json", import.meta.url), "utf8"));

// Output root. Overridable so test/docs-bundle.test.mjs can build into a temp
// directory and diff the result against the committed bundle — the freshness
// gate re-runs THIS script rather than re-implementing the transform, so the
// check can never disagree with the builder about what the bytes should be.
const outRoot = process.env.DOCS_BUILD_OUT
  ? resolve(process.cwd(), process.env.DOCS_BUILD_OUT)
  : resolve(repoRoot, "src/generated");
const outDocs = resolve(outRoot, "docs");

// The sanitizer runs here, at build time, exactly as it does in the Worker —
// same WASM module, same allowlist, same version stamp. Node has no
// `import.meta.url` fetch path, so `initSync` takes the compiled module
// directly (the same reason src/sanitizer.ts avoids the wasm-pack `init()`).
initSync({ module: new WebAssembly.Module(readFileSync(resolve(repoRoot, "sanitizer/pkg/sanitizer_bg.wasm"))) });

// absolute target path -> map entry, for the link rewriter
const byTarget = new Map(map.docs.map((d) => [resolve(repoRoot, d.path), d]));

const SCHEME = /^[a-z][a-z0-9+.-]*:/i; // http:, https:, mailto:, data:, ...

function splitFragment(href) {
  const i = href.indexOf("#");
  return i === -1 ? [href, ""] : [href.slice(0, i), href.slice(i)];
}

/**
 * Decide the rewrite for a single href, given the doc it appears in.
 *
 * A repo-relative link to another MAPPED doc becomes `/docs/<name>` — the
 * bundled route, served by this same Worker. A link to any other file that
 * really exists in the repo becomes a GitHub blob URL (it has no on-platform
 * home). Everything else — external URLs, `mailto:`, bare anchors, and paths
 * that are already absolute — is left exactly as written.
 *
 * Returns { newHref, kind } where kind is docs | github | external | unchanged
 * | unresolved. `unresolved` is reported to the caller as a warning: it means a
 * relative link resolved to nothing on disk, i.e. a broken link in the repo.
 */
function rewriteHref(href, docAbsPath) {
  const trimmed = href.trim();
  if (!trimmed) return { newHref: href, kind: "unchanged" };
  // strip an optional link title:  path "Title"
  const pathPart = trimmed.split(/\s+/)[0];
  const [bare, frag] = splitFragment(pathPart);

  if (!bare || bare.startsWith("#")) return { newHref: href, kind: "unchanged" }; // pure anchor
  // Not a plausible repo path — almost always a regex or code span the markdown
  // link regex caught by accident (e.g. a slug pattern quoted in prose).
  if (/[{}()?*^$|\\`]/.test(bare)) return { newHref: href, kind: "unchanged" };
  if (SCHEME.test(bare) || bare.startsWith("//")) return { newHref: href, kind: "external" };
  if (bare.startsWith("/")) return { newHref: href, kind: "external" }; // already an absolute on-platform path

  const targetAbs = resolve(dirname(docAbsPath), bare);
  const rel = relative(repoRoot, targetAbs);
  const escapesRepo = rel.startsWith("..");

  const entry = byTarget.get(targetAbs);
  if (entry) return { newHref: `/docs/${entry.name}${frag}`, kind: "docs" };

  if (!escapesRepo && existsSync(targetAbs)) {
    return { newHref: `${map.githubBlobBase}${rel}${frag}`, kind: "github" };
  }
  return { newHref: href, kind: "unresolved" };
}

// Rewrite all inline links in a markdown body. Skips image links (`![..](..)`).
const LINK = /(!?)\[([^\]]*)\]\(([^)]+)\)/g;
function rewriteLinks(text, docAbsPath) {
  const warnings = [];
  const out = text.replace(LINK, (whole, bang, label, href) => {
    if (bang) return whole; // image — leave untouched
    const { newHref, kind } = rewriteHref(href, docAbsPath);
    if (kind === "unresolved") warnings.push(href);
    if (newHref === href) return whole;
    return `[${label}](${newHref})`;
  });
  return { out, warnings };
}

/**
 * Title for a doc: its first ATX H1, matching how the platform derives a title
 * from a document's first `<h1>`. Falls back to the route name so a doc that
 * somehow lacks an H1 still gets something usable in a tab and an index row.
 */
function deriveTitle(md, name) {
  const m = md.match(/^#\s+(.+?)\s*$/m);
  return m ? m[1].trim() : name;
}

/** JS string literal, safe to paste into the generated module. */
function lit(s) {
  return JSON.stringify(s);
}

// -- build --------------------------------------------------------------------

mkdirSync(outDocs, { recursive: true });

const entries = [];
const allWarnings = [];

for (const doc of [...map.docs].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
  const absPath = resolve(repoRoot, doc.path);
  if (!existsSync(absPath)) {
    console.error(`MISSING  ${doc.path} (mapped as "${doc.name}") — not on disk`);
    process.exitCode = 1;
    continue;
  }
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(doc.name)) {
    console.error(`BAD NAME ${doc.name} (${doc.path}) — must be a lowercase slug`);
    process.exitCode = 1;
    continue;
  }

  const raw = readFileSync(absPath, "utf8");
  const { out: markdown, warnings } = rewriteLinks(raw, absPath);
  for (const w of warnings) allWarnings.push(`${doc.path}: unresolved link ${w}`);

  const html = sanitize(markdown_to_html(markdown));
  const title = deriveTitle(markdown, doc.name);

  writeFileSync(resolve(outDocs, `${doc.name}.md`), markdown);
  writeFileSync(resolve(outDocs, `${doc.name}.html`), html);

  entries.push({
    name: doc.name,
    path: doc.path,
    title,
    description: doc.description ?? null,
    tags: doc.tags ?? [],
    seed: doc.seed === true,
    markdownBytes: Buffer.byteLength(markdown, "utf8"),
    htmlBytes: Buffer.byteLength(html, "utf8"),
    // sha256 over the transformed Markdown — the bytes the seeder publishes.
    // Identical in role to the hash `X-Content-SHA256` carries on a byte-exact
    // PUT, so the seeder can ask "does the corpus already hold exactly this?"
    // without re-reading the body.
    sourceSha256: createHash("sha256").update(Buffer.from(markdown, "utf8")).digest("hex"),
  });
}

if (process.exitCode) {
  console.error("\nrefusing to write a partial bundle");
  process.exit(1);
}

// Clear stale generated files (a doc removed from the map must not linger in
// the bundle — it would keep serving from a route nothing points at any more).
const keep = new Set(entries.flatMap((e) => [`${e.name}.md`, `${e.name}.html`]));
for (const f of readdirSync(outDocs)) {
  if (!keep.has(f)) rmSync(resolve(outDocs, f));
}

const imports = entries
  .map((e) => `import md_${e.name.replace(/-/g, "_")} from "./docs/${e.name}.md";\nimport html_${e.name.replace(/-/g, "_")} from "./docs/${e.name}.html";`)
  .join("\n");

const rows = entries
  .map((e) => {
    const id = e.name.replace(/-/g, "_");
    return `  {
    name: ${lit(e.name)},
    path: ${lit(e.path)},
    title: ${lit(e.title)},
    description: ${e.description === null ? "null" : lit(e.description)},
    tags: [${e.tags.map(lit).join(", ")}],
    seed: ${e.seed},
    markdownBytes: ${e.markdownBytes},
    htmlBytes: ${e.htmlBytes},
    sourceSha256: ${lit(e.sourceSha256)},
    markdown: md_${id},
    html: html_${id},
  },`;
  })
  .join("\n");

const module = `// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

// GENERATED FILE — DO NOT EDIT. Regenerate with \`npm run build:docs\`
// (scripts/build-docs.mjs), which \`predeploy\` runs. Edits here are overwritten
// and will fail the freshness gate in test/docs-bundle.test.mjs.
//
// The bundled platform-documentation corpus: for each mapped repo doc, its
// link-rewritten Markdown source and the sanitized HTML render, both produced
// at build time by the same WASM sanitizer the Worker runs at write time.
// Serving these from \`/docs/…\` is what makes an instance's documentation match
// its own deployed build by construction (GitHub issue #4).

/** Sanitizer version the bundled HTML was rendered with, for diagnostics. */
export const DOCS_SANITIZER_VERSION = ${lit(sanitizer_version())};

export type PlatformDoc = {
  /** Route segment: \`/docs/<name>\`. Unique across the corpus. */
  name: string;
  /** Source path in the repo — the thing this doc is generated FROM. */
  path: string;
  /** Derived from the doc's first H1, as the platform derives document titles. */
  title: string;
  description: string | null;
  tags: string[];
  /** Whether this doc is also seeded into the corpus as a Document. */
  seed: boolean;
  markdownBytes: number;
  htmlBytes: number;
  /** sha256 of \`markdown\` — the bytes the seeder publishes. */
  sourceSha256: string;
  /** Link-rewritten Markdown source (S). */
  markdown: string;
  /** Sanitized render (H). */
  html: string;
};

${imports}

/** Every bundled doc, ordered by \`name\`. */
export const PLATFORM_DOCS: readonly PlatformDoc[] = [
${rows}
];

/** Lookup by route segment. */
export const PLATFORM_DOCS_BY_NAME: ReadonlyMap<string, PlatformDoc> = new Map(
  PLATFORM_DOCS.map((d) => [d.name, d]),
);
`;

writeFileSync(resolve(outRoot, "platform-docs.ts"), module);

const totalMd = entries.reduce((n, e) => n + e.markdownBytes, 0);
const totalHtml = entries.reduce((n, e) => n + e.htmlBytes, 0);
const seeded = entries.filter((e) => e.seed);

console.log(`wrote ${entries.length} docs to src/generated (${(totalMd / 1024).toFixed(0)} KiB md + ${(totalHtml / 1024).toFixed(0)} KiB html, ${sanitizer_version()})`);
console.log(`seeded into the corpus: ${seeded.length ? seeded.map((e) => e.name).join(", ") : "(none)"}`);
for (const w of allWarnings) console.warn(`WARN  ${w}`);
