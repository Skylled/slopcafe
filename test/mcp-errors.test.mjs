// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

// Coverage for the MCP failure contract in src/mcp.ts.
//
// The problem this guards: every tool description advertises named error codes
// (`slug_taken`, `edit_not_unique`, `version_not_found`, `bad_query`) and an
// agent is expected to branch on them — but MCP failures are `isError` results,
// which the SDK exempts from outputSchema validation. So the ONLY contract a
// failure has is the text, and nothing in the type system notices when the text
// stops carrying the code. It had already drifted all the way: no handler ever
// emitted a single one of the advertised tokens.
//
// src/mcp.ts imports the MCP SDK and core.ts (which imports the WASM sanitizer),
// so it cannot be loaded under the strip-types runner. These checks therefore
// read it as TEXT — deliberately, because that means they fail when the REAL
// handlers drift, not when a copy does. They pin four properties:
//
//   1. textError() is the single prefixing site: `${code}: ${text}`.
//   2. Every textError() CALL passes a code — a `*.code` expression or a
//      literal. This is the one that rots: a new failure branch is exactly where
//      someone forgets.
//   3. Every code that can reach the wire — literals at call sites, and every
//      `case` label in the translate* switches whose `err.code` is threaded
//      through — is in the known vocabulary (ErrorCodeSchema plus the
//      MCP-only codes core surfaces that have no HTTP twin). Combined with (1)
//      and (2), that IS "each translate* return is emitted prefixed with its
//      err.code".
//   4. No translate* message restates its own code (the "invalid_slug: invalid
//      slug: …" stutter), which is what makes the prefix readable.
//
// Plus the visibility echo: the four MCP envelopes must carry `visibility`, and
// the write descriptions must say documents are born private and name the
// operator action. Documents are born private on this deployment, an agent key
// reads everything, and without that field + that sentence the default cold
// session ends by handing a human a URL that 404s.
//
// Plus the MCP Apps wiring (SEP-1865): view_document must carry BOTH `_meta`
// spellings of the tool→template link, and the ui:// template must be
// registered with the exact profile MIME — hosts key on those strings, and
// nothing else in the suite would notice them drifting.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ErrorCodeSchema,
  McpEditResponseSchema,
  McpReadDocumentResponseSchema,
  McpViewDocumentResponseSchema,
  McpWriteResponseSchema,
} from "../src/contract.ts";

let fails = 0;

function check(label, cond, detail) {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) {
    if (detail) console.log(`  ${detail}`);
    fails++;
  }
}

const mcpPath = fileURLToPath(new URL("../src/mcp.ts", import.meta.url));
const src = readFileSync(mcpPath, "utf8");

// Codes MCP emits that the HTTP door has no equivalent for: core-internal
// result codes the HTTP wrappers map onto status codes instead (version_conflict
// → 412 precondition_failed) or that only exist on the MCP-only surfaces
// (edit_document's find/replace codes). These are legitimate tokens for an agent
// to branch on, so they extend the vocabulary rather than failing the scan.
//
// `version_not_found` used to live here. It no longer does: the 2.0 window made
// it a first-class `ErrorCode` (ledger entry 7), emitted by the operator door's
// restore + promote routes, so it now arrives through ErrorCodeSchema.options.
const MCP_ONLY_CODES = new Set([
  "edit_no_match",
  "edit_not_unique",
  "empty_old_string",
  "no_edits",
  "noop_edit",
  "version_conflict",
]);
const VOCABULARY = new Set([...ErrorCodeSchema.options, ...MCP_ONLY_CODES]);

// ----- 1. textError is the single prefixing site -----------------------------

check(
  "textError takes (code, text)",
  /function textError\(code: string, text: string\): ToolText/.test(src),
  "the failure constructor must take the contract code as its first argument",
);
check(
  "textError emits `${code}: ${text}`",
  /function textError\([^)]*\): ToolText \{\s*return \{ content: \[\{ type: "text", text: `\$\{code\}: \$\{text\}` \}\], isError: true \};/.test(
    src,
  ),
  "the code prefix must be applied in the one failure constructor, not per message",
);

// ----- 2. every call site passes a code --------------------------------------
// Matches `textError(` followed by its first argument. Two legal shapes: a
// dotted `.code` read off a Result/parse failure, or a bare snake_case literal.

// Comment lines and the declaration itself both mention `textError(code, text)`;
// drop them so only real call sites are scanned.
const codeOnly = src
  .split("\n")
  .filter((line) => {
    const t = line.trim();
    return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*") && !t.startsWith("function textError(");
  })
  .join("\n");

const CALL_RE = /textError\(\s*([^,)\n]+)\s*,/g;
const callArgs = [];
for (const m of codeOnly.matchAll(CALL_RE)) callArgs.push(m[1].trim());

check("found the textError call sites", callArgs.length >= 20, `found ${callArgs.length}`);

const literalCodes = new Set();
const badFirstArgs = [];
for (const arg of callArgs) {
  if (/^"[a-z][a-z0-9_]*"$/.test(arg)) {
    literalCodes.add(arg.slice(1, -1));
  } else if (/^[A-Za-z_$][\w$]*\.code$/.test(arg)) {
    // e.g. result.code / parsed.code / err.code — threaded from the Result.
  } else if (/^[\w$.]+\.code === "[a-z_]+" \? "[a-z_]+" : "[a-z_]+"$/.test(arg)) {
    // The one conditional remap (load_context_pack's root_retired → slug_retired).
    for (const m of arg.matchAll(/\? "([a-z_]+)" : "([a-z_]+)"/g)) {
      literalCodes.add(m[1]);
      literalCodes.add(m[2]);
    }
  } else {
    badFirstArgs.push(arg);
  }
}
check(
  "every textError call passes a contract code first",
  badFirstArgs.length === 0,
  badFirstArgs.length > 0 ? `not a code: ${badFirstArgs.join(" | ")}` : undefined,
);

const orphanLiterals = [...literalCodes].filter((c) => !VOCABULARY.has(c)).sort();
check(
  `every literal code at a call site is in the vocabulary (${literalCodes.size} scanned)`,
  orphanLiterals.length === 0,
  orphanLiterals.length > 0 ? `unknown: ${orphanLiterals.join(", ")}` : undefined,
);

// ----- 3. every translate* case label is a real code -------------------------
// The three switches are what `result.code` can be when threaded to textError,
// so their case labels are exactly the tokens an agent will see prefixed.

const TRANSLATORS = [
  "translatePublishError",
  "translateUpdateError",
  "translateEditError",
  "translateSetStatusError",
];
for (const name of TRANSLATORS) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) {
    check(`${name} exists`, false);
    continue;
  }
  // Body runs to the next top-level `\n}` after the declaration.
  const end = src.indexOf("\n}", start);
  const body = src.slice(start, end);
  const cases = [...body.matchAll(/case "([a-z_]+)":/g)].map((m) => m[1]);
  check(`${name} has cases`, cases.length > 0, `found ${cases.length}`);
  const orphans = cases.filter((c) => !VOCABULARY.has(c)).sort();
  check(
    `${name}: every case label is in the vocabulary (${cases.length} cases)`,
    orphans.length === 0,
    orphans.length > 0 ? `unknown: ${orphans.join(", ")}` : undefined,
  );

  // 4. No message may restate its own code — textError already prefixes it, and
  // "invalid_slug: invalid slug: may only contain…" is how that reads.
  const stutters = [];
  for (const m of body.matchAll(/case "([a-z_]+)":\s*\n\s*return\s*\(?\s*[`"]([^`"\n]*)/g)) {
    const [, code, message] = m;
    const words = code.split("_").join(" ");
    if (message.toLowerCase().startsWith(`${code}:`) || message.toLowerCase().startsWith(`${words}:`)) {
      stutters.push(code);
    }
  }
  check(
    `${name}: no message restates its own code`,
    stutters.length === 0,
    stutters.length > 0 ? `stutters: ${stutters.join(", ")}` : undefined,
  );
}

// ----- 5. the visibility echo ------------------------------------------------

for (const [label, schema] of [
  ["McpWriteResponse", McpWriteResponseSchema],
  ["McpEditResponse", McpEditResponseSchema],
  ["McpReadDocumentResponse", McpReadDocumentResponseSchema],
  ["McpViewDocumentResponse", McpViewDocumentResponseSchema],
]) {
  check(`${label} carries visibility`, "visibility" in schema.shape);
  const r = schema.safeParse({ visibility: "teapot" });
  check(`${label}.visibility rejects a non-visibility value`, r.success === false);
}

// A private doc's URL 404s for a logged-out human. The write descriptions are
// the only place a cold agent learns that, and the operator action is the half
// that stops it flailing for a tool parameter that deliberately doesn't exist.
for (const tool of ["publish_document", "update_document"]) {
  const start = src.indexOf(`"${tool}",`);
  const end = src.indexOf("inputSchema:", start);
  const decl = src.slice(start, end);
  check(`${tool} description says documents are born private`, /PRIVATE/.test(decl));
  check(
    `${tool} description names the operator action`,
    /\/manage/.test(decl) && /admin\/documents\/:id\/visibility/.test(decl),
  );
}

// Visibility is READ-ONLY to agents by operator decision — echoed, never set.
// Only the operator may publish a document to the world, so no tool may declare
// a `visibility` input that could REACH a document (which is what threading
// publishDocumentCore's visibilityOverride from here would require).
//
// The one legal occurrence is `list_documents`' FILTER, which narrows rows the
// agent already receives (every listing row has carried `visibility` since
// migration 0011) and cannot write anything. That distinction is the whole
// point, so the guard is keyed per-tool rather than "the token appears
// nowhere": a blanket ban would have to be relaxed by deleting the check, and
// the next person to relax it would relax it for a write tool.
const inputSchemaBlocks = new Map();
for (let i = src.indexOf("inputSchema: {"); i !== -1; i = src.indexOf("inputSchema: {", i + 1)) {
  // Walk back to the registerTool call this schema belongs to and read its name.
  const decl = src.lastIndexOf("server.registerTool(", i);
  const name = /server\.registerTool\(\s*\n?\s*"([a-z_]+)"/.exec(src.slice(decl, i))?.[1];
  inputSchemaBlocks.set(name ?? `unknown@${i}`, src.slice(i, src.indexOf("outputSchema:", i)));
}
check("found all eleven inputSchema blocks", inputSchemaBlocks.size === 11, `found ${inputSchemaBlocks.size}`);

// Where a read-only classification FILTER is allowed. Nothing else may name it.
const VISIBILITY_FILTER_TOOLS = new Set(["list_documents"]);
const settableVisibility = [...inputSchemaBlocks]
  .filter(([name, b]) => !VISIBILITY_FILTER_TOOLS.has(name) && /\bvisibility\s*:/.test(b))
  .map(([name]) => name);
check(
  "no tool outside the read filter declares a visibility input",
  settableVisibility.length === 0,
  settableVisibility.length > 0 ? `declares visibility: ${settableVisibility.join(", ")}` : undefined,
);
// …and the one that does must be a filter over the two states, not a setter:
// it may not be threaded into a write core.
const listBlock = inputSchemaBlocks.get("list_documents") ?? "";
check(
  "list_documents' visibility input is an enum filter",
  /visibility:\s*VISIBILITY_FILTER_FIELD/.test(listBlock),
);
check(
  "the visibility filter field says it cannot set the field",
  /VISIBILITY_FILTER_FIELD = z[\s\S]{0,900}?cannot set the field/.test(src),
);

// The publication pointer is the same class of authority as visibility, and the
// curation tools (set_document_tags / set_document_status) are exactly the
// precedent someone would argue from to add a third classification input. There
// is no agent-reachable promote and none may be added — see migration 0018.
// `publication` (the pending/current read filter) is deliberately NOT this
// token: it selects rows by the pointer's relationship to current_ver and can
// name no version, so it cannot express a promote.
check(
  "no tool declares a published-version input",
  [...inputSchemaBlocks.values()].every((b) => !/\bpublished_(ver|version)\s*:/.test(b)),
);

// ----- 6. the MCP Apps wiring (SEP-1865) -------------------------------------
// Hosts key on exact strings here: the extension id, the ui:// URI, the
// profile MIME, and the two `_meta` spellings of the tool→template link (each
// generation of host reads only its own key — registerAppTool emits both).
// None of this is reachable by the type system, so pin it as text.

check(
  "UI_RESOURCE_URI is the ui:// template address",
  /const UI_RESOURCE_URI = "ui:\/\/slopcafe\/document-view\.html"/.test(src),
);
check(
  "UI_RESOURCE_MIME is exactly the SEP-1865 profile MIME",
  /const UI_RESOURCE_MIME = "text\/html;profile=mcp-app"/.test(src),
);
check(
  "the tool→template _meta carries BOTH spellings at the ui:// URI",
  /ui: \{ resourceUri: UI_RESOURCE_URI \}/.test(src) &&
    /"ui\/resourceUri": UI_RESOURCE_URI/.test(src),
);
// view_document's registerTool config must reference that _meta constant (the
// registration block runs from the tool name to its handler's arrow).
const viewStart = src.indexOf('"view_document",');
const viewBlock = viewStart === -1 ? "" : src.slice(viewStart, src.indexOf("async (", viewStart));
check("view_document is registered", viewStart !== -1);
check(
  "view_document's registerTool block links the app template (both spellings via the constant)",
  /_meta: VIEW_DOCUMENT_TOOL_META/.test(viewBlock),
);
// The template resource itself: registered at the ui:// URI with the exact
// MIME on the listing config AND the read content item.
const rrStart = src.indexOf("server.registerResource(");
const rrBlock = rrStart === -1 ? "" : src.slice(rrStart, src.indexOf(");", rrStart));
check("the ui:// template resource is registered", rrStart !== -1);
check(
  "registerResource uses the ui:// URI and the profile MIME (listing + contents)",
  /"document-view",\s*\n\s*UI_RESOURCE_URI,/.test(rrBlock) &&
    (rrBlock.match(/mimeType: UI_RESOURCE_MIME/g) ?? []).length === 2,
);
// The capability advertisement: resources + the extension key.
check(
  "capabilities declare resources and the io.modelcontextprotocol/ui extension",
  /resources: \{\},\s*\n\s*extensions: \{ "io\.modelcontextprotocol\/ui": \{\} \}/.test(src),
);
// The template itself (read as text, like src above). Two one-token
// properties a refactor could drop silently, neither reachable by any other
// test: the nested document iframe must never gain script execution (the
// sandbox is the wall behind the sanitizer — an empty-ish sandbox is what
// lets us inject H at all), and the bridge must keep its parent-source gate
// (a hostile sibling iframe could otherwise forge a tool-result into the
// render path).
const tplPath = fileURLToPath(new URL("../src/mcp-app-template.html", import.meta.url));
const tpl = readFileSync(tplPath, "utf8");
check(
  "the template's doc iframe is sandboxed with exactly allow-same-origin",
  /<iframe id="doc"[^>]*sandbox="allow-same-origin"[^>]*>/.test(tpl),
);
check(
  "allow-scripts appears nowhere in the template",
  !/allow-scripts/.test(tpl),
);
check(
  "the bridge gates inbound messages on ev.source === window.parent",
  tpl.includes("if (ev.source !== window.parent) return;"),
);

// ----------------------------------------------------------------------------

if (fails > 0) {
  console.log(`\n${fails} mcp-error test(s) FAILED`);
  process.exit(1);
} else {
  console.log("\nall mcp-error tests passed");
}
