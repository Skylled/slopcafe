// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

// Coverage for src/openapi.ts + the committed openapi.json (Phase 2 of
// docs/design/api-contract-design.md). Runs under the Node strip-types runner WITH the
// .js→.ts resolver (openapi.ts imports `./contract.js`) — see the test:openapi
// script.
//
// Four jobs:
//   1. Validity — the assembled doc is a well-formed OpenAPI 3.1 document
//      (version, info, paths, components, securitySchemes), every operation has
//      responses, every parameter is well-formed, and every `$ref` /
//      `security` scheme resolves.
//   2. Completeness (documented surface) — the route registry is EXACTLY the
//      documented route surface (docs/design/api-contract-phase2-routes.md) plus the new
//      /openapi.json route. A registry add/drop without updating this list (and
//      the doc) fails here.
//   3. Completeness (index.ts gate) — every static exact-match route dispatched
//      in src/index.ts is present in the registry, so a brand-new static route
//      can't ship spec-less.
//   4. Freshness — regenerating the spec equals the committed openapi.json (the
//      CI drift gate; the build form is `git diff --exit-code openapi.json`).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildOpenApiDocument, listRegisteredRoutes } from "../src/openapi.ts";

let fails = 0;
function check(label, cond) {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) fails++;
}

const doc = buildOpenApiDocument();

// ----- 1. OpenAPI 3.1 validity ----------------------------------------------

check("openapi is 3.1.0", doc.openapi === "3.1.0");
check("info.title present", typeof doc.info?.title === "string" && doc.info.title.length > 0);
check("info.version is semver-ish", /^\d+\.\d+\.\d+$/.test(doc.info?.version ?? ""));
check("servers is a non-empty array", Array.isArray(doc.servers) && doc.servers.length > 0);
check("paths is a non-empty object", doc.paths && Object.keys(doc.paths).length > 0);
check("components.schemas present", doc.components?.schemas && Object.keys(doc.components.schemas).length > 0);

const schemeNames = new Set(Object.keys(doc.components?.securitySchemes ?? {}));
check("3 securitySchemes defined", schemeNames.size === 3);
check(
  "securitySchemes are the expected three",
  ["ApiKeyBearer", "OAuthBearer", "CookieSession"].every((s) => schemeNames.has(s)),
);

const HTTP_METHODS = new Set(["get", "post", "put", "delete", "patch", "options", "head"]);
let opCount = 0;
let opsWithResponses = 0;
let badParams = 0;
const usedSchemes = new Set();

for (const [path, item] of Object.entries(doc.paths)) {
  for (const [method, op] of Object.entries(item)) {
    if (!HTTP_METHODS.has(method)) continue;
    opCount++;
    const responses = op.responses ?? {};
    if (Object.keys(responses).length > 0) opsWithResponses++;
    // path params must each be declared with required:true
    const pathParamNames = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
    const declared = new Set((op.parameters ?? []).filter((p) => p.in === "path").map((p) => p.name));
    for (const name of pathParamNames) {
      if (!declared.has(name)) {
        console.log(`  ${method.toUpperCase()} ${path}: path param {${name}} not declared`);
        badParams++;
      }
    }
    for (const p of op.parameters ?? []) {
      if (typeof p.name !== "string" || !p.in) {
        console.log(`  ${method.toUpperCase()} ${path}: malformed parameter ${JSON.stringify(p)}`);
        badParams++;
      }
    }
    for (const req of op.security ?? []) {
      for (const s of Object.keys(req)) usedSchemes.add(s);
    }
  }
}

check(`every operation has responses (${opsWithResponses}/${opCount})`, opsWithResponses === opCount);
check("every path param is declared", badParams === 0);
check(
  "every referenced security scheme is defined",
  [...usedSchemes].every((s) => schemeNames.has(s)),
);

// $ref resolution — every `#/components/schemas/X` resolves.
const refs = new Set();
JSON.stringify(doc, (k, v) => {
  if (k === "$ref") refs.add(v);
  return v;
});
const componentIds = new Set(Object.keys(doc.components.schemas).map((id) => `#/components/schemas/${id}`));
const dangling = [...refs].filter((r) => !componentIds.has(r));
check(`every $ref resolves (${refs.size} refs)`, dangling.length === 0);
if (dangling.length) console.log(`  dangling: ${dangling.join(", ")}`);

// ----- 2. completeness vs the documented surface ----------------------------
// The verified route table (docs/design/api-contract-phase2-routes.md), as METHOD path
// strings, plus the Phase-2 /openapi.json route. Keep in lockstep with ROUTES
// in src/openapi.ts and the route-table doc.

const EXPECTED_ROUTES = [
  // public / static
  "GET /",
  "GET /healthz",
  "GET /shell.js",
  "GET /openapi.json",
  // document core
  "POST /d",
  "GET /d",
  "GET /d/search",
  "GET /d/{public_id}",
  "PUT /d/{public_id}",
  "DELETE /d/{public_id}",
  "GET /d/{public_id}/raw",
  "GET /d/{public_id}/text",
  "GET /d/{public_id}/source",
  "GET /d/{public_id}/links",
  // slug surface
  "GET /s/{slug}",
  "GET /s/{slug}/text",
  // version history
  "GET /d/{public_id}/v/{n}",
  "GET /d/{public_id}/v/{n}/raw",
  // management UI
  "GET /d/{public_id}/manage",
  "POST /d/{public_id}/visibility",
  "POST /d/{public_id}/slug",
  "POST /d/{public_id}/tags",
  "POST /d/{public_id}/status",
  "POST /d/{public_id}/restore",
  "GET /d/{public_id}/revoke",
  "POST /d/{public_id}/revoke",
  // session
  "GET /login",
  "POST /login",
  "GET /logout",
  "POST /logout",
  // oauth
  "GET /authorize",
  "POST /authorize",
  "POST /token",
  "POST /register",
  "GET /.well-known/oauth-authorization-server",
  "GET /.well-known/oauth-protected-resource",
  // mcp
  "POST /mcp",
  // operator console (HTML, no-JS)
  "GET /admin",
  "GET /admin/console",
  "GET /admin/console/agents",
  "POST /admin/console/agents",
  "GET /admin/console/agents/{agent_id}",
  "POST /admin/console/agents/{agent_id}/keys",
  "POST /admin/console/agents/{agent_id}/oauth-clients",
  "POST /admin/console/agents/revoke",
  "POST /admin/console/keys/revoke",
  "POST /admin/console/oauth-clients",
  "POST /admin/console/oauth-clients/delete",
  "GET /admin/console/documents",
  "GET /admin/console/maintenance",
  "POST /admin/console/vectors/backfill",
  "POST /admin/console/links/backfill",
  // admin: agents
  "GET /admin/agents",
  "POST /admin/agents",
  "GET /admin/agents/{agent_id}/keys",
  "POST /admin/agents/{agent_id}/keys",
  "DELETE /admin/agents/{agent_id}",
  "DELETE /admin/keys/{key_id}",
  // admin: documents
  "GET /admin/documents",
  "POST /admin/documents",
  "GET /admin/documents/search",
  "PUT /admin/documents/{public_id}",
  "POST /admin/documents/{public_id}/visibility",
  "POST /admin/documents/{public_id}/slug",
  "POST /admin/documents/{public_id}/tags",
  "POST /admin/documents/{public_id}/status",
  // admin: vectors
  "POST /admin/vectors/backfill",
  // admin: link graph (migration 0016 / issue #40)
  "POST /admin/links/backfill",
  "GET /admin/links/orphans",
  // admin: slugs
  "POST /admin/slugs/{slug}/redirect",
  "DELETE /admin/slugs/{slug}/redirect",
  "DELETE /admin/slugs/{slug}",
  // admin: oauth
  "POST /admin/agents/{agent_id}/oauth-clients",
  "POST /admin/oauth-clients",
  "DELETE /admin/oauth-clients/{client_id}",
];

const registrySet = new Set(listRegisteredRoutes().map((r) => `${r.method} ${r.path}`));
const expectedSet = new Set(EXPECTED_ROUTES);
const missingFromRegistry = [...expectedSet].filter((r) => !registrySet.has(r)).sort();
const extraInRegistry = [...registrySet].filter((r) => !expectedSet.has(r)).sort();
check("registry covers the documented surface", missingFromRegistry.length === 0);
if (missingFromRegistry.length) console.log(`  missing: ${missingFromRegistry.join(", ")}`);
check("registry has no undocumented routes", extraInRegistry.length === 0);
if (extraInRegistry.length) console.log(`  extra: ${extraInRegistry.join(", ")}`);
check("no duplicate routes in the registry", listRegisteredRoutes().length === registrySet.size);

// ----- 3. completeness vs index.ts (static exact-match routes) --------------
// Extract every `path === "/literal"` exact-match dispatch in src/index.ts and
// assert each is a registry path — so a new static route can't ship spec-less.
// Dynamic routes (matched via startsWith/endsWith/slice) are covered by the
// documented-surface set above.

const indexSrc = readFileSync(fileURLToPath(new URL("../src/index.ts", import.meta.url)), "utf8");
const registryPaths = new Set(listRegisteredRoutes().map((r) => r.path));
const staticLiterals = new Set();
for (const m of indexSrc.matchAll(/\bpath === "(\/[^"]*)"/g)) staticLiterals.add(m[1]);
const unregisteredStatic = [...staticLiterals].filter((p) => !registryPaths.has(p)).sort();
check(
  `every static index.ts route is registered (${staticLiterals.size} scanned)`,
  unregisteredStatic.length === 0,
);
if (unregisteredStatic.length) console.log(`  unregistered: ${unregisteredStatic.join(", ")}`);

// ----- 4. freshness: regenerate equals the committed openapi.json ------------

const committedPath = fileURLToPath(new URL("../openapi.json", import.meta.url));
let committed = null;
try {
  committed = readFileSync(committedPath, "utf8");
} catch {
  console.log("FAIL committed openapi.json is missing — run `npm run build:openapi`");
  fails++;
}
if (committed !== null) {
  const regenerated = JSON.stringify(buildOpenApiDocument(), null, 2) + "\n";
  check("committed openapi.json is fresh (regenerate → identical)", committed === regenerated);
  if (committed !== regenerated) {
    console.log("  openapi.json is stale — run `npm run build:openapi` and commit the result");
  }
}

// ----------------------------------------------------------------------------

if (fails > 0) {
  console.log(`\n${fails} openapi test(s) FAILED`);
  process.exit(1);
} else {
  console.log("\nall openapi tests passed");
}
