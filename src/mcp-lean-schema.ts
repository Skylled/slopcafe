// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0
/**
 * Lean MCP output schemas (issue #59, the "safe now" tier).
 *
 * Measured on the wire, `tools/list` is ~90 KB, and the eleven `outputSchema`s
 * are ~35 KB of it — the largest single block, and one the issue never counted.
 * A little under half of those bytes are `.describe()` text that exists for the
 * OpenAPI document (`contract.ts` is the single source of truth for BOTH the
 * HTTP contract and the MCP envelopes). An MCP host does not need field prose
 * on a RESULT schema to call the tool; it needs the shape, which validation
 * still enforces.
 *
 * So the schemas stay exactly as declared in `contract.ts`; this wrapper only
 * changes what `tools/list` advertises: it returns the same standard-schema
 * object with `~standard.jsonSchema.output` replaced by a copy that drops every
 * `description` EXCEPT on the trust-boundary fields in `PROTECTED_OUTPUT_FIELDS`.
 * Those echoes are the born-private / publication story an agent must see on
 * every envelope ("stored but not live yet"), and CLAUDE.md records the 404
 * regression that followed the last time that wording went missing — they are
 * a keep-list, not a percentage.
 *
 * Validation is untouched: the SDK validates `structuredContent` through
 * `~standard.validate`, which this wrapper passes through verbatim, so the
 * `structuredOk` hard-fail invariant holds and `contract.ts` remains canonical.
 * Pure and dependency-free — `test/mcp-lean-schema.test.mjs`.
 */

import type { StandardJSONSchemaV1 } from "@standard-schema/spec";

/** Result-envelope fields whose `.describe()` text stays on the wire. */
export const PROTECTED_OUTPUT_FIELDS: ReadonlySet<string> = new Set([
  "visibility",
  "published_version",
  "status",
  "superseded_by",
]);

/**
 * Deep-copy a JSON Schema document, dropping `description` everywhere except
 * on properties whose name is in `keep`. `keyName` is the property name the
 * current node is the schema OF (undefined for the root and for structural
 * nodes such as `items`/`anyOf` members), so a protected name is honoured at
 * every nesting depth — `documents[].visibility` as much as top-level
 * `visibility`.
 */
export function stripDescriptions(
  node: unknown,
  keep: ReadonlySet<string> = PROTECTED_OUTPUT_FIELDS,
  keyName?: string,
): unknown {
  if (Array.isArray(node)) return node.map((n) => stripDescriptions(n, keep));
  if (node === null || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (k === "description") {
      if (keyName !== undefined && keep.has(keyName)) out[k] = v;
      continue;
    }
    if (k === "properties" && v !== null && typeof v === "object" && !Array.isArray(v)) {
      const props: Record<string, unknown> = {};
      for (const [name, sub] of Object.entries(v as Record<string, unknown>)) {
        props[name] = stripDescriptions(sub, keep, name);
      }
      out[k] = props;
      continue;
    }
    out[k] = stripDescriptions(v, keep);
  }
  return out;
}

const leanCache = new WeakMap<object, unknown>();

/**
 * Wrap a standard schema (a zod 4 schema in practice) so `tools/list` advertises
 * its OUTPUT JSON Schema without field descriptions (protected set excepted),
 * while `~standard.validate` — and therefore result validation — is the original.
 * Returns the same static type so call sites read as before. Memoized per schema.
 */
export function leanOutputSchema<S extends StandardJSONSchemaV1>(schema: S): S {
  const hit = leanCache.get(schema);
  if (hit) return hit as S;
  const std = schema["~standard"];
  const js = std.jsonSchema;
  const lean = {
    "~standard": {
      ...std,
      jsonSchema: {
        input: (opts: StandardJSONSchemaV1.Options) => js.input(opts),
        output: (opts: StandardJSONSchemaV1.Options) =>
          stripDescriptions(js.output(opts)) as Record<string, unknown>,
      },
    },
  } as unknown as S;
  leanCache.set(schema, lean);
  return lean;
}
