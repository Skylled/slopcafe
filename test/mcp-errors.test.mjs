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
// Plus the visibility echo: the three MCP envelopes must carry `visibility`, and
// the write descriptions must say documents are born private and name the
// operator action. Documents are born private on this deployment, an agent key
// reads everything, and without that field + that sentence the default cold
// session ends by handing a human a URL that 404s.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ErrorCodeSchema,
  McpEditResponseSchema,
  McpReadDocumentResponseSchema,
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
// (edit_document's find/replace codes, read_document's version pin). These are
// legitimate tokens for an agent to branch on, so they extend the vocabulary
// rather than failing the scan.
const MCP_ONLY_CODES = new Set([
  "edit_no_match",
  "edit_not_unique",
  "empty_old_string",
  "no_edits",
  "noop_edit",
  "version_conflict",
  "version_not_found",
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

const TRANSLATORS = ["translatePublishError", "translateUpdateError", "translateEditError"];
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
// a `visibility` input (which is what threading publishDocumentCore's
// visibilityOverride from here would require).
const inputSchemaBlocks = [];
for (let i = src.indexOf("inputSchema: {"); i !== -1; i = src.indexOf("inputSchema: {", i + 1)) {
  inputSchemaBlocks.push(src.slice(i, src.indexOf("outputSchema:", i)));
}
check("found all eight inputSchema blocks", inputSchemaBlocks.length === 8, `found ${inputSchemaBlocks.length}`);
check(
  "no tool declares a visibility input",
  inputSchemaBlocks.every((b) => !/\bvisibility\s*:/.test(b)),
);

// ----------------------------------------------------------------------------

if (fails > 0) {
  console.log(`\n${fails} mcp-error test(s) FAILED`);
  process.exit(1);
} else {
  console.log("\nall mcp-error tests passed");
}
