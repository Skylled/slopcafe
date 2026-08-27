// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

// Coverage for the insight fork's SINGLE-PUBLISHER / MULTI-READER auth surface —
// the two properties the whole model rests on, neither of which any other test
// in this suite can see:
//
//   A. READ vs MUTATE. Every route gate in admin.ts / console.ts / serve.ts is
//      classified here, once, by name. A read gate accepts the reader tier
//      (`requireReadSession` / `requireReader` / `resolvePrincipal` /
//      `authenticateSessionRequest`); a mutate or credential gate accepts only
//      the operator (`requireOperator` / `authorizeOperatorForm` /
//      `authenticateOperatorRequest`) or only a writing principal
//      (`requireCurator`). The table below IS the classification in the report,
//      executable: moving a handler across the line without editing this file
//      fails the suite.
//
//   B. WRITER ENFORCEMENT LIVES IN CORE. Every write core calls
//      `refuseNonWriter` before doing anything, every write core takes an
//      `author`, and every door that consumes a write core handles
//      `read_only_agent`. Enforcing in the shared core is what makes a future
//      door inherit the rule; these checks are what stop someone quietly
//      relocating it to the routes (where the next door would miss it).
//
// These are TEXT scans of the real source files, deliberately — the same
// technique test/mcp-errors.test.mjs uses and for the same reason. admin.ts /
// serve.ts / core.ts / mcp.ts all import the WASM sanitizer transitively and
// cannot be loaded under the strip-types runner, so the choice is "assert
// against the real handlers as text" or "assert against a copy". A copy is not
// worth having: it would keep passing after the real gate changed.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

let fails = 0;

function check(label, cond, detail) {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) {
    if (detail) console.log(`  ${detail}`);
    fails++;
  }
}

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const ADMIN = read("../src/admin.ts");
const CONSOLE = read("../src/console.ts");
const SERVE = read("../src/serve.ts");
const CORE = read("../src/core.ts");
const MCP = read("../src/mcp.ts");
const INDEX = read("../src/index.ts");
const SESSION = read("../src/session.ts");

/**
 * The source text of one top-level function, from its signature to the first
 * closing brace in column 0. Every module here indents function bodies, so that
 * brace is unambiguous. Returns null when the function is missing, which the
 * caller reports as a failure rather than silently passing.
 */
function bodyOf(src, name) {
  const sig = new RegExp(`\\n(?:export )?(?:async )?function ${name}\\b`);
  const m = sig.exec(src);
  if (!m) return null;
  const start = m.index + 1;
  const end = src.indexOf("\n}\n", start);
  return end === -1 ? src.slice(start) : src.slice(start, end + 2);
}

// ============================================================================
// A. The read-vs-mutate classification of every operator gate
// ============================================================================

// Gate vocabulary, and what each one admits.
//
//   requireOperator             operator only (JSON; CSRF header on unsafe)
//   authorizeOperatorForm       operator only (HTML form; CSRF field)
//   authenticateOperatorRequest operator only (raw resolver)
//   requireReadSession          operator OR reader          (JSON read)
//   authenticateSessionRequest  operator OR reader          (HTML read)
//   requireReader               operator OR reader OR agent (credentialed read)
//   resolvePrincipal            all four principals, caller decides
//   requireCurator              operator OR agent — NEVER reader (write)
const OPERATOR_ONLY = ["requireOperator", "authorizeOperatorForm", "authenticateOperatorRequest"];
const READER_OK = ["requireReadSession", "authenticateSessionRequest", "requireReader", "resolvePrincipal"];

/**
 * handler → the gate it must use.
 *
 * `mutate`   — the gate must be one of OPERATOR_ONLY and must NOT be any of
 *              READER_OK. This is the reader-tier safety property: a mutation
 *              that admitted a reader would be a silent privilege grant.
 * `read`     — the gate must be one of READER_OK.
 * `curate`   — must use `requireCurator` (operator or agent, never reader).
 * `credential` — a READ, but of agents/keys/OAuth clients: operator-only anyway,
 *              because enumerating credentials is a step in an attack on the
 *              write path, not corpus browsing.
 */
const GATES = [
  // ---- src/admin.ts ------------------------------------------------------
  ["admin", "listAgents", "credential"], //            GET    /admin/agents
  ["admin", "mintAgent", "mutate"], //                 POST   /admin/agents
  ["admin", "listAgentKeys", "credential"], //         GET    /admin/agents/:id/keys
  ["admin", "mintAgentKey", "mutate"], //              POST   /admin/agents/:id/keys
  ["admin", "revokeAgent", "mutate"], //               DELETE /admin/agents/:id
  ["admin", "revokeKey", "mutate"], //                 DELETE /admin/keys/:id
  ["admin", "setSlugRedirect", "mutate"], //           POST   /admin/slugs/:slug/redirect
  ["admin", "clearSlugRedirect", "mutate"], //         DELETE /admin/slugs/:slug/redirect
  ["admin", "releaseSlugTombstone", "mutate"], //      DELETE /admin/slugs/:slug
  ["admin", "listDocuments", "read"], //               GET    /admin/documents
  ["admin", "listDocumentsForReader", "read"], //      GET    /d
  ["admin", "searchDocuments", "read"], //             GET    /admin/documents/search
  ["admin", "searchDocumentsForReader", "read"], //    GET    /d/search
  ["admin", "loadContextPackForReader", "read"], //    GET    /d/pack
  ["admin", "backfillVectors", "mutate"], //           POST   /admin/vectors/backfill
  ["admin", "backfillLinks", "mutate"], //             POST   /admin/links/backfill
  ["admin", "listOrphanDocuments", "read"], //         GET    /admin/links/orphans
  ["admin", "setDocumentVisibility", "mutate"], //     POST   /admin/documents/:id/visibility
  ["admin", "promoteDocumentVersion", "mutate"], //    POST   /admin/documents/:id/promote
  ["admin", "setDocumentSlug", "mutate"], //           POST   /admin/documents/:id/slug
  ["admin", "setDocumentStatus", "mutate"], //         POST   /admin/documents/:id/status
  ["admin", "setDocumentTags", "mutate"], //           POST   /admin/documents/:id/tags
  ["admin", "curateDocumentStatus", "curate"], //      PUT    /d/:id/status
  ["admin", "curateDocumentTags", "curate"], //        PUT    /d/:id/tags
  ["admin", "getDocument", "read"], //                 GET    /admin/documents/:id
  ["admin", "listDocumentVersions", "read"], //        GET    /admin/documents/:id/versions
  ["admin", "restoreDocumentVersion", "mutate"], //    POST   /admin/documents/:id/restore
  ["admin", "createDocumentAsOperator", "mutate"], //  POST   /admin/documents
  ["admin", "updateDocumentAsOperator", "mutate"], //  PUT    /admin/documents/:id

  // ---- src/console.ts ----------------------------------------------------
  ["console", "serveConsoleDashboard", "read"], //     GET  /admin/console
  ["console", "serveConsoleDocuments", "read"], //     GET  /admin/console/documents
  ["console", "serveConsoleAgents", "credential"], //  GET  /admin/console/agents
  ["console", "serveConsoleAgentDetail", "credential"], // GET /admin/console/agents/:id
  ["console", "serveConsoleMaintenance", "mutate"], // GET  /admin/console/maintenance (backfill forms)
  ["console", "handleConsoleMintAgent", "mutate"], //  POST /admin/console/agents
  ["console", "handleConsoleMintKey", "mutate"], //    POST /admin/console/agents/:id/keys
  ["console", "handleConsoleRevokeKey", "mutate"], //  POST /admin/console/keys/revoke
  ["console", "handleConsoleRevokeAgent", "mutate"], //POST /admin/console/agents/revoke
  ["console", "handleConsoleMintBoundClient", "mutate"], //   POST /admin/console/agents/:id/oauth-clients
  ["console", "handleConsoleMintUnboundClient", "mutate"], // POST /admin/console/oauth-clients
  ["console", "handleConsoleDeleteClient", "mutate"], //      POST /admin/console/oauth-clients/delete
  ["console", "handleConsoleBackfill", "mutate"], //   POST /admin/console/vectors/backfill
  ["console", "handleConsoleLinksBackfill", "mutate"], //     POST /admin/console/links/backfill

  // ---- src/serve.ts ------------------------------------------------------
  ["serve", "serveDocument", "read"], //               GET  /d/:id
  ["serve", "serveShell", "read"], //                  GET  /d/:id (shell branch)
  ["serve", "serveRaw", "read"], //                    GET  /d/:id/raw
  ["serve", "serveBySlug", "read"], //                 GET  /s/:slug
  ["serve", "serveRetiredSlug", "read"], //            GET  /s/:slug (410/redirect branch)
  ["serve", "redirectTargetReadableBy", "read"], //    (helper: may we NAME a redirect target?)
  ["serve", "serveText", "read"], //                   GET  /d/:id/text
  ["serve", "serveTextBySlug", "read"], //             GET  /s/:slug/text
  ["serve", "serveSource", "read"], //                 GET  /d/:id/source
  ["serve", "serveLinks", "read"], //                  GET  /d/:id/links
  ["serve", "serveVersionRaw", "read"], //             GET  /d/:id/v/:n/raw
  ["serve", "serveVersionShell", "read"], //           GET  /d/:id/v/:n
  ["serve", "serveManagePage", "mutate"], //           GET  /d/:id/manage (all controls mutate)
  ["serve", "serveRevokeConfirm", "mutate"], //        GET  /d/:id/revoke (confirm form)
  ["serve", "handleRevokeForm", "mutate"], //          POST /d/:id/revoke
  ["serve", "handleVisibilityForm", "mutate"], //      POST /d/:id/visibility
  ["serve", "handleSlugForm", "mutate"], //            POST /d/:id/slug
  ["serve", "handleTagsForm", "mutate"], //            POST /d/:id/tags
  ["serve", "handleStatusForm", "mutate"], //          POST /d/:id/status
  ["serve", "handleRestoreForm", "mutate"], //         POST /d/:id/restore
  ["serve", "handlePromoteForm", "mutate"], //         POST /d/:id/promote
];

const SOURCES = { admin: ADMIN, console: CONSOLE, serve: SERVE };
const mentions = (body, names) => names.filter((n) => body.includes(`${n}(`));

for (const [mod, fn, kind] of GATES) {
  const body = bodyOf(SOURCES[mod], fn);
  if (body === null) {
    check(`${mod}.${fn} exists`, false, "handler not found — was it renamed or removed?");
    continue;
  }
  const operatorGates = mentions(body, OPERATOR_ONLY);
  const readerGates = mentions(body, READER_OK);
  const curator = body.includes("requireCurator(");

  if (kind === "mutate" || kind === "credential") {
    check(
      `${mod}.${fn} (${kind}) is operator-only`,
      operatorGates.length > 0 && readerGates.length === 0 && !curator,
      `operator gates: [${operatorGates}] reader-admitting gates: [${readerGates}] curator: ${curator}`,
    );
  } else if (kind === "read") {
    check(
      `${mod}.${fn} (read) admits the reader tier`,
      readerGates.length > 0 && !curator,
      `reader-admitting gates: [${readerGates}] operator-only gates: [${operatorGates}]`,
    );
  } else if (kind === "curate") {
    check(
      `${mod}.${fn} (curate) uses requireCurator`,
      curator && readerGates.length === 0 && operatorGates.length === 0,
      `curator: ${curator} reader: [${readerGates}] operator: [${operatorGates}]`,
    );
  }
}

// THE COMPLETENESS CHECK — the one that makes the table above a contract rather
// than a snapshot. Every top-level function in the three modules that calls a
// gate must be classified above, or explicitly exempted here. Add a gated
// handler without a row and this fails, naming it.
const GATE_CALL_RE =
  /\b(requireOperator|authorizeOperatorForm|authenticateOperatorRequest|requireReadSession|authenticateSessionRequest|requireReader|requireCurator|resolvePrincipal)\(/;

// Functions that legitimately mention a gate without BEING a route handler:
// the gate definitions themselves, and the two post-mutation re-render helpers
// that receive an already-resolved authorization from their caller.
const EXEMPT = new Set(["requireReader", "requireCurator", "reRenderAgents"]);

/** Every `[name, body]` pair for top-level functions in a module. */
function topLevelFunctions(src) {
  const re = /\n(?:export )?(?:async )?function ([A-Za-z0-9_]+)\s*[(<]/g;
  const out = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    const start = m.index + 1;
    const end = src.indexOf("\n}\n", start);
    out.push([m[1], end === -1 ? src.slice(start) : src.slice(start, end + 2)]);
  }
  return out;
}

for (const [mod, src] of Object.entries(SOURCES)) {
  const classified = new Set(GATES.filter(([m]) => m === mod).map(([, fn]) => fn));
  const unclassified = topLevelFunctions(src)
    .filter(([name, body]) => GATE_CALL_RE.test(body) && !classified.has(name) && !EXEMPT.has(name))
    .map(([name]) => name);
  check(
    `${mod}: every gated function is classified above`,
    unclassified.length === 0,
    `unclassified gated functions: ${unclassified.join(", ")}`,
  );
}

// ============================================================================
// B. `requireCurator` refuses the reader tier
// ============================================================================
// The gate is defined in serve.ts and is the ONLY thing standing between the
// reader tier and the two agent-door classification writes.

const curatorBody = bodyOf(SERVE, "requireCurator") ?? "";
check("requireCurator exists", curatorBody.length > 0);
check(
  "requireCurator admits operator and agent only",
  curatorBody.includes('principal.kind === "operator"') && curatorBody.includes('principal.kind === "agent"'),
  curatorBody,
);
check(
  "requireCurator has no `reader` branch (reader falls through to the refusal)",
  !curatorBody.includes('=== "reader"'),
);
check(
  "requireCurator's refusal is the same unauthorizedJson every anonymous caller gets",
  curatorBody.includes("unauthorizedJson(message)"),
);

// `authenticateOperatorRequest` must NARROW on tier, or every operator gate in
// the codebase would silently start accepting reader cookies.
const narrowBody = bodyOf(SESSION, "authenticateOperatorRequest") ?? "";
check(
  "authenticateOperatorRequest narrows to tier === operator",
  narrowBody.includes('auth.tier !== "operator"'),
  narrowBody,
);

// The modules NOT covered by the table above must contain no reader-admitting
// gate at all. `authorize.ts` is the OAuth consent surface (approving a grant
// hands an agent access to the corpus); `admin-oauth.ts` mints and deletes
// clients; `oauth.ts` is the provider wiring; `index.ts` dispatches and owns
// `DELETE /d/:id`. A reader-admitting gate appearing in any of them is either a
// mistake or a surface that needs classifying.
const READER_ADMITTING = /\b(requireReadSession|authenticateSessionRequest|requireReader|requireCurator|resolvePrincipal)\(/;
for (const mod of ["authorize", "admin-oauth", "oauth"]) {
  check(`${mod}.ts uses no reader-admitting gate`, !READER_ADMITTING.test(read(`../src/${mod}.ts`)));
}
// index.ts is dispatch-only: the one gate it calls is `requireOperator`, on
// `DELETE /d/:id`.
check("index.ts's only gate is requireOperator (DELETE /d/:id)", !READER_ADMITTING.test(INDEX));
check("index.ts still gates DELETE /d/:id on requireOperator", INDEX.includes("await requireOperator(req, env)"));

// ============================================================================
// C. Writer enforcement lives in the shared cores
// ============================================================================

const WRITE_CORES = [
  "publishDocumentCore",
  "updateDocumentCore",
  "editDocumentCore",
  "setDocumentTagsCore",
  "setDocumentStatusCore",
];

for (const core of WRITE_CORES) {
  const body = bodyOf(CORE, core);
  if (body === null) {
    check(`core.${core} exists`, false, "write core not found");
    continue;
  }
  check(`core.${core} takes an author`, /\bauthor: Author\b/.test(body), body.slice(0, 400));
  check(`core.${core} calls refuseNonWriter`, body.includes("refuseNonWriter(env, author)"));
  // The gate must run FIRST: before the id-shape check, the body-size check, or
  // any D1/R2 read. Anything earlier is work a refused agent could force, and a
  // pre-existence check would turn the refusal into an existence oracle.
  const gateAt = body.indexOf("refuseNonWriter(env, author)");
  const firstAwait = body.indexOf("await ", body.indexOf("{"));
  check(
    `core.${core} runs the gate before any await`,
    gateAt !== -1 && (firstAwait === -1 || gateAt < firstAwait),
    `gate at ${gateAt}, first await at ${firstAwait}`,
  );
}

// `refuseNonWriter` is the ONLY place the decision is made, and it delegates to
// the pure predicate in auth.ts (unit-tested in test/auth.test.mjs).
const refuse = bodyOf(CORE, "refuseNonWriter") ?? "";
check("refuseNonWriter delegates to agentMayWrite", refuse.includes("agentMayWrite(env, author)"));
check("refuseNonWriter emits the read_only_agent code", refuse.includes('code: "read_only_agent"'));
check("refuseNonWriter echoes the agent id", refuse.includes("agent_id"));

// No route module may re-implement the check — that's how a second door drifts.
for (const [name, src] of [["admin", ADMIN], ["index", INDEX], ["mcp", MCP], ["serve", SERVE], ["console", CONSOLE]]) {
  check(
    `${name}.ts does not re-implement the allowlist (no agentMayWrite/WRITER_AGENT_IDS use)`,
    !src.includes("agentMayWrite(") && !/env\.WRITER_AGENT_IDS/.test(src),
  );
}

// ============================================================================
// D. Every door that consumes a write core handles read_only_agent
// ============================================================================

check("index.ts (POST /d, PUT /d/:id) handles read_only_agent", (INDEX.match(/case "read_only_agent":/g) ?? []).length >= 2);
check("index.ts answers it with the shared 403 responder", INDEX.includes("readOnlyAgent(result.agent_id)"));
check("admin.ts exports the shared 403 responder", /export function readOnlyAgent\(/.test(ADMIN));
check("admin.ts responder uses 403", /readOnlyAgent[\s\S]{0,400}?jsonError\(\s*403/.test(ADMIN));
check("admin.ts handles read_only_agent (tags/status/write/restore)", (ADMIN.match(/read_only_agent/g) ?? []).length >= 4);
check("mcp.ts has one read_only_agent message helper", /function readOnlyAgentText\(/.test(MCP));
check("mcp.ts publish translator handles it", /case "read_only_agent":\s*\n\s*return readOnlyAgentText/.test(MCP));
check("mcp.ts status translator handles it", (MCP.match(/case "read_only_agent":/g) ?? []).length >= 2);
// The message must tell the agent to STOP, not to re-authenticate: the reflex it
// has to defeat is "mint a fresh publish credential and retry".
const msg = bodyOf(MCP, "readOnlyAgentText") ?? "";
check("mcp read_only_agent text says do not retry", /do not retry/i.test(msg));
check("mcp read_only_agent text warns off minting a credential", /mint a publish credential/i.test(msg));
check("mcp read_only_agent text points at reads", /read_document/.test(msg));

// The MCP classification tools must thread the CALLER's identity into the core —
// not a hardcoded or operator author, which would hand every connected agent a
// write the allowlist was meant to refuse.
check(
  "mcp set_document_tags passes the caller's agent identity",
  /setDocumentTagsCore\(env, target\.publicId, tags, \{\s*\n?\s*kind: "agent",\s*\n?\s*agentId: props\.agentId,?\s*\n?\s*\}\)/.test(MCP),
);
check(
  "mcp set_document_status passes the caller's agent identity",
  /setDocumentStatusCore\(env, target\.publicId, status, superseded_by, \{\s*\n?\s*kind: "agent",\s*\n?\s*agentId: props\.agentId,?\s*\n?\s*\}\)/.test(MCP),
);

// create_publish_credential mints against `props.agentId` — the SAME identity
// the write cores test — which is why enforcement-at-write covers the ephemeral
// key path and no separate gate is needed there.
check(
  "create_publish_credential mints for the caller's own agent id",
  /mintEphemeralKey\(\s*\n?\s*env,\s*\n?\s*props\.agentId,/.test(MCP),
);

// ----------------------------------------------------------------------------

if (fails > 0) {
  console.log(`\n${fails} authz-surface test(s) FAILED`);
  process.exit(1);
} else {
  console.log("\nall authz-surface tests passed");
}
