// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

// Coverage for exact `?tools=` gating and named `?toolset=` presets
// (GitHub issues #59 and #65).
//
// Two things are checked, and the second matters more than the first.
//
// 1. parseToolsetParam's contract: absent means all tools, a valid list means
//    that set, and every rejection path is a rejection rather than a silent
//    narrowing. The rejection direction is the whole point of the feature —
//    a host configures the MCP URL once and nobody re-reads it, so a typo that
//    quietly dropped a tool would present as a missing capability months later.
//
// 2. THE DRIFT GUARD. MCP_TOOL_NAMES is a hand-maintained copy of the tool
//    names registered across the MCP source set. Those modules import the MCP
//    SDK and the WASM sanitizer and cannot be loaded under the strip-types runner.
//    A copy that drifts fails in two nasty ways at once: a newly added tool is
//    unreachable through ?tools=, AND passing its real name is rejected as
//    `bad_request`. So this scans the transport, shared support, and split tool
//    files for `server.registerTool(` call sites and asserts equality BOTH ways.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readMcpSource } from "./support/mcp-source.mjs";
import {
  MCP_TOOL_NAMES,
  MCP_TOOLSETS,
  parseToolSelection,
  parseToolsetParam,
} from "../src/mcp-toolset.ts";

let fails = 0;
function check(label, cond, detail) {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) {
    if (detail) console.log(`  ${detail}`);
    fails++;
  }
}

// ---- 1. parse contract ------------------------------------------------------

const absent = parseToolsetParam(null);
check("absent parameter → ok with allow === null (all tools)", absent.ok && absent.allow === null);

const one = parseToolsetParam("read_document");
check("single valid name → that one tool", one.ok && one.allow?.size === 1 && one.allow.has("read_document"));

const two = parseToolsetParam("read_document,list_documents");
check(
  "two valid names → both",
  two.ok && two.allow?.size === 2 && two.allow.has("read_document") && two.allow.has("list_documents"),
);

const spaced = parseToolsetParam(" read_document , list_documents ");
check("surrounding whitespace is tolerated", spaced.ok && spaced.allow?.size === 2);

const trailing = parseToolsetParam("read_document,");
check("a trailing comma is tolerated", trailing.ok && trailing.allow?.size === 1);

const dupes = parseToolsetParam("read_document,read_document");
check("duplicates collapse", dupes.ok && dupes.allow?.size === 1);

const all = parseToolsetParam(MCP_TOOL_NAMES.join(","));
check(
  "naming every tool is valid and yields all of them",
  all.ok && all.allow?.size === MCP_TOOL_NAMES.length,
);

// Rejections. Each must be a rejection, not a silent narrowing or widening.
for (const [label, raw] of [
  ["a bare unknown name", "publish_documents"],
  ["a near-miss (plural)", "read_documents"],
  ["wrong case", "Read_Document"],
  ["an unknown name mixed with valid ones", "read_document,frobnicate,list_documents"],
]) {
  const r = parseToolsetParam(raw);
  check(`${label} → bad_request, not a silent narrowing`, !r.ok);
  if (!r.ok) {
    const named = raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !MCP_TOOL_NAMES.includes(s));
    check(
      `  ...and the message names the offending value${named.length > 1 ? "s" : ""}`,
      named.every((n) => r.message.includes(n)),
      `message was: ${r.message}`,
    );
  }
}

const multi = parseToolsetParam("frobnicate,widget");
check(
  "several unknown names are reported together (one fix pass, not one 400 each)",
  !multi.ok && multi.message.includes("frobnicate") && multi.message.includes("widget"),
);

for (const [label, raw] of [
  ["an empty value (?tools=)", ""],
  ["only a comma", ","],
  ["only whitespace", "   "],
]) {
  const r = parseToolsetParam(raw);
  check(
    `${label} → bad_request, NOT treated as "all tools"`,
    !r.ok,
    "silently widening an empty ask to the full toolset would hide the mistake",
  );
}

// Every rejection should tell the host what it may say instead.
for (const raw of ["", "frobnicate"]) {
  const r = parseToolsetParam(raw);
  check(
    `rejection for ${JSON.stringify(raw)} lists the valid names`,
    !r.ok && MCP_TOOL_NAMES.every((n) => r.message.includes(n)),
  );
}

// ---- 2. named preset contract ---------------------------------------------

const expectedToolsets = {
  reader: [
    "read_document",
    "view_document",
    "list_documents",
    "search_documents",
    "load_context_pack",
  ],
  author: [
    "publish_document",
    "update_document",
    "edit_document",
    "set_document_tags",
    "set_document_status",
    "read_document",
    "view_document",
    "list_documents",
    "search_documents",
    "load_context_pack",
  ],
  full: MCP_TOOL_NAMES,
};

check(
  "the public preset names are pinned",
  Object.keys(MCP_TOOLSETS).join(",") === Object.keys(expectedToolsets).join(","),
  `found: ${Object.keys(MCP_TOOLSETS).join(", ")}`,
);

for (const [name, expected] of Object.entries(expectedToolsets)) {
  const parsed = parseToolSelection(null, name);
  check(
    `?toolset=${name} resolves to its pinned membership`,
    parsed.ok && [...parsed.allow].join(",") === expected.join(","),
    parsed.ok ? `got: ${[...parsed.allow].join(", ")}` : parsed.message,
  );
}

for (const [label, raw] of [
  ["an unknown preset", "researcher"],
  ["a wrong-case preset", "Reader"],
  ["an empty preset", ""],
  ["a whitespace-only preset", "   "],
]) {
  const parsed = parseToolSelection(null, raw);
  check(`${label} fails closed`, !parsed.ok);
  check(
    `  ...and names every valid preset`,
    !parsed.ok && Object.keys(MCP_TOOLSETS).every((name) => parsed.message.includes(name)),
  );
}

const conflicting = parseToolSelection("read_document", "reader");
check(
  "combining ?tools= and ?toolset= fails closed",
  !conflicting.ok && conflicting.message.includes("cannot be combined"),
);

const exactThroughCombinedParser = parseToolSelection("read_document", null);
check(
  "the exact ?tools= escape hatch remains backward compatible",
  exactThroughCombinedParser.ok &&
    exactThroughCombinedParser.allow?.size === 1 &&
    exactThroughCombinedParser.allow.has("read_document"),
);

const neither = parseToolSelection(null, null);
check("omitting both selectors still exposes all tools", neither.ok && neither.allow === null);

const knownTools = new Set(MCP_TOOL_NAMES);
for (const [name, members] of Object.entries(MCP_TOOLSETS)) {
  const unknown = members.filter((member) => !knownTools.has(member));
  check(
    `every member of the ${name} preset is a registered tool`,
    unknown.length === 0,
    unknown.length ? `unknown: ${unknown.join(", ")}` : undefined,
  );
  check(
    `the ${name} preset contains no duplicate tools`,
    new Set(members).size === members.length,
  );
}

// ---- 3. drift guard against the MCP source set -----------------------------

const mcpSrc = readFileSync(fileURLToPath(new URL("../src/mcp.ts", import.meta.url)), "utf8");
const registeredSrc = readMcpSource();
const registered = [...registeredSrc.matchAll(/server\.registerTool\(\s*\n?\s*"([a-z_]+)"/g)].map((m) => m[1]);

check(
  `the MCP source set registers ${MCP_TOOL_NAMES.length} tools`,
  registered.length === MCP_TOOL_NAMES.length,
  `found ${registered.length}: ${registered.join(", ")}`,
);

const listed = new Set(MCP_TOOL_NAMES);
const inSource = new Set(registered);
const missingFromList = registered.filter((n) => !listed.has(n));
const missingFromSource = MCP_TOOL_NAMES.filter((n) => !inSource.has(n));

check(
  "every tool registered in the MCP source set is in MCP_TOOL_NAMES",
  missingFromList.length === 0,
  missingFromList.length
    ? `missing: ${missingFromList.join(", ")} — a new tool would be unreachable via ?tools= AND its own name would be rejected as bad_request`
    : undefined,
);
check(
  "every name in MCP_TOOL_NAMES is registered in the MCP source set",
  missingFromSource.length === 0,
  missingFromSource.length
    ? `stale: ${missingFromSource.join(", ")} — ?tools= would accept a name that registers nothing`
    : undefined,
);
check(
  "MCP_TOOL_NAMES is in registration order",
  MCP_TOOL_NAMES.join(",") === registered.join(","),
  `source order: ${registered.join(", ")}`,
);

// The gate must be wired in, not just written. Two literals: the dispatch that
// parses the parameter, and the gate that consumes the allowlist.
const indexSrc = readFileSync(fileURLToPath(new URL("../src/index.ts", import.meta.url)), "utf8");
check(
  "src/index.ts parses both selectors on the /mcp dispatch",
  indexSrc.includes("parseToolSelection(") &&
    indexSrc.includes('url.searchParams.get("tools")') &&
    indexSrc.includes('url.searchParams.get("toolset")'),
);
check(
  "src/index.ts rejects a bad toolset with 400 bad_request before dispatch",
  /if \(!toolset\.ok\) \{\s*\n\s*return jsonError\(400, "bad_request", toolset\.message\);/.test(indexSrc),
);
check("src/mcp.ts installs the registration gate", mcpSrc.includes("toolsetGate(mcpServer, allowedTools)"));
check(
  "the McpServer itself still backs createMcpHandler (the gate only wraps registerTool)",
  mcpSrc.includes("createMcpHandler(() => mcpServer,"),
);
check(
  "handleMcp defaults to no narrowing",
  mcpSrc.includes("allowedTools: ReadonlySet<string> | null = null,"),
);

if (fails > 0) {
  console.error(`\n${fails} check(s) failed`);
  process.exit(1);
}
console.log("\nall mcp-toolset tests passed");
