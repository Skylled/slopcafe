// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/** The per-request context and gated registrar every MCP tool module receives. */

import type { McpServer } from "@modelcontextprotocol/server";

import type { Env } from "./env.js";
import type { WaitUntil } from "./vector-io.js";

/**
 * The slice of {@link McpServer} the eleven tool registrations use. Declared as
 * the method type itself so every call site is still checked against the SDK's
 * real overloads — the gate narrows *which* tools register, never *how*.
 */
export interface ToolRegistrar {
  registerTool: McpServer["registerTool"];
}

/**
 * Everything a tool handler closes over, resolved ONCE per request by the
 * transport (src/mcp.ts) and handed to every registrar. `agentId`/`clientId`
 * are the upstream-resolved AwhProps identity (src/mcp-auth.ts) — tools never
 * re-validate auth; `waitUntil` is the ExecutionContext's, pre-bound, for the
 * post-commit vector sync the write cores schedule.
 */
export type McpToolContext = {
  env: Env;
  agentId: string;
  clientId: string | null;
  origin: string;
  waitUntil: WaitUntil;
};
