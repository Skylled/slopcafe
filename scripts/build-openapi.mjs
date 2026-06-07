// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

// Regenerates the committed `openapi.json` from src/contract.ts (via
// src/openapi.ts). Run with:
//
//   npm run build:openapi
//
// which invokes this under the Node strip-types runner + the repo's .js→.ts
// resolver (so openapi.ts's `./contract.js` imports resolve). It is wired into
// `predeploy` so a deploy can't ship a stale spec, and `test/openapi.test.mjs`
// re-runs the same assembler and fails if the committed file is out of date
// (the CI freshness gate: `git diff --exit-code openapi.json`).
//
// Deterministic by construction (sorted components, fixed route order, default
// server URL) so regeneration is byte-stable.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildOpenApiDocument } from "../src/openapi.ts";

const out = fileURLToPath(new URL("../openapi.json", import.meta.url));
const doc = buildOpenApiDocument();
writeFileSync(out, JSON.stringify(doc, null, 2) + "\n");
console.log(`wrote ${out}`);
