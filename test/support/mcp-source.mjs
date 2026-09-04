// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/** Read the MCP transport, shared registration support, and split tool files. */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function readMcpSource() {
  const srcDir = fileURLToPath(new URL("../../src/", import.meta.url));
  let transport = readFileSync(`${srcDir}/mcp.ts`, "utf8");
  const toolDir = `${srcDir}/mcp-tools`;
  if (existsSync(toolDir)) {
    for (const name of readdirSync(toolDir).filter((entry) => entry.endsWith(".ts")).sort()) {
      const toolSource = readFileSync(`${toolDir}/${name}`, "utf8");
      const registrar = /export function (register[A-Za-z0-9]+Tool)\(/.exec(toolSource)?.[1];
      if (!registrar) throw new Error(`MCP tool module ${name} exports no register*Tool function`);

      const callSite = transport.indexOf(`${registrar}(server`);
      if (callSite < 0) throw new Error(`MCP transport never calls ${registrar} from ${name}`);
      // Insert the module where its registrar executes. Source-text tests then
      // observe the same registration order as the runtime while tools move
      // out of mcp.ts incrementally.
      transport = `${transport.slice(0, callSite)}${toolSource}\n${transport.slice(callSite)}`;
    }
  }
  const support = ["mcp-tool-input.ts", "mcp-tool-result.ts"].map((path) =>
    readFileSync(`${srcDir}/${path}`, "utf8"),
  );
  return [transport, ...support].join("\n");
}
