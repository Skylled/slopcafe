// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

import type { ErrorCode } from "./contract.js";

/** MCP-only failures with no identical HTTP error-code representation. */
export const MCP_ONLY_ERROR_CODES = [
  "edit_no_match",
  "edit_not_unique",
  "empty_old_string",
  "no_edits",
  "noop_edit",
  "version_conflict",
] as const;

export type McpErrorCode = ErrorCode | (typeof MCP_ONLY_ERROR_CODES)[number];

export type ToolErrorResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: { error: McpErrorCode };
  isError: true;
};

/**
 * Build the one Slopcafe handler-failure shape.
 *
 * The legacy text remains unchanged. structuredContent carries only the typed
 * discriminant: human messages may include a bounded excerpt of submitted edit
 * text, which should not be duplicated into machine data a host may persist or
 * log. The pinned SDK accepts structuredContent on isError and skips the tool's
 * success outputSchema validation for that result. SDK-generated failures do
 * not pass through this helper and may retain a text-only native error shape.
 */
export function textError(code: McpErrorCode, text: string): ToolErrorResult {
  return {
    content: [{ type: "text", text: `${code}: ${text}` }],
    structuredContent: { error: code },
    isError: true,
  };
}
