// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/** Shared MCP success envelopes and bounded unexpected-failure logging. */

import type { McpToolName } from "./mcp-toolset.js";

export type ToolText = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

/**
 * Mirror a successful payload for structured and legacy-text clients.
 * Every tool declares an output schema, which the SDK validates against
 * structuredContent; the JSON text twin preserves legacy client behavior.
 */
export function structuredOk<T extends object>(payload: T): ToolText {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload as Record<string, unknown>,
  };
}

/**
 * Keep a full Apps payload out of model-facing text while preserving it in
 * structuredContent for the embedded application and output-schema validator.
 * This is the deliberate exception to structuredOk's mirror-both convention:
 * view_document can render a large body without also spending model context.
 * Do not substitute `_meta.ui.visibility: ["app"]`; that controls whether the
 * model can see/call the tool and would remove it from tools/list.
 */
export function structuredOkAppSummary<T extends object>(
  payload: T,
  modelSummary: Record<string, unknown>,
): ToolText {
  return {
    content: [{ type: "text", text: JSON.stringify(modelSummary) }],
    structuredContent: payload as Record<string, unknown>,
  };
}

/**
 * Log only a fixed classification; a thrown value may contain document text,
 * SQL, or arbitrary user content. `typeof` does not inspect hostile properties.
 */
export function logUnexpectedMcpThrow(tool: McpToolName, thrown: unknown): void {
  const code =
    (typeof thrown === "object" && thrown !== null) || typeof thrown === "function"
      ? "internal_object_throw"
      : "internal_primitive_throw";
  console.error(`mcp.${tool}.threw`, code);
}
