// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

// Coverage for the append-only audit ledger (migration 0020 / GitHub issue #62):
// src/audit.ts's writer union and src/contract.ts's wire shapes.
//
// Four jobs, in descending order of how much they matter:
//
//   1. THE NEVER-LOG RULE, BY CONSTRUCTION. Walk every field name of every
//      member of the writer's discriminated union and fail the build if any of
//      them could carry a credential or a payload. This is the test the whole
//      module's design exists to make possible: `recordAudit` takes a typed
//      union rather than a free-form object precisely so that "we never log
//      secrets" is a checkable property of the code instead of a promise in a
//      comment. Deleting this test is how that quietly stops being true.
//   2. Migration lockstep — the `kind` enum in contract.ts, the members of the
//      writer union, and the CHECK constraint in migrations/0020 are three
//      copies of one list. Pin them against each other so a kind added in code
//      without the migration fails HERE rather than as a constraint violation
//      on a deployed Worker, hours later, silently swallowed by the ledger's own
//      best-effort contract.
//   3. Schema round-trip — representative events parse; malformed ones don't.
//   4. Detail assembly — the writer folds unknown-to-the-schema keys away and
//      keeps only declared scalars.
//
// Pure-schema; no D1. The write path itself (an INSERT off waitUntil) needs a
// database and is covered by test/e2e/audit.sh.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AuditEventInputSchema } from "../src/audit.ts";
import {
  AuditEventSchema,
  AuditKindSchema,
  AuditOutcomeSchema,
  AuditPrincipalKindSchema,
  ListAuditResponseSchema,
} from "../src/contract.ts";

let fails = 0;
function check(label, cond) {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) fails++;
}
function parses(label, schema, value) {
  const r = schema.safeParse(value);
  if (!r.success) {
    console.log(`FAIL ${label}`);
    console.log(`  zod: ${JSON.stringify(r.error.issues?.[0] ?? r.error)}`);
    fails++;
  } else {
    console.log(`ok   ${label}`);
  }
}
function rejects(label, schema, value) {
  check(label, schema.safeParse(value).success === false);
}

// ----- 1. the never-log rule -------------------------------------------------

/**
 * Field names that must never appear on an audit event, because a field with one
 * of these names is a field somebody will eventually put a credential or a
 * payload into. The rule is on the NAME, deliberately: it is checkable, it is
 * obvious at a call site, and it makes the dangerous thing hard to spell.
 */
const FORBIDDEN = [
  "token",
  "key",
  "secret",
  "password",
  "body",
  "content",
  "authorization",
  "cookie",
  "verifier",
  "code",
];

/**
 * The one deliberate near-miss. `key_id` CONTAINS "key" but is an opaque
 * `agent_keys` row id — exactly what an audit trail should carry (it is how an
 * operator ties a mint to its later revoke) and exactly not what the rule is
 * about. Allowlisted by exact name so the substring check below can stay strict:
 * a future `api_key` or `key_material` field is still caught.
 */
const ID_ALLOWLIST = new Set(["key_id"]);

const members = AuditEventInputSchema.options;
check(`writer union has members (${members.length})`, members.length > 0);

const offenders = [];
const allFieldNames = new Set();
for (const member of members) {
  const kind = member.shape.kind?.value ?? "(unknown)";
  for (const field of Object.keys(member.shape)) {
    allFieldNames.add(field);
    if (ID_ALLOWLIST.has(field)) continue;
    const lower = field.toLowerCase();
    for (const bad of FORBIDDEN) {
      // Exact match OR substring: `api_key`, `access_token`, `body_html` are all
      // caught, not just a field literally named `key`.
      if (lower === bad || lower.includes(bad)) {
        offenders.push(`${kind}.${field} (matches "${bad}")`);
      }
    }
  }
}
check(
  `no audit event field can carry a credential or payload (${allFieldNames.size} distinct field names)`,
  offenders.length === 0,
);
if (offenders.length > 0) console.log(`  offending fields: ${offenders.join(", ")}`);

// The rule is only meaningful if the scan actually saw the fields it claims to.
// A refactor that changed `.options` or `.shape` could make the loop above pass
// vacuously over an empty set.
check("the scan saw the identity fields it is supposed to guard", allFieldNames.has("key_id"));
check("the scan saw a per-kind detail field", allFieldNames.has("version"));

// And the same rule on the READ shape — a column the writer cannot fill is
// still a column the wire would expose.
const wireOffenders = Object.keys(AuditEventSchema.shape).filter(
  (f) => !ID_ALLOWLIST.has(f) && FORBIDDEN.some((bad) => f.toLowerCase().includes(bad)),
);
check("no AuditEvent wire field can carry a credential or payload", wireOffenders.length === 0);
if (wireOffenders.length > 0) console.log(`  offending wire fields: ${wireOffenders.join(", ")}`);

// ----- 2. migration lockstep -------------------------------------------------

const migration = readFileSync(
  fileURLToPath(new URL("../migrations/0020_audit_events.sql", import.meta.url)),
  "utf8",
);

/** Pull a CHECK (col IN ('a','b',…)) list out of the migration text. */
function checkList(column) {
  const re = new RegExp(`${column}\\s+TEXT\\s+NOT NULL\\s+CHECK\\s*\\(\\s*${column} IN \\(([^)]*)\\)`, "s");
  const m = migration.match(re);
  if (!m) return null;
  return [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
}

const sqlKinds = checkList("kind");
check("migration 0020 declares a kind CHECK", Array.isArray(sqlKinds) && sqlKinds.length > 0);
if (sqlKinds) {
  const enumKinds = new Set(AuditKindSchema.options);
  const sqlSet = new Set(sqlKinds);
  const missingInSql = [...enumKinds].filter((k) => !sqlSet.has(k)).sort();
  const missingInEnum = [...sqlSet].filter((k) => !enumKinds.has(k)).sort();
  check("every AuditKind is in the migration CHECK", missingInSql.length === 0);
  if (missingInSql.length) console.log(`  in code, not in SQL: ${missingInSql.join(", ")}`);
  check("every migration CHECK value is an AuditKind", missingInEnum.length === 0);
  if (missingInEnum.length) console.log(`  in SQL, not in code: ${missingInEnum.join(", ")}`);
}

const sqlPrincipals = checkList("principal_kind");
if (sqlPrincipals) {
  check(
    "principal_kind CHECK == AuditPrincipalKind",
    sqlPrincipals.length === AuditPrincipalKindSchema.options.length &&
      AuditPrincipalKindSchema.options.every((v) => sqlPrincipals.includes(v)),
  );
}
const sqlOutcomes = checkList("outcome");
if (sqlOutcomes) {
  check(
    "outcome CHECK == AuditOutcome",
    sqlOutcomes.length === AuditOutcomeSchema.options.length &&
      AuditOutcomeSchema.options.every((v) => sqlOutcomes.includes(v)),
  );
}

// Every kind in the enum must have exactly one writer-union member — otherwise a
// kind is declarable in the contract and unwritable in practice (or vice versa).
const memberKinds = members.map((m) => m.shape.kind.value);
check(
  "one writer-union member per AuditKind",
  memberKinds.length === AuditKindSchema.options.length &&
    AuditKindSchema.options.every((k) => memberKinds.includes(k)),
);
check("no duplicate kinds in the writer union", new Set(memberKinds).size === memberKinds.length);

// The index the cursor walk depends on. Its shape is the whole reason the list
// endpoint can paginate stably (see the pagination contract).
check(
  "migration 0020 indexes (at DESC, id DESC)",
  /CREATE INDEX audit_events_at ON audit_events \(at DESC, id DESC\)/.test(migration),
);

// ----- 3. round-trip ---------------------------------------------------------

parses("input: consent_allowed with agent + client", AuditEventInputSchema, {
  kind: "consent_allowed",
  principal_kind: "operator",
  agent_id: "4e1f3f6a-0000-4000-8000-000000000001",
  client_id: "abc123",
  request_id: "8f0e1a2b3c4d5e6f-LHR",
});
parses("input: login_failed carries no identity at all", AuditEventInputSchema, {
  kind: "login_failed",
  principal_kind: "anonymous",
});
parses("input: document_promoted with a version", AuditEventInputSchema, {
  kind: "document_promoted",
  principal_kind: "operator",
  document_id: "hdbOcFnhL1y9fe0tWpBvXA",
  version: 4,
});
parses("input: write_conflict from an agent", AuditEventInputSchema, {
  kind: "write_conflict",
  principal_kind: "agent",
  document_id: "hdbOcFnhL1y9fe0tWpBvXA",
  agent_id: "4e1f3f6a-0000-4000-8000-000000000001",
  expected: 2,
  current: 5,
});

rejects("input: unknown kind is rejected", AuditEventInputSchema, {
  kind: "operator_had_a_nap",
  principal_kind: "operator",
});
rejects("input: slug_locked cannot be filed as the operator", AuditEventInputSchema, {
  kind: "slug_locked",
  principal_kind: "operator",
  document_id: "hdbOcFnhL1y9fe0tWpBvXA",
});
rejects("input: a non-scalar detail value is rejected", AuditEventInputSchema, {
  kind: "document_promoted",
  principal_kind: "operator",
  version: { nested: true },
});

// `outcome` is fixed per kind and defaulted, so a call site never states it and
// can never state it wrongly.
const denied = AuditEventInputSchema.parse({ kind: "login_failed", principal_kind: "anonymous" });
check("outcome defaults to the kind's own verdict", denied.outcome === "denied");
const allowed = AuditEventInputSchema.parse({
  kind: "consent_allowed",
  principal_kind: "operator",
});
check("a successful kind defaults to ok", allowed.outcome === "ok");

// Unknown keys are STRIPPED, not carried — the belt to the type system's braces,
// and what makes the never-log rule hold even against a JS caller.
const stripped = AuditEventInputSchema.parse({
  kind: "login_succeeded",
  principal_kind: "operator",
  operator_token: "hunter2",
  authorization: "Bearer awh_live_secret",
});
check(
  "unknown keys are stripped, never carried into a row",
  !("operator_token" in stripped) && !("authorization" in stripped),
);

// ----- 4. wire shapes --------------------------------------------------------

const row = {
  id: "9a4f0d18-0000-4000-8000-00000000000a",
  at: "2026-09-03T11:22:33.444Z",
  kind: "document_visibility_changed",
  principal_kind: "operator",
  agent_id: null,
  client_id: null,
  key_id: null,
  document_id: "hdbOcFnhL1y9fe0tWpBvXA",
  outcome: "ok",
  detail: { visibility: "public" },
  request_id: null,
};
parses("wire: AuditEvent row", AuditEventSchema, row);
parses("wire: AuditEvent with a null detail", AuditEventSchema, { ...row, detail: null });
rejects("wire: a missing nullable field is still required", AuditEventSchema, {
  ...row,
  request_id: undefined,
});
parses("wire: ListAuditResponse page", ListAuditResponseSchema, {
  events: [row],
  next_cursor: "eyJ0cyI6IjIwMjYifQ",
});
parses("wire: ListAuditResponse last page", ListAuditResponseSchema, {
  events: [],
  next_cursor: null,
});
rejects("wire: next_cursor may not be omitted", ListAuditResponseSchema, { events: [] });

// ----------------------------------------------------------------------------

if (fails > 0) {
  console.log(`\n${fails} audit test(s) FAILED`);
  process.exit(1);
} else {
  console.log("\nall audit tests passed");
}
