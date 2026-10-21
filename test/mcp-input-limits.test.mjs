// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

// Exercise the actual per-request server, registrations, and agents HTTP wrapper.
// Bundle locally to load the Worker's HTML/WASM imports under Node; no services.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { MAX_MCP_TOOL_INPUT_ELEMENTS } from "../src/mcp-limits.ts";

const temp = await mkdtemp(join(tmpdir(), "slopcafe-mcp-limits-"));
try {
  const outfile = join(temp, "mcp.mjs");
  await build({
    entryPoints: ["src/mcp.ts"], outfile, bundle: true, format: "esm",
    platform: "node", conditions: ["workerd"],
    loader: { ".html": "text", ".wasm": "binary" },
  });
  const { handleMcp } = await import(pathToFileURL(outfile));
  // Any service access would mean validation/identity rejection ran too late.
  const env = new Proxy({}, { get() { throw new Error("unexpected service access"); } });
  const ctx = { waitUntil() {} };
  async function call(name, args, modern = true) {
    const params = { name, arguments: args };
    if (modern) params._meta = {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": {},
    };
    const response = await handleMcp(new Request("https://slopcafe.example/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json", Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": modern ? "2026-07-28" : "2025-11-25",
        "Mcp-Method": "tools/call", "Mcp-Name": name,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params }),
    }), env, ctx, { agentId: "test", clientId: null, via: "bearer" });
    assert.equal(response.status, 200);
    const text = await response.text();
    const message = JSON.parse(text.startsWith("event:")
      ? text.split("\n").find((line) => line.startsWith("data: ")).slice(6) : text);
    assert.ok(message.result, text);
    return message.result;
  }
  for (const modern of [true, false]) {
    for (const args of [
      { tags: Array(MAX_MCP_TOOL_INPUT_ELEMENTS).fill(42) },
      Object.fromEntries(Array.from({ length: MAX_MCP_TOOL_INPUT_ELEMENTS + 1 }, (_, i) => [`key${i}`, 0])),
      { edits: Array(1_400).fill({ old_string: "a", new_string: "b" }) },
    ]) {
      const result = await call("edit_document", args, modern);
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /maximum of 4096 elements/);
    }
    // Largest supported working batch plus metadata passes SDK validation and
    // reaches the real handler's missing-identity refusal, before any storage.
    const result = await call("edit_document", {
      edits: Array(1_000).fill({ old_string: "a", new_string: "b" }),
      tags: Array(10).fill("tag"), title: "Title", description: "Description",
      replace_all: false, expected_version: 1, new_slug: "renamed",
    }, modern);
    assert.equal(result.structuredContent.error, "bad_request");
  }
  // Large body strings do not consume the structural budget. The core's 5 MiB
  // content cap is independent; update refuses missing identity before storage.
  const result = await call("update_document", { content: "x".repeat(3 * 1024 * 1024), format: "html" });
  assert.equal(result.structuredContent.error, "bad_request");
  console.log("MCP input limits: arrays, keys, nested edits refused in both protocol lanes; legitimate batch and large string accepted");
} finally {
  await rm(temp, { recursive: true, force: true });
}
