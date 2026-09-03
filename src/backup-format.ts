// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/**
 * The corpus backup file format (issue #9) — the PURE half.
 *
 * Everything here is a string/bytes function with no env, D1, R2 or WASM, so
 * it runs under the strip-types unit runner (`test/backup-format.test.mjs`).
 * The impure export walk and the restore core live in src/backup.ts, exactly
 * the vector.ts / vector-io.ts split.
 *
 * FORMAT. NDJSON — one JSON object per line, each carrying a `kind`
 * discriminator, validated against `BackupRecordSchema` (src/contract.ts). A
 * page (one `GET /admin/backup` response) is:
 *
 *   {kind:"header", …}          page 1 only
 *   {kind:"agent"|…}            entity records — a document travels with ALL
 *                               of its versions and links on the same page
 *   {kind:"footer", counts}     last page only
 *   {kind:"page", next_cursor}  EVERY page, always last: a page missing this
 *                               trailer was cut short mid-stream
 *
 * CURSOR. The export walks five phases in a fixed order (agents → agent_keys
 * → oauth_clients → documents → slug_tombstones), each `(ts, id)` ascending
 * so a restore replays in creation order (agents before the rows that
 * reference them). The cursor is `{p, ts, id}`: the phase plus the last
 * emitted key; an empty `ts` means "from the start of phase p" (a phase that
 * ended exactly on a page boundary). Opaque base64url JSON, never
 * hand-constructed — same posture as src/pagination.ts's cursor. Distinct from
 * that cursor on purpose: a list cursor replayed here (or vice versa) fails to
 * decode instead of silently walking the wrong table.
 */

import { BackupRecordSchema, type BackupRecord } from "./contract.js";

export const BACKUP_FORMAT = "slopcafe-backup" as const;
export const BACKUP_FORMAT_VERSION = 1 as const;

export const BACKUP_PHASES = [
  "agents",
  "agent_keys",
  "oauth_clients",
  "documents",
  "slug_tombstones",
] as const;
export type BackupPhase = (typeof BACKUP_PHASES)[number];

/** Units per page (rows for the small tables; DOCUMENTS — each with every
 *  version's two blobs inline — for the documents phase). The default is
 *  deliberately below the list default of 50: a page of fifty long-edited
 *  documents is tens of megabytes. */
export const BACKUP_DEFAULT_LIMIT = 20;
export const BACKUP_MAX_LIMIT = 200;

/** Cap on a `POST /admin/restore` body. A page is bounded by the export
 *  limit, and a restore reads the whole body into memory to validate every
 *  line before applying anything (fail-closed), so the cap is what keeps a
 *  hostile upload from being a memory attack. 32 MiB comfortably holds a
 *  default-sized page; a bigger export page restores in pieces. */
export const RESTORE_MAX_BODY_BYTES = 32 * 1024 * 1024;

export type BackupCursor = { phase: BackupPhase; ts: string; id: string };

export function isBackupPhase(v: unknown): v is BackupPhase {
  return typeof v === "string" && (BACKUP_PHASES as readonly string[]).includes(v);
}

/** The phase after `p`, or null when `p` is the last one. */
export function nextBackupPhase(p: BackupPhase): BackupPhase | null {
  const i = BACKUP_PHASES.indexOf(p);
  return i >= 0 && i + 1 < BACKUP_PHASES.length ? BACKUP_PHASES[i + 1]! : null;
}

function base64UrlEncode(s: string): string {
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(s: string): string {
  const padded = s + "=".repeat((4 - (s.length % 4)) % 4);
  return atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
}

export function encodeBackupCursor(c: BackupCursor): string {
  // Timestamps and ids are ASCII (D1 strftime output, UUIDs, public_ids,
  // client ids, slugs), so btoa's Latin-1 requirement holds. A slug or client
  // id is validated ASCII at write time.
  return base64UrlEncode(JSON.stringify({ p: c.phase, ts: c.ts, id: c.id }));
}

/** Null on ANY malformation — including a phase this build doesn't know, so a
 *  cursor minted by a future format can't be walked against the wrong table. */
export function decodeBackupCursor(s: string): BackupCursor | null {
  try {
    const obj = JSON.parse(base64UrlDecode(s));
    if (
      obj &&
      typeof obj === "object" &&
      !Array.isArray(obj) &&
      isBackupPhase(obj.p) &&
      typeof obj.ts === "string" &&
      typeof obj.id === "string"
    ) {
      return { phase: obj.p, ts: obj.ts, id: obj.id };
    }
  } catch {
    /* fall through */
  }
  return null;
}

/** `?limit=` for the export: absent/empty → the default; otherwise an integer
 *  in [1, BACKUP_MAX_LIMIT] or null (the caller answers `bad_limit`). */
export function parseBackupLimit(raw: string | null): number | null {
  if (raw === null || raw === "") return BACKUP_DEFAULT_LIMIT;
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= BACKUP_MAX_LIMIT ? n : null;
}

/** Standard base64 of `bytes` (what `btoa` emits: `+/=`), chunked so a
 *  multi-megabyte blob doesn't build one giant argument list. */
export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let bin = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
  }
  return btoa(bin);
}

/** Inverse of bytesToBase64. Throws on malformed input — callers validate the
 *  string against `BackupRecordSchema` first, so a throw here is a bug. */
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export type ParsedBackupLine = { line: number; record: BackupRecord };
export type InvalidBackupLine = { line: number; reason: string };

/**
 * Parse an NDJSON body into validated records + the lines that failed.
 *
 * Every non-blank line must be a JSON object that satisfies
 * `BackupRecordSchema`; anything else is reported by 1-based line number with
 * a short reason, and NOTHING is inferred from a bad line. Blank lines and a
 * trailing `\r` (a file that passed through Windows) are tolerated. The caller
 * (restore) treats a non-empty `invalid` list as "reject the page whole" in
 * apply mode — the fail-closed rule for a hostile file.
 */
export function parseBackupNdjson(text: string): {
  records: ParsedBackupLine[];
  invalid: InvalidBackupLine[];
} {
  const records: ParsedBackupLine[] = [];
  const invalid: InvalidBackupLine[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    let raw = lines[i]!;
    if (raw.endsWith("\r")) raw = raw.slice(0, -1);
    if (raw.trim() === "") continue;
    const line = i + 1;
    let obj: unknown;
    try {
      obj = JSON.parse(raw);
    } catch {
      invalid.push({ line, reason: "not valid JSON" });
      continue;
    }
    if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
      invalid.push({ line, reason: "not a JSON object" });
      continue;
    }
    const parsed = BackupRecordSchema.safeParse(obj);
    if (!parsed.success) {
      invalid.push({ line, reason: summarizeIssues(parsed.error.issues) });
      continue;
    }
    records.push({ line, record: parsed.data });
  }
  return { records, invalid };
}

/** The first few Zod issues as `path: message`, capped — a diagnostic, never
 *  an echo of the offending value (a hostile file's contents stay out of the
 *  report and the logs). */
function summarizeIssues(issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>): string {
  const parts = issues
    .slice(0, 3)
    .map((iss) => `${iss.path.length ? iss.path.map(String).join(".") : "(record)"}: ${iss.message}`);
  const s = parts.join("; ");
  return s.length > 300 ? `${s.slice(0, 297)}...` : s;
}
