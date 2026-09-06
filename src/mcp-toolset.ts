// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/**
 * Toolset gating for `/mcp` — exact `?tools=` narrowing (issue #59) and the
 * named `?toolset=` presets layered over it (issue #65).
 *
 * A host that only ever publishes documents should not have to carry eleven
 * tool descriptions and schemas in its model's context. `?tools=a,b` narrows
 * BOTH `tools/list` and `tools/call` to the named subset for that connection;
 * omitting the parameter serves DEFAULT_MCP_TOOLS (see below — every tool
 * except `view_document`). It is the industry answer (GitHub's MCP server
 * calls it `--toolsets`) and it is purely additive — no wire shape moves.
 *
 * NOT AN AUTHORIZATION BOUNDARY, and it must never be mistaken for one. The
 * credential presented at `/mcp` carries exactly the same authority whichever
 * subset is named; a narrowed URL is a host-side *preference* about context
 * budget, not a permission. Anything that would actually restrict what an
 * agent may do belongs in the trust model (see CLAUDE.md) — visibility,
 * revoke and promotion stay operator-only for reasons a query parameter can't
 * enforce, since the caller chooses the query.
 *
 * AN UNKNOWN NAME FAILS LOUD. A host configures the MCP URL once, months
 * before anyone notices a missing capability, so a typo that silently narrowed
 * the toolset would surface as "Slopcafe can't do X" rather than "your URL is
 * wrong". The parsers therefore reject any unrecognized exact name or preset
 * with a message that names it and lists what is valid, and the caller turns
 * that into a 400 before the request ever reaches the MCP transport — so it
 * fails at connect time on `initialize`, not on some later `tools/call`.
 *
 * PURE LEAF: no imports at all, so `test/mcp-toolset.test.mjs` runs it under
 * the strip-types runner without D1/R2/WASM in scope. The name list is
 * duplicated from the MCP registration source because those modules cannot
 * be loaded in a test; the same test scans the source set assembled by
 * `test/support/mcp-source.mjs` for `server.registerTool(` call sites and
 * fails if the two ever disagree — a
 * new tool missing from this list would be unreachable via `?tools=` AND
 * would make its own name a `bad_request`.
 */

/**
 * The eleven agent-scoped tools, in registration order.
 *
 * KEEP IN LOCKSTEP with the `server.registerTool(...)` calls in the MCP source set
 * (the drift guard in `test/mcp-toolset.test.mjs` enforces this, both ways).
 */
export const MCP_TOOL_NAMES = [
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
  "create_publish_credential",
] as const;

export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

/**
 * What a connection gets when it names no `tools` and no `toolset`.
 *
 * Everything EXCEPT `view_document`. That tool exists to hand a host's MCP
 * Apps surface a whole sanitized document to render inline, and current UI
 * hosts do not lay out documents of the length this corpus actually holds —
 * an embedded render of a long document is worse for the human than the
 * metadata summary plus a `/d/<id>` link. Until hosts handle that well, the
 * embedded viewer is opt-in rather than something every connector inherits.
 *
 * OPT-IN, NOT REMOVED: `?toolset=full` or an exact `?tools=…,view_document`
 * still registers it, and the ui:// template resource is still served
 * unconditionally, so a host that wants the viewer needs one URL change.
 *
 * This is a context/presentation default, NOT an authorization boundary — the
 * same rule as every other name in this module: `view_document` reads exactly
 * what `read_document` reads, so excluding it withholds no authority.
 */
export const DEFAULT_MCP_TOOLS = MCP_TOOL_NAMES.filter(
  (name) => name !== "view_document",
) as readonly McpToolName[];

/**
 * Stable, intent-shaped presets for hosts that do not need a bespoke list.
 *
 * `reader` is side-effect free. `author` adds every document mutation an
 * ordinary agent can perform, but deliberately omits credential minting: a
 * connector configured to work with the corpus does not usually need to make
 * credentials for other processes. `full` is the complete registered surface.
 *
 * KEEP THE EXPLICIT MEMBERSHIPS HERE. They are the one source of truth used by
 * parsing and documentation/tests; test/mcp-toolset.test.mjs verifies that
 * every member is registered and pins the intended groups.
 *
 * Only `full` carries `view_document` — the presets follow the same default as
 * an unnarrowed connection (see DEFAULT_MCP_TOOLS): a host asking for "reader"
 * or "author" is describing intent, not asking for the embedded viewer.
 */
export const MCP_TOOLSETS = {
  reader: [
    "read_document",
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
    "list_documents",
    "search_documents",
    "load_context_pack",
  ],
  full: MCP_TOOL_NAMES,
} as const satisfies Record<string, readonly McpToolName[]>;

export type McpToolsetName = keyof typeof MCP_TOOLSETS;

/**
 * Result of parsing `?tools=` / `?toolset=`.
 *
 * `allow` is ALWAYS a set — there is no "no narrowing" state, because the
 * unnarrowed case has its own explicit membership (DEFAULT_MCP_TOOLS). One
 * definition of what a connection gets means the default can never drift from
 * what the gate actually registers. The set is never empty: an empty
 * parameter is a `bad_request`.
 */
export type ToolsetParse =
  | { ok: true; allow: ReadonlySet<McpToolName> }
  | { ok: false; message: string };

const KNOWN = new Set<string>(MCP_TOOL_NAMES);
const TOOLSET_NAMES = Object.keys(MCP_TOOLSETS) as McpToolsetName[];

/**
 * Parse the `tools` query parameter into an allowlist.
 *
 * - absent (`null`) → DEFAULT_MCP_TOOLS (everything but `view_document`).
 * - a comma-separated list of known names → that set (duplicates collapse,
 *   surrounding whitespace and empty segments from a trailing comma are
 *   tolerated — a hand-edited URL should not fail on cosmetics).
 * - present but naming nothing (`?tools=`, `?tools=,`, `?tools=%20`) →
 *   rejected. Serving a connection with zero tools is never what anyone meant,
 *   and silently treating it as "all" would hide the mistake.
 * - any unrecognized name → rejected, naming every bad one at once so a host
 *   fixes the URL in a single pass rather than one 400 per typo.
 */
export function parseToolsetParam(raw: string | null): ToolsetParse {
  if (raw === null) return { ok: true, allow: new Set(DEFAULT_MCP_TOOLS) };

  const requested = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (requested.length === 0) {
    return {
      ok: false,
      message:
        "the `tools` query parameter names no tools; omit it entirely for the default " +
        `toolset, or list the ones you want (valid: ${MCP_TOOL_NAMES.join(", ")})`,
    };
  }

  const unknown = requested.filter((name) => !KNOWN.has(name));
  if (unknown.length > 0) {
    return {
      ok: false,
      message:
        `unknown tool name${unknown.length > 1 ? "s" : ""} in the \`tools\` query parameter: ` +
        `${unknown.join(", ")} (valid: ${MCP_TOOL_NAMES.join(", ")})`,
    };
  }

  return { ok: true, allow: new Set(requested as McpToolName[]) };
}

/**
 * Resolve the two public narrowing knobs for one `/mcp` connection.
 *
 * The grammars are intentionally separate: `tools` is a comma-separated
 * exact allowlist, while `toolset` is one stable preset name. Supplying both
 * is rejected rather than guessing which one wins. As with exact narrowing,
 * unknown or empty preset values fail at connection time.
 */
export function parseToolSelection(
  rawTools: string | null,
  rawToolset: string | null,
): ToolsetParse {
  if (rawTools !== null && rawToolset !== null) {
    return {
      ok: false,
      message:
        "the `tools` and `toolset` query parameters cannot be combined; use `toolset` for a named preset or `tools` for an exact list",
    };
  }

  if (rawToolset === null) return parseToolsetParam(rawTools);

  const name = rawToolset.trim();
  if (!Object.hasOwn(MCP_TOOLSETS, name)) {
    const shown = name.length > 0 ? `unknown MCP toolset: ${name}` : "the `toolset` query parameter is empty";
    return {
      ok: false,
      message: `${shown} (valid: ${TOOLSET_NAMES.join(", ")})`,
    };
  }

  return {
    ok: true,
    allow: new Set(MCP_TOOLSETS[name as McpToolsetName]),
  };
}
