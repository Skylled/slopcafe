/**
 * src/wire.ts — core Result → on-the-wire response mappers (Phase 2b of
 * api-contract-design.md).
 *
 * The core write functions (src/core.ts) return `{ ok: true, ... }`-tagged
 * Result objects (WriteOk / EditOk / RevokeOk); the JSON that reaches the wire
 * strips that internal `ok` tag (revoke renames it `revoked`). Before Phase 2b
 * that strip was hand-copied in THREE places — `createDocument` + `updateDocument`
 * in src/index.ts and `writeOkResponse` in src/mcp.ts — a silent drift surface
 * (add a field to WriteOk, forget a copy, ship a response missing it). These
 * mappers are the single copy, typed against the wire schemas in src/contract.ts
 * so the compiler checks the shape: the return type IS `WriteResponse`, so a
 * field the schema gains/loses is a compile error here, not a silent wire bug.
 *
 * They are byte-identical to the old hand-lists by construction: core builds its
 * WriteOk in the same key order the handlers emitted, so `{ ok, ...wire } = r`
 * yields the exact same JSON (object key order is the construction order).
 *
 * Pure + standalone — the only import is `import type` from contract.ts (fully
 * erased), so this stays a leaf like search.ts / edit.ts / conditional.ts.
 */
import type {
  EditOk,
  EditResponse,
  RevokeOk,
  RevokeResponse,
  WriteOk,
  WriteResponse,
} from "./contract.js";

/** WriteOk (publish/update success) → WriteResponse — drop the internal `ok`. */
export function toWriteResponse(result: WriteOk): WriteResponse {
  const { ok, ...wire } = result;
  void ok;
  return wire;
}

/** EditOk → EditResponse — a WriteResponse plus the find/replace `replacements`. */
export function toEditResponse(result: EditOk): EditResponse {
  const { ok, ...wire } = result;
  void ok;
  return wire;
}

/** RevokeOk → RevokeResponse — rename the `ok` success flag to `revoked`. */
export function toRevokeResponse(result: RevokeOk): RevokeResponse {
  return {
    revoked: true,
    public_id: result.public_id,
    r2_objects_purged: result.r2_objects_purged,
  };
}
