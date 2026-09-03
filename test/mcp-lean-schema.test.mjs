// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0
// Lean MCP output schemas (issue #59): descriptions leave the wire, the shape
// and validation stay. Run: node --experimental-strip-types --no-warnings
//   --import=./test/register-ts-resolver.mjs test/mcp-lean-schema.test.mjs
import {
  leanOutputSchema,
  stripDescriptions,
  PROTECTED_OUTPUT_FIELDS,
} from "../src/mcp-lean-schema.ts";
import {
  McpReadDocumentResponseSchema,
  McpWriteResponseSchema,
  McpEditResponseSchema,
  McpSetTagsResponseSchema,
  McpSetStatusResponseSchema,
  McpViewDocumentResponseSchema,
  ListDocumentsResponseSchema,
  McpSearchDocumentsResponseSchema,
  PackResponseSchema,
  CreatePublishCredentialResponseSchema,
} from "../src/contract.ts";

let failed = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${msg}`);
  if (!cond) failed++;
};
const OPTS = { target: "draft-2020-12" };
const json = (schema) => schema["~standard"].jsonSchema.output(OPTS);

// Walk a JSON Schema and collect every `description`, tagged with the property
// name it describes (undefined = root/structural), mirroring the SDK's output.
function descriptions(node, keyName, out = []) {
  if (Array.isArray(node)) {
    for (const n of node) descriptions(n, undefined, out);
    return out;
  }
  if (node === null || typeof node !== "object") return out;
  for (const [k, v] of Object.entries(node)) {
    if (k === "description") out.push({ keyName, text: v });
    else if (k === "properties" && v && typeof v === "object")
      for (const [name, sub] of Object.entries(v)) descriptions(sub, name, out);
    else descriptions(v, undefined, out);
  }
  return out;
}

// 1. The pure stripper: everything but the protected set goes, structure intact.
{
  const src = {
    description: "root",
    type: "object",
    properties: {
      visibility: { type: "string", description: "keep me" },
      title: { type: "string", description: "drop me" },
      documents: {
        type: "array",
        description: "drop me too",
        items: {
          type: "object",
          properties: {
            published_version: { type: ["integer", "null"], description: "keep nested" },
            slug: { type: "string", description: "drop nested" },
          },
        },
      },
    },
    anyOf: [{ description: "drop in anyOf", type: "object" }],
  };
  const out = stripDescriptions(src);
  const kept = descriptions(out).map((d) => d.text).sort();
  ok(JSON.stringify(kept) === JSON.stringify(["keep me", "keep nested"]), "stripper keeps exactly the protected descriptions at every depth");
  ok(out.properties.documents.items.properties.slug.type === "string", "stripper preserves structure and types");
  ok(src.properties.title.description === "drop me", "stripper does not mutate its input");
}

// 2. Every registered output schema, through the wrapper the SDK will call.
const schemas = {
  McpWriteResponse: McpWriteResponseSchema,
  McpEditResponse: McpEditResponseSchema,
  McpSetTagsResponse: McpSetTagsResponseSchema,
  McpSetStatusResponse: McpSetStatusResponseSchema,
  McpReadDocumentResponse: McpReadDocumentResponseSchema,
  McpViewDocumentResponse: McpViewDocumentResponseSchema,
  ListDocumentsResponse: ListDocumentsResponseSchema,
  McpSearchDocumentsResponse: McpSearchDocumentsResponseSchema,
  PackResponse: PackResponseSchema,
  CreatePublishCredentialResponse: CreatePublishCredentialResponseSchema,
};
let before = 0;
let after = 0;
for (const [name, schema] of Object.entries(schemas)) {
  const lean = leanOutputSchema(schema);
  ok(lean !== schema && leanOutputSchema(schema) === lean, `${name}: wrapper is a distinct, memoized object`);
  const full = json(schema);
  const slim = json(lean);
  before += JSON.stringify(full).length;
  after += JSON.stringify(slim).length;
  const leaked = descriptions(slim).filter((d) => !(d.keyName && PROTECTED_OUTPUT_FIELDS.has(d.keyName)));
  ok(leaked.length === 0, `${name}: no unprotected description survives (${leaked.length} leaked)`);
  const fullProtected = descriptions(full).filter((d) => d.keyName && PROTECTED_OUTPUT_FIELDS.has(d.keyName)).length;
  const slimProtected = descriptions(slim).filter((d) => d.keyName && PROTECTED_OUTPUT_FIELDS.has(d.keyName)).length;
  ok(fullProtected === slimProtected, `${name}: every protected description survives (${slimProtected})`);
  const strip = (o) => JSON.stringify(stripDescriptions(o, new Set()));
  ok(strip(full) === strip(slim), `${name}: shape is byte-identical once descriptions are ignored`);
  ok(lean["~standard"].validate === schema["~standard"].validate, `${name}: validate is the original (result validation unchanged)`);
}
ok(after < before * 0.8, `output schemas shrink by more than 20% on the wire (${before} → ${after} bytes, −${before - after})`);

// 3. Validation really runs through the wrapper the way the SDK invokes it.
{
  const lean = leanOutputSchema(McpSetTagsResponseSchema);
  const good = await lean["~standard"].validate({ public_id: "AAAAAAAAAAAAAAAAAAAAAA", tags: ["a"], visibility: "private" });
  const bad = await lean["~standard"].validate({ public_id: 42 });
  ok(!good.issues, "a valid envelope validates through the lean wrapper");
  ok(bad.issues && bad.issues.length > 0, "an invalid envelope is rejected through the lean wrapper");
}

// 4. The protected set is the documented trust-boundary quartet — change both together.
ok(
  [...PROTECTED_OUTPUT_FIELDS].sort().join() === "published_version,status,superseded_by,visibility",
  "protected set = visibility, published_version, status, superseded_by",
);

console.log(failed ? `\n${failed} lean-schema test(s) failed` : "\nall mcp-lean-schema tests passed");
process.exit(failed ? 1 : 0);
