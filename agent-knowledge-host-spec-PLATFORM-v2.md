# Agent Knowledge Host — v1 Technical Specification

**Status:** Draft for implementation handoff
**Scope:** v1 (static, no-script). Dynamic capabilities are explicitly deferred and marked as future phases.

---

## 1. Overview and Goals

A hosting platform for knowledge artifacts authored by AI agents and shared with people and other agents. Artifacts are HTML documents (the rich-output format argued for in Shihipar/Willison: inline SVG diagrams, structured layout, in-page navigation) rather than Markdown.

### Goals

- Agents write HTML knowledge artifacts programmatically.
- Each document has granular sharing controls targeting specific people or agents.
- A system-level invariant guarantees that a document's owning operator always has full read/write access to it. This is structural, not a grant that can be revoked or misconfigured.
- The platform is never a vector for executing or distributing malicious active content. v1 achieves this by serving a no-script subset.

### Non-goals for v1 (deferred)

- JavaScript execution in served documents (Phase 2, gated behind a viewer interstitial).
- Documents making network/API calls, including the "LLM-calls-LLM" pattern (deferred indefinitely; revisit only via a server-side mediated proxy, never via direct allowlist).
- Agent groups as share targets (schema leaves room; logic is v2).
- Real-time collaborative editing / live sync.

### One-sentence system summary

> Operators authenticate via Google; agents authenticate via per-agent hashed API keys; agents write HTML that is validated-then-sanitized to a no-script, no-network subset (HTML + CSS + inline SVG); documents are served sandboxed from per-document origins under a separate content domain with `connect-src 'none'`; access is computed at request time by an API that holds the operator-access invariant structurally; sharing is a read-time policy over a polymorphic principal column.

---

## 2. Principals and the Operator-Access Invariant

### Principal types

- **Operator** — a human. Authenticates interactively via Google OAuth. The primary principal; owns agents and documents.
- **Agent** — a machine principal owned by exactly one operator. Authenticates via a per-agent API key. Always acts as a credential scoped to its owning operator; it is never an orphan principal.

Because every agent is scoped to one operator, cross-operator access is never implicit. If Agent A (operated by Alice) wants to read a document owned by Bob, that requires an **explicit share** to A (or to Alice). There is no transitive or ambient cross-operator access.

### The operator-access invariant

> The operator who owns a document always has full read and write access to it.

This is enforced **structurally**, not as a share row:

- Ownership lives in `documents.operator_id`.
- The access function checks ownership **first**, before consulting any share policy or share row.
- There is no share row representing the owner's access, so there is nothing to revoke, misconfigure, or accidentally delete.

An invariant you make unbreakable by making it unrepresentable as anything else.

---

## 3. Data Model

Relational (PostgreSQL). **All access is mediated by the application API. No client — human or agent — talks to the database directly.** This is the single rule that keeps the security model tractable.

### 3.1 Tables

```
operators
  id                  uuid pk
  email               text unique not null
  oauth_subject       text unique not null      -- Google 'sub'
  default_share_policy text not null             -- enum, see 4.2
  status              text not null default 'active'  -- active | suspended (platform enforcement; see 12.3)
                                                 --   suspension is auth-level and blocks the operator AND their agents;
                                                 --   it does NOT delete content (≠ 3.5 deletion) and does not rewrite the invariant
  pending_deletion    timestamptz                 -- null = not deleting. Set when the operator requests account deletion;
                                                 --   account-level REVERSIBLE flag for the §3.5.4 grace window (NOT per-doc
                                                 --   soft-delete fan-out). Fails closed at auth (5.1/5.2) like suspension AND
                                                 --   darkens for non-owner share readers via can_access step 1c (4.1) — so
                                                 --   deletion is perceived as immediate by everyone while bytes persist for
                                                 --   recoverability until terminal purge. Cleared on cancel within the window.
  live_bytes          bigint not null default 0   -- VISIBLE/UX quota counter (§6.6). The operator's live footprint.
                                                 --   +size at create, −size at soft-delete, +size at restore (§3.5.1).
                                                 --   Display-only; NEVER the write-rejection gate. Hold-invisible by
                                                 --   construction: it moves on operator actions, never on platform hold state.
  physical_bytes      bigint not null default 0   -- INVISIBLE/abuse-bound counter (§6.6). Bytes physically resident in R2.
                                                 --   +size at create (per body), −size in the SAME statement that nulls each
                                                 --   *_key at actual object free, guarded `WHERE key IS NOT NULL` (idempotent;
                                                 --   no latch). Held bytes correctly stay counted until released-and-purged.
                                                 --   THIS is the write-time quota gate — the counter create/delete-cycling
                                                 --   cannot game (soft-delete does not free bytes; §3.5.1). Never shown.
  created_at          timestamptz not null default now()

projects
  id                  uuid pk
  operator_id         uuid not null references operators(id)  -- owner (single-owner in V1; Organization principal is a
                                                 --   reserved future seam — project ownership resolves through a function,
                                                 --   §4.2, so org-ownership is later a resolution change, not a migration)
  name                text not null
  slug                text not null              -- for friendly app-domain URLs (see 7.5)
  is_default          boolean not null default false  -- the operator's "unsorted" project (3.3a). Exactly one per operator;
                                                 --   auto-created at operator creation; NOT user-deletable. Every document
                                                 --   lives in a project — null project_id does not exist (see documents).
  deleted_at          timestamptz                 -- soft delete; null = live. The default project cannot be soft-deleted.
  created_at          timestamptz not null default now()
  unique (operator_id, slug) where deleted_at is null   -- slugs freed on soft-delete (D); live-only uniqueness
  -- enforce: exactly one is_default=true per operator (partial unique index, 3.2); is_default project has deleted_at always null

agents
  id                  uuid pk
  operator_id         uuid not null references operators(id)
  name                text not null
  status              text not null default 'active'  -- active | disabled
  created_at          timestamptz not null default now()

agent_keys
  id                  uuid pk
  agent_id            uuid not null references agents(id)
  key_prefix          text not null               -- public, indexed, for lookup
  key_hash            text not null               -- HMAC-SHA-256(secret) under server pepper; see 5.2
  scopes              text[]                       -- forward-compat (§11.10/§14.4); NULL = unscoped (V1 behavior).
                                                   --   Parameter accepted at mint from day 1; NOT enforced in V1.
                                                   --   Future scoping is a grant (populate this), not a migration.
  created_at          timestamptz not null default now()
  revoked_at          timestamptz                 -- null = active

documents
  id                  uuid pk                     -- unguessable random id; the CANONICAL identity (slugs resolve TO this; §7.5)
  operator_id         uuid not null references operators(id)  -- owner
  project_id          uuid not null references projects(id)  -- ALWAYS set: every document lives in a project; an operator's
                                                 --   unsorted docs go in their default project (projects.is_default; 3.3a).
                                                 --   "No project" does not exist — this removes the resolver's null special-case.
  created_by_agent_id uuid references agents(id)  -- nullable (operator-authored possible)
  current_version_id  uuid references document_versions(id)  -- NULLABLE by design, for the circular-FK creation order (3.2a):
                                                 --   documents and document_versions reference each other, so on create the
                                                 --   document is inserted with a null pointer, version 1 is inserted, then the
                                                 --   pointer is updated — all in one transaction. Null only ever transiently,
                                                 --   mid-create; a committed document always has a current version.
  share_policy        text not null               -- enum, see 4.2
  security_tier       text not null default 'static'  -- static | scripted (Phase 2)
  slug                text not null               -- REQUIRED; friendly-URL + doc: resolution identity within the project (7.5/3.7)
  created_at          timestamptz not null default now()
  deleted_at          timestamptz                 -- soft delete; null = live (see 3.5)

document_versions
  id                  uuid pk
  document_id         uuid not null references documents(id)
  version_no          int not null
  sanitized_key       text not null               -- object-storage key for served form (see 3.6)
  original_key        text                         -- object-storage key for as-submitted form;
                                                   --   nullable: pruned for deep history (6.6)
  sanitized_hash      text not null               -- content hash of served form (integrity + dedupe)
  original_hash       text                         -- content hash of as-submitted form
  size_bytes          int not null                -- TOTAL stored size (sanitized_size + original_size); convenience/quota
                                                   --   reporting and version-level size display. Authoritative per-body
                                                   --   sizes for physical_bytes accounting are the two columns below.
  sanitized_size      int not null                -- bytes behind sanitized_key; physical_bytes -= this at the statement
                                                   --   that nulls sanitized_key (§6.6), guarded WHERE sanitized_key IS NOT NULL
  original_size       int                          -- bytes behind original_key (nullable, mirrors original_key);
                                                   --   physical_bytes -= this at the statement that nulls original_key (§6.6)
  content_type        text not null default 'text/html'
  created_by_agent_id uuid references agents(id)
  created_by_operator_id uuid references operators(id)
  model               text                        -- provenance: model that authored
  sanitizer_profile_version  text not null          -- which pinned sanitizer profile (6.3a) produced sanitized_key.
                                                   --   THE column that answers "which stored docs are affected by a newly-
                                                   --   discovered bypass?" (a WHERE clause) and makes re-sanitization (6.6/6.3b)
                                                   --   targetable. Nearly free now; very expensive to backfill — so it lands in
                                                   --   the prototype even though the maintenance apparatus (6.3b) is pre-public.
  held                boolean not null default false  -- denormalized: any active legal_hold covers this version (3.5.3)
                                                   --   the authoritative source is legal_holds; this is a fast-path cache
                                                   --   so the pruning/delete hot paths read a column, not a join
  created_at          timestamptz not null default now()
  unique (document_id, version_no)

shares
  id                  uuid pk
  document_id         uuid not null references documents(id)
  principal_type      text not null               -- operator | agent | agent_group(v2)
  principal_id        uuid                         -- principal this grant is for
  access_level        text not null               -- read | write
  granted_by          uuid not null references operators(id)
  created_at          timestamptz not null default now()
  revoked_at          timestamptz                 -- null = active

public_links                                       -- DEFERRED, NOT CREATED IN V1 (see 4.9); shown for the future build
  id                  uuid pk
  document_id         uuid not null references documents(id)
  token               text not null unique         -- unguessable; the capability in the URL
  created_by          uuid not null references operators(id)
  created_at          timestamptz not null default now()
  expires_at          timestamptz                  -- null = no expiry
  revoked_at          timestamptz                  -- null = active

audit_log                                          -- append-only; see 3.4
  id                  bigint pk                    -- monotonic
  occurred_at         timestamptz not null default now()
  operator_id         uuid                         -- resolved owning operator, if any
  principal_type      text not null               -- operator | agent
  principal_id        uuid not null                -- who acted (operator id or agent id)
  agent_key_id        uuid references agent_keys(id)  -- which key, if an agent acted
  action              text not null                -- read | write | create | delete | restore |
                                                   --   share_grant | share_revoke |
                                                   --   key_mint | key_revoke | access_denied
  target_type         text                         -- document | version | share | key | ...
  target_id           uuid
  source_ip           inet
  outcome             text not null                -- allowed | denied | error
  -- NOTE: never store document content here, only ids/metadata (see 3.4)

write_idempotency                                  -- dedupes write retries; see 4.6
  id                  uuid pk
  agent_id            uuid not null references agents(id)
  idempotency_key     text not null                -- client-supplied token
  request_hash        text not null                -- hash of the write payload
  result_version_id   uuid references document_versions(id)  -- the version this write produced
  created_at          timestamptz not null default now()
  unique (agent_id, idempotency_key)
  -- ROWS ARE EPHEMERAL: swept after 48h (§4.6), indexed on created_at (§3.2). The
  -- unique(agent_id, idempotency_key) dedup guarantee holds only within the TTL window;
  -- a same-key replay after expiry is treated as a new intent and creates a new version.

legal_holds                                        -- platform-level preservation overrides; see 3.5.3
  id                  uuid pk
  document_id         uuid not null references documents(id)  -- always set (the document scope)
  version_id          uuid references document_versions(id)   -- null = hold ALL versions of the document,
                                                   --   including future ones (the document-level convenience hold)
  reason              text not null                -- subpoena | law_enforcement | csam_preservation | litigation | other
  reference           text                         -- matter / report / ticket id (free text)
  placed_by           uuid not null                -- PLATFORM admin id (NOT operators.id; platform staff, separate authz)
  placed_at           timestamptz not null default now()
  released_at         timestamptz                  -- null = active; set on release, re-arms destruction paths
  released_by         uuid                         -- platform admin who released
  -- NOTE: never exposed on any operator- or agent-facing surface (3.5.3). Platform-internal only.

reports                                            -- inbound abuse / CSAM / copyright / NCII / other reports; see 12.1
  id                  uuid pk                       -- opaque
  target_type         text not null                -- document | version | operator | agent  (polymorphic; grows w/o migration)
  target_id           uuid not null                -- the reported entity (no FK: polymorphic, like audit_log)
  reason              text not null                -- csam | copyright | ncii | abuse | other  (app-level enum; growable)
  detail              text                          -- reporter's description; NEVER the reported content itself (content-free, cf. 3.4)
  reporter_type       text not null                -- operator | agent | anonymous  (anonymous reserved for the future public path)
  reporter_id         uuid                          -- null when anonymous; else the principal id
  reporter_contact    text                          -- optional contact (e.g. email); the channel for anonymous / DMCA reporters
  status              text not null default 'open'  -- open | triaged | actioned | dismissed  (lifecycle; growable)
  created_at          timestamptz not null default now()
  resolved_at         timestamptz                  -- null = still open
  resolved_by         uuid                          -- PLATFORM admin who closed it (separate authz, cf. legal_holds.placed_by)
  resolution_note     text                          -- what was decided / done

enforcement_actions                                -- append-only T&S decision record (evidence trail); see 12.4
  id                  bigint pk                     -- monotonic
  occurred_at         timestamptz not null default now()
  action_type         text not null                -- suspend_operator | reinstate_operator | disable_agent | revoke_key |
                                                   --   takedown_document | place_hold | release_hold | dismiss_report  (growable)
  target_type         text not null                -- operator | agent | agent_key | document | version  (polymorphic, no FK)
  target_id           uuid not null
  actor_admin_id      uuid not null                -- PLATFORM admin who acted (NOT operators.id; separate authz)
  reason              text not null                -- short category
  statement_of_reasons text                        -- human-readable justification (DSA statement-of-reasons seam + litigation evidence)
  related_report_id   uuid references reports(id)   -- nullable; the report that prompted this action, if any
  -- append-only; never store reported content; retained as evidence (pseudonymize, do NOT purge, on account deletion — 3.5.2)
```

### 3.2 Constraints and indexes that pin the model

- **Ownership chain**: `agents.operator_id`, `documents.operator_id`, `projects.operator_id`, and `agent_keys.agent_id` foreign keys enforce that every agent, document, and project traces to an operator, and every key to an agent. The invariant's data path cannot be orphaned.
- **Project/document operator consistency**: `documents.project_id` is **always set** (every document lives in a project; the default project backs the unsorted case, 3.3a), and the project's `operator_id` must equal the document's `operator_id`. A document can only belong to a project owned by the same operator. Enforce in the API write path (and optionally a trigger); this keeps the project ACL scope from ever crossing an operator boundary. (The old "project-less document" case is gone — there is no `project_id is null`.)
- **Circular-FK creation order (3.2a)**: `documents.current_version_id → document_versions(id)` and `document_versions.document_id → documents(id)` reference each other, so neither can be inserted first under naive strict FKs. Resolution: `current_version_id` is **nullable** (3.1), and create is a single transaction — insert the document with a null pointer → insert version 1 → `UPDATE documents SET current_version_id = <v1>`. A committed document always has a current version; the null is transient, mid-create only. (Alternatively `SET CONSTRAINTS DEFERRED`, but nullable-then-update is simpler and provider-portable.) The same transaction stamps provenance and increments both storage counters (4.6).
- **Key lookup**: index on `agent_keys(key_prefix)` so verification is one indexed lookup, not a scan-and-hash over the whole table.
- **Active shares**: partial index `shares(document_id, principal_type, principal_id) where revoked_at is null` so the explicit-share check is fast and only sees live grants.
- **Owner access is not a share**: enforced by convention in the access function (owner checked before shares) and by never writing an owner row into `shares`. Optionally add a check or trigger forbidding `shares` rows where `principal_type='operator' and principal_id = documents.operator_id`, as a guardrail.
- **Provenance is mandatory on versions**: every `document_versions` row records who wrote it (agent and/or operator) and which model. Revocation and audit both depend on this.
- **Slug uniqueness — live-only, slugs freed on soft-delete (required by the link resolver, 3.7; the freed-slug model, D)**: `unique (project_id, slug) where deleted_at is null` on `documents`, and `unique (operator_id, slug) where deleted_at is null` on `projects`. A slug is unique among **live** documents in its project (and live projects in their operator), so a `doc:` reference resolves to at most one live target. The `where deleted_at is null` is load-bearing: soft-deleting a document **frees its slug immediately** for reuse — the platform behaves like a web host where a deleted path can be reclaimed (3.7's "internet is full of 404s" stance, extended to "and freed paths get reused"). The collision this creates on **restore** (a soft-deleted doc whose slug was reclaimed while it was gone) is resolved by auto-renaming the *restored* document, never the incumbent (3.5.1a). Because `project_id` is always set, there is **no `project_id is null` special-case** — the prior dual-constraint is gone.
- **Default project — exactly one per operator, undeletable**: partial unique index `projects(operator_id) where is_default` (one default per operator); the default project is auto-created with the operator and its `deleted_at` is always null (enforced in the soft-delete path, 3.5.1, and optionally a trigger forbidding `deleted_at` being set where `is_default`).
- **Active holds**: partial index `legal_holds(document_id, version_id) where released_at is null` so the destruction paths can ask "is anything covering this version still active?" cheaply. The `document_versions.held` boolean (3.1) is a denormalized cache of this query and must be kept consistent with it: placing/releasing a *version-level* hold updates `held` on the covered version(s) in the same transaction. The authoritative answer is always `legal_holds`; `held` exists only so the pruning hot path (6.6) avoids a join. **Document-level holds cover future versions and so cannot eagerly set `held`:** a hold with `version_id IS NULL` (3.1) protects versions that may not exist yet, so the write path performs a **hold check at version creation** (4.6) — before committing a new `document_versions` row it queries this index for an active document-level hold on the parent and, if present, writes the new row with `held = true` in the same transaction. Without this, a version *born under* an existing document-level hold would default to `held = false` and the pruner (6.6) would destroy exactly the bytes the hold exists to preserve. A nightly reconciliation re-derives `held` from `legal_holds` to catch drift, **expanding document-level (`version_id IS NULL`) holds to all of the document's versions, not only version-pinned rows** (fail-safe: if `held` and `legal_holds` ever disagree, treat the version as held). The reconciliation is a drift-catcher, **not** the primary preservation guard — it runs too infrequently relative to a fast-iterating agent to be relied on; the write-time inheritance is the guard.
- **Idempotency sweep**: index `write_idempotency(created_at)` so the 48h cleanup sweep (4.6) is a ranged delete, not a full scan.
- **Active holds**: partial index `legal_holds(document_id, version_id) where released_at is null` so the destruction paths can ask "is anything covering this version still active?" cheaply. The `document_versions.held` boolean (3.1) is a denormalized cache of this query and must be kept consistent with it: placing/releasing a *version-level* hold updates `held` on the covered version(s) in the same transaction. The authoritative answer is always `legal_holds`; `held` exists only so the pruning hot path (6.6) avoids a join. **Document-level holds cover future versions and so cannot eagerly set `held`:** a hold with `version_id IS NULL` (3.1) protects versions that may not exist yet, so the write path performs a **hold check at version creation** (4.6) — before committing a new `document_versions` row it queries this index for an active document-level hold on the parent and, if present, writes the new row with `held = true` in the same transaction. Without this, a version *born under* an existing document-level hold would default to `held = false` and the pruner (6.6) would destroy exactly the bytes the hold exists to preserve. A nightly reconciliation re-derives `held` from `legal_holds` to catch drift, **expanding document-level (`version_id IS NULL`) holds to all of the document's versions, not only version-pinned rows** (fail-safe: if `held` and `legal_holds` ever disagree, treat the version as held). The reconciliation is a drift-catcher, **not** the primary preservation guard — it runs too infrequently relative to a fast-iterating agent to be relied on; the write-time inheritance is the guard.
- **Idempotency sweep**: index `write_idempotency(created_at)` so the 48h cleanup sweep (4.6) is a ranged delete, not a full scan.
- **Reports / enforcement (T&S, Section 12)**: index `reports(target_type, target_id)` ("all reports against X" — the basis for future volume/dedup grouping without a schema change) and a partial index `reports(status) where status = 'open'` (the triage queue). Index `enforcement_actions(target_type, target_id)` ("history of actions against X" — the basis for a future repeat-infringer/strikes count, computed over this log, again with no schema change). `enforcement_actions` is append-only (no `UPDATE`/`DELETE`), like `audit_log`.
- **Operator status**: checked at authentication (5.1/5.2), not materialized elsewhere. A `suspended` operator fails auth, and because every agent key resolves through its owning operator (5.2), a suspended operator's agents fail closed automatically — no per-agent flag to flip (the same read-time-evaluation discipline as 4.3). Index is unnecessary (status is read on the already-indexed operator lookup).

### 3.3 Why versions matter

Agent output is iterative — regenerations, supersessions. Versioning is core schema, not bolted on. Access is checked against the **document**, not the version, so a revocation applies across all versions automatically. The original body (referenced by `original_key`) is retained so the corpus can be re-sanitized if sanitization rules are later hardened — though note this capability holds for the current version and recent history only, since the background pruning job (6.6) drops original bodies for deep history while keeping version metadata.

### 3.3a Addressing model — two flat tiers, the UUID is canonical identity

The system separates **identity** (what uniquely names a document) from **addressing** (how a caller names one). Getting this split right is what keeps slug resolution (3.7), friendly URLs (7.5), the freed-slug model (D, 3.2), and the API shortcut (11.5a) mutually consistent.

- **Canonical identity is the UUID** (`documents.id`), which is also the security identifier (the per-document content origin, 7.1/7.5). Slugs are **addressing sugar that resolve *to* the UUID**; a slug is never identity. This is why a slug can be freed and reused (D) without anything that depends on identity breaking — links resolve fresh every time (3.7), and the durable references (origin, audit rows, holds, shares) are all UUID-keyed.
- **The namespace is two flat tiers: Operator › Project › Document slug.** There is no third tier and **no subfolders.** Nesting was considered and rejected: arbitrary depth turns the flat, one-lookup `unique (project_id, slug)` resolution (3.2/3.7) into a path-walk with cascading renames and per-segment uniqueness, collides badly with the restore-rename model (3.5.1a), and has no corresponding security boundary (the origin is per-document, never per-group, 7.1). Grouping richer than projects, if ever wanted, is **flat tags/labels as a non-identity metadata attribute** — addable later without touching resolution — not a hierarchy.
- **Every document lives in a project; "no project" does not exist.** Each operator has exactly one **default project** (`projects.is_default`), auto-created with the account, into which unsorted documents fall. This is a uniformity decision, not just convenience: it removes the resolver's `project_id is null` special-case (special-cases in a resolver are where bugs breed), so `(project_id, slug)` is the single, uniform resolution key. The default project is **not user-deletable** (3.2); other projects soft-delete like everything else.
- **Operator is never silently inferred at cold (API) resolution.** Inside a document body, the *serve-time* resolver (3.7) can default operator and project because it has the **source document as context** ("same operator, same project" is well-defined). The API shortcut (11.5a) is called **cold** — no source document — so it cannot infer the operator and must receive it explicitly (filled from the *reading agent's* known operator context for the common same-operator case, never guessed from ambient state). Silently inferring the owner is how a resolver confidently resolves to the wrong operator's namespace once cross-operator shares exist.
- **Operator is not baked into durable link strings as a mutable handle.** A `doc:` reference embeds operator identity only when it must (cross-operator), and as a **stable id**, not a human-changeable handle — so renaming an operator does not dead every link that names them. (Same discipline as keeping the UUID, not the slug, as identity.)

**Reserved seam — the Organization principal.** A project is single-operator-owned in V1 (`projects.operator_id`). The known future want is a project ownable across operators (an *Organization* principal, mirroring the `agent_group` / polymorphic-share foresight in 4.4). To keep that a later *resolution* change rather than a schema migration, **project ownership is resolved through a function**, never by hard-coding `projects.operator_id` as the only ownership path in `can_access` (4.2). No org table now; just the seam.

### 3.4 Audit log (core, not deferred)

The audit log is an **append-only** record of access and administrative events: reads, writes, creates, deletes, share grants/revokes, key mint/revoke, and — importantly — **denied** access attempts. It is core schema for two reasons. First, a correct `can_access` does not protect against a *stolen but validly-presented* credential: if an agent key leaks, the attacker's requests look legitimate, and the only way to notice is by recognizing behavioral change (an agent suddenly reading the whole corpus, from a new IP, at an unusual rate). The log is what makes that detectable. Second, the data is unrecoverable if not captured from day one — you cannot reconstruct who-read-what after the fact. (This lesson is concrete: the Feb 2026 Moltbook breach turned on stolen agent credentials being used indistinguishably from normal behavior; post-incident analysis stressed that detection had to come from behavioral observability, not access control alone.)

Design points:

- **Capture enough for anomaly detection**, not just compliance: principal, key used, action, target id, source IP, outcome, timestamp. This supports per-key rate/volume/breadth baselining later.
- **Never store document content in the log** — only ids and metadata. This is the single discipline that keeps the log cheap (a row is low-hundreds of bytes; even heavy agent traffic is gigabytes/year, trivial beside document bodies). The cost only balloons if payloads get snapshotted into log rows; don't.
- **Append-only, partitioned by month**, with a retention/rollover policy (recent partitions hot and queryable, old partitions compressed or aged out per the retention decision in 3.5).
- Logging is done by the API layer (the same sole-data-path that runs `can_access`), so every mediated access has a natural write point.

### 3.5 Deletion and retention

Three distinct lifecycles act on a document's bytes, and they pull in opposite directions: **soft delete** (hide it), **hard delete / erasure** (destroy the bytes), and **legal hold** (forbid destruction). They are layered deliberately so that a single override — the hold — wins over every destruction path.

#### 3.5.1 Soft delete (operator-visible)

Deleting a document sets `deleted_at`; the row and its versions are retained. The owning operator can still see and restore soft-deleted documents (consistent with the operator-access invariant and the audit use case); other principals cannot — `can_access` treats a soft-deleted document as inaccessible to everyone except the owner (4.1, step 1b). Internal links to a soft-deleted target render as disabled/marked (the dangling-reference handling in 6.5). Soft delete destroys nothing; it is a visibility change. **Quota effect:** soft-delete decrements the operator-visible `live_bytes` (6.6) by the document's body sizes, and restore re-increments it; it does **not** touch `physical_bytes`, because no bytes are freed — that counter moves only on actual object purge (3.5.2). **Slug effect:** soft-delete **frees the document's slug immediately** (the partial unique constraint is `where deleted_at is null`, 3.2), so the slug can be reused right away — web-host behavior, where a deleted path is reclaimable. The same applies to soft-deleting a (non-default) project, which frees the project slug. The default project cannot be soft-deleted (3.2).

#### 3.5.1a Restore and slug collisions (the freed-slug consequence)

Freeing slugs on soft-delete (D) creates one case to resolve: an operator soft-deletes `north-island-listings`, its slug frees, a *new* document is created reusing `north-island-listings`, and then the operator **restores** the original. Two live documents now want the same `(project_id, slug)`, which the live-only unique constraint (3.2) forbids — so **restore is the operation that resolves the clash**, by auto-renaming:

- **The restored document is renamed, never the incumbent.** The incumbent is live and may already be linked-to (by `doc:` references) and bookmarked at its app-domain URL (7.5); silently renaming a live document out from under existing references would dead them. The restored document is the one re-entering the world, so it absorbs the collision. Its slug is suffixed — `north-island-listings-restored`, then `-restored-2`, etc. if that also collides — and only the **slug** changes; the body, versions, and outbound links are untouched.
- **The restored document's *inbound* `doc:` links stay dead.** They were already inert during the soft-deleted period (3.7) and remain inert after a rename, because the slug changed — the accepted "rename deads links" tradeoff (3.7), not a new wart.
- **The rename is surfaced to the operator, not silent.** Because the slug is part of the shareable URL (7.5) — a user-visible contract in a way a filename in a folder is not — restore returns the document with its possibly-new slug and an explicit note ("restored as `north-island-listings-restored`; the original name was in use"). This is the one place the platform behaves *unlike* a silent file-manager auto-rename, deliberately.
- **No collision ⇒ no rename.** If the original slug is still free at restore time (the common case), the document restores under its original slug unchanged.

#### 3.5.2 Hard delete and right-to-erasure

Soft delete is **not** erasure. A GDPR Art. 17 / CCPA deletion request requires the bytes themselves to go, so there is a separate **hard-delete path** (an operator action on the private API, and the terminal stage of account-wide deletion) that purges the R2 objects — **both `sanitized_key` and `original_key`** — for the affected versions, not merely sets `deleted_at`. Each object freed decrements `operators.physical_bytes` (6.6) in the statement that nulls its key, guarded `WHERE key IS NOT NULL` — the same one-time, idempotent path the pruner uses, so erasure and pruning share the accounting and neither can double-credit. The content-free audit row (3.4) survives the purge: it records *that* a document existed and was deleted, never its content, so honoring erasure on the body does not destroy the proof-of-lifecycle. This is why 3.4 forbids content in the log — it is what lets erasure and forensic retention coexist. (This resolves the §10 open item: on erasure and account deletion, **purge the bodies, retain-and-pseudonymize the audit rows.** Personal identifiers in audit rows — `source_ip`, and the link from `principal_id` to a now-deleted operator — are dissociated/pseudonymized; the behavioral skeleton is kept.)

#### 3.5.3 Legal hold (overrides all destruction)

A **legal hold** is a platform-level flag that makes one or more document versions **undeletable and unprunable** until the hold is released. It is the mechanism for the obligations the platform itself carries as a service provider — preserving content under subpoena/law-enforcement request, and the mandatory-preservation duty that attaches to reported CSAM (see note below). Properties, each load-bearing:

- **Placed at the version level**, because a hold protects *bytes*, and bytes live on versions (`sanitized_key` / `original_key`). A document-level convenience hold (hold-all-versions, including future ones) is derived from this, not a separate concept.
- **Pins the original, not just the served form.** A held version's `original_key` is exempt from the pruning job (6.6) that would otherwise drop deep-history originals. Preservation duties want the as-submitted bytes; the one job that destroys them must check the hold first (6.6).
- **Platform-operator-only, and invisible to the owning operator.** Placing and releasing a hold is a privileged platform-admin action, never an owning-operator capability. The owning operator can be the adverse party in the matter, or the source of the harmful content; a hold placed for a law-enforcement matter frequently carries a **tipping-off / non-disclosure** concern. So a hold is not surfaced to the owning operator at all — not in metadata, not as a failed-delete error. An owning-operator delete of a held document behaves like a normal soft delete from their view (sets `deleted_at`, the document disappears for them) while the bytes are retained underneath; the operator is not told the bytes survived. **The hold is never represented in any agent- or operator-facing surface.** Note this invisibility is *also* why quota accounting uses two counters (6.6): the operator-visible `live_bytes` is credited at *their* soft-delete action and never reflects whether bytes physically survive under a hold, so a held document does not silently consume the operator's visible quota and thereby disclose its own retention. The physical-byte bound that does see held bytes (`physical_bytes`) is platform-internal and never shown.
- **Documented basis and explicit release.** A hold is a *suspension* of the deletion clock, not a black hole. Every hold carries a `reason` (enum: `subpoena` | `law_enforcement` | `csam_preservation` | `litigation` | `other`), a free-text `reference` (matter/report id), `placed_by`, `placed_at`, and a nullable `released_at` + `released_by`. An indefinite, undocumented hold is itself a data-minimization (GDPR) violation, so the release path is part of the design, not an afterthought. Holds should be reviewed on a cadence; a hold whose underlying matter has closed must be released so the normal lifecycle (including any pending erasure) can resume.
- **Wins over every destruction path.** Hard delete, account-wide purge, and the pruning job all check for an active hold and skip held versions. A held version cannot be destroyed by any routine or operator-initiated path; only hold release re-arms those paths. (See the guard in 6.6 and the deletion-path note in 11.6.)

> **Mandatory CSAM preservation — handled, but not described in operational detail here.** Where the platform obtains actual knowledge of apparent CSAM, federal law (18 U.S.C. § 2258A, as amended by the 2024 REPORT Act) imposes a **report-to-NCMEC** duty and a **separate preservation** duty (currently ≥1 year for the report and commingled materials); filing the report does **not** by itself satisfy preservation. The `csam_preservation` hold reason is the preservation half of that obligation — it pins the bytes against pruning and delete for the mandated window. The detection, reporting workflow, NCMEC interface, and access-restriction handling for this content are a **separate, access-restricted runbook**, not part of this hosting spec, and must be designed with counsel. This spec commits only to the structural guarantee: *a `csam_preservation` hold makes the relevant bytes survive every deletion and pruning path.*

#### 3.5.4 Account-wide deletion

An operator can delete their account, which removes their documents, agents, keys, projects, and shares. Sequence: a **reversible account-level soft phase** (set `operators.pending_deletion`, 3.1) with a grace window, then terminal hard-delete (3.5.2) of the bodies after the window. Two design points make this behave correctly:

- **Account-level flag, not a per-document soft-delete fan-out.** Deletion sets one flag on the operator; it does **not** walk every document setting `deleted_at`, and so does **not** fan out per-document `live_bytes` decrements (3.5.1). Cancel within the window is a single flag-clear with no counter reconciliation; if deletion had decremented `live_bytes` per document, cancel would have to mirror-re-increment all of it. The account flag avoids that entirely.
- **Perceived deletion is immediate; physical erasure is deferred — two clocks.** The instant `pending_deletion` is set, the account goes dark for *everyone*: the owner and their agents fail closed at auth (5.1/5.2), and **non-owner share readers fail closed in `can_access` step 1c (4.1)** — so a collaborator with a live `explicit` share cannot keep reading a document whose owner just deleted their account. This is the product requirement: account deletion must *feel* immediate, not "still readable by my collaborators for 30 days." Underneath, the bytes physically persist through the grace window for recoverability and are erased only at terminal purge. `physical_bytes` (3.1) stays elevated through the window (the bytes are still in R2) and zeroes at terminal purge via the §3.5.2 key-null path; since the operator row itself is removed at terminal purge, the counters vanish with it.

**Held versions (3.5.3) are carved out of the terminal purge** and survive account deletion — the platform's preservation duty does not evaporate because the account holder left. Audit rows are retained-and-pseudonymized per 3.5.2.

#### 3.5.5 Two-clocks model

A version is simultaneously subject to a **maximum-retention** pressure (erasure / minimization: destroy when no longer necessary) and, when held, a **minimum-retention** floor (the hold: do not destroy until released). The hold always wins while active; when released, the maximum-retention pressure resumes and any deletion deferred by the hold (e.g. a pending erasure request) is then executed. Document the basis at hold time (3.5.3) so the floor is always justifiable to a regulator.

> **Not legal advice; get counsel before launch.** Retention minimums, erasure timelines, and the CSAM runbook are legal questions with shifting answers (the AI-authored-content / Section 230 area is moving month to month as of early 2026). This section gives a sound *structure*; a privacy/platform-liability attorney must set the actual durations and sign off on the CSAM workflow before public launch.

### 3.6 Document bodies live in object storage, not the database

Document bodies (the sanitized served form and the as-submitted original) are **objects in an S3-compatible bucket**, not `text` columns in Postgres. The database holds only metadata plus a `*_key` pointer to each object. This is a deliberate split, for three reasons:

- **Right resource.** Postgres storage is the scarce, expensive tier on every managed provider (e.g. single-digit GB included); object storage is one to two orders of magnitude larger and cheaper. HTML/SVG documents are files and belong in the file store. Putting bodies in `text` columns would burn the database's small storage allotment and bloat every backup.
- **Keeps the database fast.** `can_access`, the audit log, and the write path all hit Postgres on every request. The database should be doing fast metadata and ACL work, not hauling hundred-KB blobs in and out. Bodies in object storage keep row sizes tiny and queries cheap, which matters because compute (not storage) is the likely database wall.
- **Right serving path.** The per-document content origins (7.1) are served from the bucket through a thin **edge Worker** (11.4) that reads R2 via its bucket binding and stamps the §7.3 serving headers — rather than round-tripping document bytes through the application and database on every read. The Worker is in-network with R2, so this keeps the no-app-round-trip property *and* zero egress (the Worker exists to attach CSP/headers a raw bucket URL cannot carry, not to proxy bytes over a metered path; 11.4).

**Recommended store: Cloudflare R2.** The workload is read-heavy and egress-dominated — the platform's whole job is serving documents to people and agents, so bytes leave the bucket far more than they sit. R2 charges **zero egress** (vs. ~$0.09–0.12/GB on S3 / Google Cloud Storage / Firebase), which on a read-heavy corpus is not a marginal saving but a different cost structure: at, say, 2 TB/month of document reads, egress alone would run ~$180–240/month on S3/GCS/Firebase versus $0 on R2. R2's storage rate (~$0.015/GB-month) is modestly higher than cold-archival options (Backblaze B2 at ~$0.005), but that premium only matters for data that mostly sits untouched; a hot, actively-served corpus is exactly the regime R2 is built for.

The architectural clincher: the serving design already wants **Cloudflare in front** for wildcard DNS/TLS on the content domain, the WAF/DDoS edge protections (pre-launch TODO, 4.7), and request routing. R2 lives natively in that same stack and integrates with Cloudflare Workers for edge auth and routing, so storage, CDN, edge-auth, and the planned WAF collapse into one provider — and per-document origins serve straight from R2 through Workers with no egress charge per read. Storage choice is independent of the Postgres/auth choice (Supabase or Neon for metadata is unchanged); R2 is selected purely as the body store.

*Keep in back pocket:* Backblaze B2 + Cloudflare (free egress via the Bandwidth Alliance, lowest storage rate) is the better fit only if the corpus ever turns large and cold. Firebase/GCS is ruled out for this component — highest egress rate for a read-heavy pattern, and as of Feb 2026 its Cloud Storage requires the paid Blaze plan anyway, so it offers neither price nor free-tier advantage here.

### 3.7 Internal-link resolver (resolve-by-slug, every time)

Internal `doc:` links (6.5) are resolved at **serve time, by slug, on every render** — there is no link-graph table, no binding step, and no stored edges. This is a deliberate minimalism: the web has always tolerated dead links, and it is not the platform's job to make cross-references robust against rename or deletion. The simpler model also gets forward references and recursion for free, because there is no state to maintain.

**Reference grammar** (as authored by the agent, embedded directly — no resolution API, 11.7):

- `doc:<doc-slug>` — resolve within the **authoring document's project** (project-relative; the common case). A document in the default project (3.3a) resolves here just like any other — the default project is an ordinary project for resolution purposes.
- `doc:<project-slug>/<doc-slug>` — resolve in another project of the same operator (cross-project).
- `doc:id:<uuid>` — explicit by-id reference, when the agent knows the exact target.
- *(Cross-operator references — naming another operator's document — would carry the owning operator as a **stable id**, not a mutable handle, 3.3a. This is the `explicit`-share exception, not a V1 primary path; the cross-operator grammar form is deferred until cross-operator authoring is a real use case. In V1, cross-operator access is reached by the reader following a link the platform renders, with `can_access` evaluated at navigation, 6.5 — not by an agent hand-authoring cross-operator `doc:` refs.)*

**Resolution lifecycle** (entirely at serve time, when rendering the source document):

1. Parse each `doc:` reference into (project scope, doc slug) or (id).
2. Look it up: a slug reference resolves against `unique (project_id, slug)` (3.2) within the resolved project scope — at most one row by construction. An id reference looks up directly.
3. **Verdict per link:**
   - *Found and live* → render as a live link to the target's app-domain displayed URL with `target="_top"`; `can_access` is re-checked for the *viewer* at navigation time (4.8). Resolution finds the target; it does not authorize it.
   - *Not found, or target soft-deleted (3.5)* → render **disabled/marked** (the dangling treatment in 6.5). No error, no 404 page — the link simply renders inert.

**Properties that fall out of this:**

- **Forward references work** — a reference to a not-yet-uploaded document resolves to nothing today and resolves live tomorrow, because every render is a fresh lookup. No late-binding machinery needed.
- **Recursion is a non-issue** — there is no resolution graph to traverse; each link is an independent lookup.
- **Rename/delete break links, by design** — renaming a target's slug deads inbound `doc:` references; this is the accepted "internet is full of 404s" tradeoff. Deletion renders inbound links inert; they relight if the document is restored **under its original slug** (the lookup is fresh each time) — but a restore forced to auto-rename on a slug collision (3.5.1a) leaves them dead, since the slug they name no longer resolves. Restore-without-collision relights; restore-with-rename does not.

**Two correctness rules to state explicitly:**

- **Resolution is existence, not authorization.** A `doc:` reference resolves by *whether a document with that slug exists in the referenceable scope*, and must not be gated on whether the *authoring* agent can read the target — gating it there would both leak existence and violate the "a link is a reference, not a grant" principle (6.5). The can-the-viewer-follow-it question is deferred to navigation time, evaluated for the viewer (4.8).
- **Backlinks are out of scope in v1** (11.5). "What links here" cannot be answered without a maintained index, which this model omits by choice. It is addable later as a slug-keyed index without migration if ever wanted.

---

## 4. Access Control

### 4.1 The access function

This lives in the API and is the **only** path to a document. Top-down; first match wins.

```
can_access(principal, document, level):
  1. if principal is operator AND document.operator_id == principal.id:
        return true                          # the invariant, checked first
                                             # (owner sees soft-deleted docs too)

  1b. if document.deleted_at is not null:
        return false                         # soft-deleted: invisible to all non-owners

  1c. if owning_operator(document).status == 'suspended'
         OR owning_operator(document).pending_deletion:
        return false                         # owner account darkened: fail closed for EVERYONE.
                                             # Reached only by NON-owner principals — the owner and
                                             # their agents already fail at auth (5.1/5.2). This gate
                                             # is what darkens a non-owner SHARE reader the instant the
                                             # owner is suspended/deleting, which auth-layer failure of
                                             # the *owner* cannot do (the reader authenticates as itself).

  2. if document.share_policy == operator_only:
        return false                         # agents shut out even if one wrote it

  3. if principal is agent:
        owner_match = (principal.operator_id == document.operator_id)
        switch document.share_policy:
          writing_agent_only:
              return owner_match AND principal.id == document.created_by_agent_id
          all_operator_agents:
              return owner_match             # includes future agents — see 4.3
          all_project_agents:
              return owner_match
                     AND document.project_id is not null
                     AND principal is assigned to document.project_id  # see 4.2, 4.3
          explicit:
              return active_share_exists(document, agent=principal, level)

  4. if principal is operator (non-owner):
        return active_share_exists(document, operator=principal, level)

  5. return false
```

Key properties: the owner shortcut fires before everything (so the owner can still see soft-deleted documents, which is why the `deleted_at` gate sits *after* it); an agent's identity always carries its `operator_id`, so cross-operator agent access requires the `explicit` branch; only the `explicit` branch touches the `shares` table — every other decision is computed.

**Step 1c — owner account state is a fail-closed gate, and suspension/pending-deletion are its two darkening values.** This sits after the owner shortcut on purpose: it only ever fires for *non-owner* principals, because a suspended or deleting operator (and their agents) already fail at the auth layer (5.1/5.2) and never reach `can_access` as the owner. What auth-layer failure of the *owner* cannot do is stop a **non-owner with a live `explicit` share** (4.2) — that reader authenticates as themselves against a still-live share row, so without 1c they would keep reading a suspended or mid-deletion operator's document. 1c closes that for **both** states at once:

- **Pending-deletion:** makes account deletion feel *immediate to everyone* (the product requirement), while bytes are physically retained through the reversible grace window (3.5.4) and erased only at terminal purge. Perceived deletion and physical erasure are deliberately two clocks.
- **Suspension:** closes the same latent hole for suspension (12.3) — previously suspension relied only on owner auth-layer failure, so a share to a suspended operator's document would still resolve. Now it darkens for shared readers too.

The lookup is one indexed read on the owning `operators` row, which `can_access` is already positioned to make (3.2 notes operator status is read on the already-indexed operator lookup); the document row it loads already carries `operator_id`.

> **Required test vector (both the old and a naive new implementation get this wrong silently):** a *non-owner principal holding a live `explicit` share* to a document whose owning operator is `suspended` **or** has `pending_deletion` set → **denied**. This is the case auth-layer checks alone miss, because the reader authenticates as themselves; it must be covered by an explicit test against `can_access`, not just against the auth path.

### 4.2 Share policy enum

Per-document, defaulting from the operator's account-level `default_share_policy`:

- `writing_agent_only` — only the agent that authored the document (within the owning operator). Tightest agent-readable default; good for sensitive output.
- `all_operator_agents` — any agent owned by the document's operator.
- `all_project_agents` — any agent assigned to the document's project. A narrower, better-scoped grant than `all_operator_agents`: it maps onto real working groupings (e.g. a research-beat project vs a publishing project), so an operator can let the agents on one pipeline share freely without exposing the corpus to every agent they own. Requires the document to have a `project_id` and an agent-to-project assignment (see below).
- `operator_only` — no agent may read it back, even the one that wrote it. A human-private document.
- `explicit` — access governed entirely by rows in `shares` (this is what enables cross-operator sharing to specific people or agents).

**Agent-to-project assignment.** `all_project_agents` needs a notion of which agents belong to a project. Model this as a join table `project_agents(project_id, agent_id)`, with both foreign keys constrained to the same operator. Like `all_operator_agents`, the check is evaluated at read time against current membership (see 4.3), so adding an agent to a project immediately grants it access to that project's `all_project_agents` documents — current and future.

The owner always has access regardless of policy (the invariant; policy never applies to the owner).

### 4.3 Policy is evaluated at read time, never snapshotted

`all_operator_agents` must mean *all current and future agents of this operator*. It is therefore a **policy evaluated at request time** (does this agent's `operator_id` match the document's?), not an ACL snapshot materialized into `shares` rows at creation. Snapshotting would create a footgun where every newly created agent silently cannot read the corpus its siblings built. Do not materialize agent lists into shares. The same applies to `all_project_agents`: it is evaluated against current `project_agents` membership at read time, so assigning an agent to a project grants it the project's documents immediately, including ones created before the assignment.

### 4.4 Polymorphic share target

`shares.principal_type` + `principal_id` is intentionally polymorphic so the principal set can grow from a flat list (operators, agents) to groups (`agent_group`) **without a migration**. Retrofitting groups onto a flat ACL is a painful migration; leaving the column polymorphic now avoids it. (Public/unlisted *link* sharing would not be modeled here anyway — it is capability-based rather than principal-based, so it lives in its own `public_links` table — but that feature is **deferred, not in V1**; see 4.9.)

### 4.5 Defense in depth — RLS (recommended before public launch)

Postgres Row-Level Security can mirror `can_access` as a backstop so an API-layer bug cannot leak data. This is **not required for the v1 prototype** — the API-mediated model is the primary control and is sound — but it should be **pulled forward to before any public launch**, not left as an indefinite "someday" item. The reason is concrete: the Feb 2026 Moltbook breach (a structurally similar agent platform) had as its root cause a database with public read access and **no RLS**, which turned one misconfiguration into the exposure of ~1.5M agent credentials. RLS is precisely the layer whose absence converts a single mistake into a total breach. Keep the database dumb and the API smart during prototyping; enable and explicitly define RLS per-table as the second wall before opening to the public. (If built on Supabase's Postgres, its RLS is the natural home for this.)

### 4.6 Write path — idempotency and concurrency

Because the principals are agents, the human-app assumption that writes are slow and serial does not hold: agents retry, and multiple agents (or runs) can target one document. Two **distinct, complementary** mechanisms are required.

- **Idempotency (dedupe identical retries).** Each write carries a client-supplied `idempotency_key`. If the same `(agent_id, idempotency_key)` is seen again, the server returns the *original* result (the same `result_version_id`) instead of creating a second version. This covers the case where the agent's write succeeded but the response was lost, so it retries the *same intent*. The `request_hash` lets the server detect a key reused with a *different* payload (a client bug) and reject it rather than silently returning a mismatched result.
- **Optimistic concurrency (catch conflicting intents).** Each write names the `base_version` it was composed against (the version the agent last read). If the document has advanced past that version, the write is rejected with **`412 Precondition Failed`** (carried over HTTP `If-Match`/`ETag`; the `409`-equivalent conflict, see 11.3). The agent should then **re-read** the current version, reconcile its change, and **write again** (with a *new* idempotency key — the trap below).

**These are not the same mechanism, and conflating them causes a silent-data-loss bug.** Idempotency answers "is this the same write I already did?"; concurrency answers "is the document still in the state I based this on?". The trap: a conflict-rejected agent that re-reads and rewrites **must use a NEW idempotency key** for the new attempt. If it reuses the original key, the idempotency layer will recognize it and return the *original* cached result — silently discarding the new, reconciled write. State this rule in the agent-facing API docs explicitly: **new write attempt ⇒ new idempotency key; retry of the exact same attempt ⇒ same key.**

Three things also happen inside the write transaction, each load-bearing:

- **Hold inheritance (preservation correctness).** After validation/sanitization and before commit, check the active-holds index (3.2) for a document-level hold (`version_id IS NULL`, `released_at IS NULL`) on the target document. If present, write the new version row with `held = true` in the same transaction. This is the one place a newly created version can be born already-held; it closes the gap between "a document-level hold covers all future versions" (3.1/3.5.3) and the denormalized `held` cache the pruner trusts (6.6). Skipping it would let an agent iterating under an active hold create versions the pruner then destroys — defeating a CSAM/subpoena preservation guarantee silently.
- **Quota accounting (both counters, synchronous).** On a successful create/new-version, increment **both** `operators.live_bytes` and `operators.physical_bytes` by the new bodies' size, in the same transaction (6.6). Synchronous, not async: an async counter lets a runaway agent outrun the increment and defeat the bound. The write-time quota gate tests **`physical_bytes`** (the abuse bound), never `live_bytes` (display only) — see 6.6.
- **Idempotency rows are ephemeral.** The `write_idempotency` row is retry-dedup state, not a durable ledger; a scheduled sweep deletes rows older than **48 hours** (indexed on `created_at`, 3.2). The dedup guarantee holds only within that window — a same-`(agent_id, idempotency_key)` replay arriving >48h after the original is treated as a new intent and creates a new version. Correct: a retry that far out is overwhelmingly a new intent, and unbounded retention would grow the table without bound for no benefit. (One interaction worth knowing: idempotency is a *dedup window*, not a guarantee that identical input yields identical sanitized output over time — if the sanitizer profile (6.3a) tightens between the original write and a >48h replay, the "same" payload may now normalize differently or be rejected. This is correct behavior, not a bug; the dedup window deliberately does not span config changes.)

### 4.7 Rate limiting and abuse bounds

Per-agent keys give a natural place to attach limits. The spec requires (enforced at the API layer, alongside `can_access`):

- **Per-key write rate and document-creation caps** — a compromised or runaway agent must not be able to fill storage or hammer the write path unbounded.
- **Per-operator storage quota** (see 6.6) — checked at write time; the write that would exceed it is rejected with a clear error.
- The audit log (3.4) feeds anomaly detection on top of hard limits: per-key baselining of rate, volume, and breadth, so a key behaving unlike its norm (the stolen-credential case) can be flagged even while within static limits.
- **TODO (pre-launch):** investigate edge protections (Cloudflare or equivalent) — WAF, DDoS mitigation, and a network-level rate-limit backstop in front of the API — before public launch. Application-level limits and edge protections are complementary layers, not substitutes.

### 4.8 Authorization is resolved at request time, never cached or client-trusted

`can_access` runs **server-side on every fetch and every navigation**, and its result is **never cached into rendered output or trusted from the client**. This prevents a Time-of-Check-to-Time-of-Use (TOCTOU) gap: if authorization were evaluated once at render and baked into the page (e.g. a pre-authorized internal link), a share revoked while the document sits open would still be honored on a later click. Because internal links route through the app domain (6.5), the navigation itself re-runs `can_access` for the current viewer at the moment of the click — not at the moment the link was rendered. The same rule applies to direct document fetches.

**Achievable guarantee, stated precisely (don't over-promise):** server-side-at-request-time guarantees the *next* fetch or navigation re-checks against current policy. It does **not** retroactively claw back a document *already delivered* to a browser — static HTML bytes in the user's hands cannot be un-sent, so revocation is not instantaneous for an already-open document; it takes effect on the next request. This is the correct and achievable property; implementers should not imply revocation kills open sessions instantly. (RLS as defense-in-depth, 4.5, reinforces this by making the database itself re-evaluate on every query.)

### 4.9 Public link sharing (DESIRED, but DEFERRED — not in V1)

**Status: deferred.** Public "anyone with the link, no sign-in" sharing is a desired feature but is **explicitly out of V1**. The design is retained below so it is not lost or re-litigated, but the builder **does not implement it for the prototype**: no `public_links` table is created, `can_access` has no public-token branch, and there is only one body-serving path (signed-URL, see 11.4). When built later, this is the design.

**Why deferred (the reasoning).** A public link is the one feature that converts this platform from *private collaboration infrastructure* into a *public publishing platform reachable by the open internet* — and that crossing is what triggers the bulk of the trust-and-safety and intermediary-liability obligations catalogued in 10.1: DMCA notice-and-takedown with a registered agent, the NCII removal SLA, DSA notice-and-action and statement-of-reasons (for EU readers), and the realistic surface on which third parties discover and report illegal content. A one-person prototype does not have the moderation capacity or the legal infrastructure those obligations require. The safe sequence is to prove the concept on private, principal-gated sharing first, then build out public hosting with proper backing if the concept is viable. (This is the same "defer features with outsized obligations" discipline applied to JS and network calls.)

**What V1 still supports — most person-to-person sharing does not need this feature.** Sharing a document with a *specific known person* is the `explicit` share policy (4.2): grant a named operator read access, they sign in (Google OAuth), they see exactly that document. That is the principal-gated, "share to alice@example.com" model — it is in V1 and is safe, because every reader is an authenticated, known principal, not an anonymous holder of a URL. What is deferred is specifically the *no-principal, no-sign-in, anyone-with-the-URL* mode. The friction deferral imposes is only that a recipient must sign in; the exposure it removes is the entire open-internet surface above.

<details>
<summary><em>Design retained for the future build — NOT implemented in V1</em></summary>


- **Capability-based, not identity-based.** Possession of the token *is* the authorization — only "is this token valid, unrevoked, unexpired, for this document." The standard "anyone with the link" model.
- **Operator-created only.** An agent cannot mint a public link (a disclosure decision, an operator action on the private app API). The owning operator always retains the invariant access regardless.
- **Independently revocable and optionally expiring.** `revoked_at` / `expires_at` turn a link off or time-box it without affecting other shares.
- **The caching payoff.** A public link carries no per-viewer access decision, so the body can serve from a **cacheable Cloudflare CDN path** — no per-request signed URL, no `can_access` on the hot path — making a widely-read public document cheap to serve. This is the *second* body-serving path that V1 deliberately does without (V1 has only the signed-URL path, 11.4); it lights up with this feature.
- **Revocation vs. cache.** Edge-cached public bodies mean revoking a link must also purge the CDN entry (or use a short edge TTL), and — per 10.1.D — a *moderation takedown* must trigger the same purge, not just an operator's manual revoke.
- **`can_access` integration.** A public-token read resolves *before* the principal logic: a valid token yields read irrespective of `share_policy`. It never grants write, never reveals other documents, and never overrides soft-delete (the `deleted_at` gate still applies).

</details>

---

## 5. Authentication

Two paths, deliberately bifurcated.

### 5.1 Operators (human) — Google OAuth

Standard Google Sign-In (Auth.js / Lucia or equivalent). The OAuth `sub` maps to `operators.oauth_subject`. A verified session resolves the request to an operator principal. **A `suspended` operator (3.1 / 12.3) fails closed here** — the session does not resolve to a usable principal, so a platform suspension blocks the account at the door without touching `can_access` or the operator-access invariant (the invariant is preserved; the suspended principal simply cannot authenticate to exercise it, and reinstatement restores access intact). **An operator with `pending_deletion` set (3.1 / 3.5.4) likewise fails closed here** — same posture as suspension, so account deletion is felt immediately by the owner; clearing the flag (cancel within the grace window) restores access intact, exactly like reinstatement.

### 5.2 Agents (machine) — per-agent API keys

Firebase Auth (or any interactive-human auth provider) does **not** fit machine credentials cleanly, so the agent side is built directly:

- **Minting**: generate a key as `prefix.secret`, where `secret` is **high-entropy CSPRNG output (≥32 bytes)**. The `prefix` is public and stored in plaintext (indexed). Only a hash of the `secret` is stored.
- **Hash with a fast hash, NOT a password hash.** Use SHA-256, or preferably **HMAC-SHA-256 with a server-side secret pepper**. Do **not** use Argon2id/bcrypt/scrypt here. Reasoning: slow password hashes exist to make brute-force of *low-entropy human passwords* expensive. A ≥32-byte random secret has ~256 bits of entropy and is not brute-forceable, so a slow hash buys no security — while creating an **asymmetric DoS**: an attacker sends a valid-looking `prefix` with a garbage secret and forces the server into an expensive memory-hard computation on *every* request, on the hot auth path. A fast hash removes that amplification. (This corrects an earlier draft that specified Argon2id.)
- **Verification**: split the presented key, look up the row by `prefix` (one indexed query), hash the presented `secret` the same way, and compare to `key_hash` using a **constant-time comparison** (avoid a timing side-channel). A non-null `revoked_at` **fails closed**.
- **Why the pepper**: with HMAC-SHA-256 under a server-held secret, a database leak *alone* (without the application secret) does not even permit offline verification of stolen hashes. Cheap insurance; keep the pepper out of the database.
- **Resolution**: a valid key resolves to an agent, which carries its `operator_id` — everything `can_access` needs. **The owning operator's state is checked here too: if the operator is `suspended` (12.3) or has `pending_deletion` set (3.5.4), the key fails closed** even if `revoked_at` is null. This is why operator suspension and account deletion need no per-agent flag — the owning-operator check at key resolution disables the whole fleet at once (3.2), and (for deletion) makes the owner's agents go dark the instant the flag is set.
- **Per-agent granularity** (one key per agent, not one per operator) gives per-agent revocation, per-agent audit trails, and per-agent siloing for free. Revoke one agent without affecting the others; provenance is "which key wrote this." Note "one key per agent" is the *identity* granularity, not a cardinality cap: an agent may hold **multiple active keys at once** (the `agent_keys` table is many-per-agent, no unique constraint), which is what makes zero-downtime rotation possible (14.4).

### 5.3 Key format, secret-scanning, and the handoff rule

The `prefix.secret` shape (5.2) matches the dominant industry format (Stripe `sk_live_…`, OpenAI `sk-proj-…`, Confluent `cflt…`): a recognizable public prefix plus high-entropy secret, the secret shown **once at mint and never retrievable after** (only its hash is stored). Three properties beyond 5.2, each cheap-now / painful-later:

- **The prefix is for secret-scanning, not only lookup.** Use a recognizable, registrable prefix (e.g. `akh_live_` / `akh_test_`). Beyond the indexed-lookup role (3.2), a distinctive prefix lets the platform **register with GitHub/GitLab secret-scanning partner programs**: a leaked key committed to a public repo is matched and forwarded to a webhook, so the platform can notify the operator and/or auto-revoke — typically within minutes, which matters because exposure-to-exploitation of a leaked key is a minutes-scale event. It also aids support triage ("how does your key start?") and lets an agent's own tooling distinguish this platform's key from the other provider keys it holds. Registering the prefix later is a process step, **no schema change** — but choosing a recognizable prefix now is what makes it possible.
- **The key lives in the transport layer, never in the prompt layer.** This is the load-bearing rule for the agent-as-skill/MCP case (14.5). The key is a credential the agent's *execution environment* (MCP server, connector config, or process env) holds and attaches to requests out-of-band — it must **never** be placed in a skill's instructions, a system prompt, a tool description, or anywhere the model reads as text. A secret in the prompt layer is the LLM-equivalent of a hardcoded-and-committed secret: it can surface in logs, transcripts, or the model's own output. The model invokes a tool that uses the credential; the model never sees it. (This is exactly the MCP-connector pattern — a connected app's key is held by the connection, never shown to the model.)
- **Endpoints never re-expose the secret.** The mint response (14.4) is the *only* time the full secret crosses the wire. Every other key endpoint returns **prefix + metadata only** — never the secret, never the hash. (Show-once, then mask; the private-app UI masks-with-reveal, but the API simply has nothing to re-reveal.)

---

## 6. Content Contract and Sanitization

### 6.1 The content contract (first-class concept)

The no-script limitation is a **contract the platform advertises to writing agents**, not a silent degradation. An agent told the supported subset up front produces artifacts that target it deliberately, instead of emitting (e.g.) a React widget that gets silently gutted.

Publish the contract as both human docs and a **machine-readable capability profile** an agent can fetch:

- Allowed: structural and presentational HTML, all CSS (with one caveat: CSS can create UI-redress overlays, a named residual risk accepted for v1 and revisited pre-public — see 6.7), **inline SVG restricted to an explicit allowlist** (the diagram/chart subset — see 6.3, *not* "SVG minus the bad parts"), and hyperlinks (`<a>`) per the link policy in 6.5.
- Disallowed: `<script>`, all `on*` event-handler attributes, `javascript:` URLs, `<iframe>`, `<object>`, `<embed>`, `<form>`, `<math>`/MathML, **`<img>` and SVG `<image>` (no image hosting in v1 — see 6.8)**, external resource loads (`connect`/`src` to disallowed origins), SVG `<foreignObject>`, SVG `<use>` (dropped entirely in v1 — see 6.3), `href`/`xlink:href` to external (non-fragment) targets, **`<meta http-equiv="refresh">` and `<base>`** (non-script navigation/redirect vectors — see 6.5/7.3), and `href` schemes outside the allowlist in 6.5.

**TODO (to be specified):** the machine-readable profile itself — its fetch endpoint, format, and **version field** — is referenced here and in 6.5 but not yet specified. It must be **versioned**, because the contract changes when the scripted tier (Phase 2) ships and agents need to detect which contract they are writing against. **It must also be *generated from the same pinned sanitizer-profile artifact* (6.3a) that the gate enforces — never maintained as separate prose.** If the advertised contract and the enforced config drift, agents author to rules the gate doesn't apply (false rejects) or believe forbidden constructs are allowed (false sense of safety); single-source-of-truth is the only way to keep the advertised capability and the enforced capability identical. Flesh this out in a dedicated pass before build (see §10 known gaps).

### 6.2 Validate-then-sanitize on ingest

On write (agent submits a document), run **two stages**. The mental model is a CI linter gate: reject non-compliant input loudly at the source so the author fixes it, the way a linter blocks a PR.

1. **Validate against the policy (loud, agent-facing gate — ergonomics, NOT the security boundary).** Walk the parsed tree and check it against a **named blocklist** of disallowed constructs: `<script>`, any `on*` event-handler attribute, `javascript:` URLs, `<iframe>`/`<object>`/`<embed>`/`<form>`, `<img>` and SVG `<image>` (no image hosting in v1, see 6.8), SVG `<foreignObject>`, SVG `<use>`, `<meta http-equiv="refresh">`, `<base>`, external resource loads to disallowed origins, and `<a href>` values whose scheme is outside the 6.5 allowlist (notably `javascript:` and `data:` hrefs — classic sanitizer-bypass vectors — rejected here explicitly). If any are present, **reject the write** with a structured error naming exactly which violations were found and where (e.g. "`<script>` at line 12; `onclick` on `<div>` at line 40"). Do not silently strip. Rationale: silent stripping gives the agent no feedback signal, so it keeps emitting script forever, and the operator viewing the result has no idea the document was altered. Reject-with-reason closes the feedback loop the content contract depends on. **But understand what this stage is and is not: it is an enumeration of *common known* violations, for *good error messages*. A blocklist can never be complete — the entire history of XSS is the discovery of constructs not yet on anyone's list — so a construct's *absence* from the blocklist NEVER implies it is safe. This stage exists for agent feedback, not for safety.**
2. **Sanitize (the actual security boundary — allowlist-based).** On the accepted path, run the content through an **allowlist-based** sanitizer (DOMPurify as reference, under the pinned profile in 6.3a). **This stage — not stage 1 — is what makes the system safe**, because an allowlist ("only these tags/attributes/namespaces survive; everything else is dropped") is the only model that is safe against *unknown* constructs. The sanitizer's output is authoritative. The sanitizer also normalizes internally (reorders/quotes attributes, lowercases tags, closes tags, re-encodes entities, normalizes whitespace) — those rewrites happen *inside* the library's safety guarantee and are kept silently.

**Authority, stated once and unambiguously.** The **allowlist sanitizer (stage 2) is the security boundary; the named blocklist (stage 1) is an ergonomics layer only.** They are *not* "equivalent," and the spec does not gate on "what the sanitizer removed." (An earlier draft floated gating on DOMPurify's `removed` array "if confirmed to report at the needed granularity" — that option is **dropped**: `removed` is a documented debugging aid, not a security-grade stable API, it does not reliably distinguish security-removal from normalization, and it is not guaranteed stable across the version bumps 6.3a *requires*. Building the loud gate on it would couple correctness to an undocumented internal.) Stage 1 produces messages; stage 2 produces safety; never conflate them. A `201` means "nothing on the blocklist and the sanitizer accepted it" — it does **not** certify the input was security-clean, and the audit log / operator UI must not imply it does.

**Critical implementation note — gate on named violations, not on diff.** Do **not** implement stage 1 as `if input != sanitized_input: reject`. A sanitizer normalizes as well as removes, so benign documents almost never byte-match the sanitized output, and a diff-based gate would reject nearly everything while giving no actionable reason. Stage 1 fires on the **named blocklist** above (fully under your control, where the good linter-style messages come from); stage 2 is the allowlist backstop behind it.

**Divergence is your early-warning signal AND the agent's silent-drop feedback (it does double duty; half the answer to the maintenance problem, 6.3b).** When stage 1 *passes* but stage 2's allowlist *did* drop or alter something, that is the interesting case: a construct slipped the blocklist. There are two reasons to surface it, one security, one ergonomic:
- **Security:** log every such divergence to an operations channel (not the content-free `audit_log` — a separate ops signal). It is the only in-the-wild indicator that a novel construct class is reaching you, before it ever becomes a known bypass. Nothing watching for "the backstop caught what the gate didn't" means flying blind to new attack shapes.
- **Ergonomic (the silent-drop problem):** because stage 1 is a finite blocklist and stage 2 is an (infinite-complement) allowlist, a *benign but non-allowlisted* construct passes stage 1 with no error and is silently stripped by stage 2 — the agent gets a `201` and believes its artifact rendered as authored, blind to the omission. This is the correct security-over-ergonomics tradeoff (you cannot enumerate the infinite set of non-allowlisted constructs as loud errors), and it is in deliberate tension with §6.2's "close the feedback loop" philosophy — own the tension rather than hide it. **Mitigation, nearly free since the divergence is already computed:** return the dropped constructs as a non-fatal **`stripped[]` advisory array in the `201` response** (e.g. `{"id": "...", "stripped": [{"construct": "<custom-tag>", "location": "line 14"}]}`). The write still succeeds; the agent now has the feedback signal to course-correct, without the platform having to pre-reject the unbounded non-allowlist set. (Agent prompt/instruction guidance should still specify the supported schema precisely — the advisory is a backstop for the gap between "what the agent emitted" and "what survived," not a substitute for authoring to the contract.)

**Platform may alter served bytes without it being a version event — and every such alteration is recorded (the unifying principle).** Two operations change what a viewer sees *without* an agent write and *without* advancing `version_no` (3.1/11.3): the silent allowlist stripping above (at ingest), and lazy/targeted re-sanitization later (6.6). This is deliberate and not an exception to be surprised by: a `version_no` event means *the content changed* (an agent authored a new version, 11.6); a platform alteration means *our cleaning of the same content changed*, which is not the same thing and must not pollute the version chain or invite a rollback target that is a *more*-vulnerable sanitization. Every platform alteration is nonetheless **auditable without a version event**: ingest stripping via the `stripped[]` advisory + divergence ops-log; re-sanitization via the `sanitized_hash` + `sanitizer_profile_version` change on the row (6.6). So `sanitized_hash` changing while `version_no` stays fixed is *expected*, by design — an ETag (`version_no`, 11.3) holder gets no concurrency signal from a re-sanitization because re-sanitization is not a competing write, only a tightening of the cache the model already calls regenerable.

**No markup mutation after the sanitizer's final serialization (the ordering rule).** The bytes the sanitizer emits are the bytes stored at `sanitized_key`, **unchanged**. No separate normalization, entity re-encoding, or tag-closing pass runs *after* the sanitizer — because any markup transformation after the last security decision is stored and served *un-revalidated*, and re-serialization is exactly where mutation-XSS is manufactured (a transform produces bytes the browser's fresh parse splits across a foreign-content or attribute boundary into something neither the agent nor the sanitizer ever saw — 6.3). All normalization must therefore be the sanitizer's *internal* normalization (inside its guarantee), never a post-pass. (V1 deliberately does no post-sanitize normalization at all; keeping the sanitizer the last touch is simpler and provably safe than asserting a re-sanitize fixed point. **Debug note for future maintainers:** if post-sanitize normalization is ever added and this rule is violated, the failure mode is *stored mutation-XSS that passes every ingest check* — clean in the sanitizer's DOM, dangerous in the browser's re-parse — so it will not show up in ingest tests, only in serve-time behavior against a real browser parser. If you ever see served output that differs dangerously from sanitizer output, suspect a post-sanitize mutation first.)

Store the sanitized form (object at `sanitized_key`, served) **and** the original (object at `original_key`, for future re-sanitization) in the object store (3.6); the database row keeps only the keys, hashes, size, and the `sanitizer_profile_version` that produced the sanitized bytes (3.1/6.3a).

### 6.3 SVG / MathML specifics and mutation-XSS (commonly missed)

Foreign-content namespaces (SVG and MathML) are the primary source of **mutation XSS (mXSS)** — markup that is clean when the sanitizer parses it but *mutates into something executable when the browser re-parses it*, exploiting parser confusion at HTML/foreign-content boundaries. The defenses:

- SVG can carry `<script>` and event handlers; the sanitizer **must process SVG in the same pass with the same rigor as HTML**, not pass it through.
- **SVG is admitted as an explicit allowlist, not as "SVG minus the dangerous parts."** For the static tier — whose entire promise is *script cannot execute* — admitting the most script-friendly element family and then subtracting hazards is a blocklist mentality (and blocklists are incomplete, 6.2). Instead: allow only the finite diagram/chart subset (paths, basic shapes, `text`, `g`, `defs`, gradients, transforms, presentation attributes) and **drop everything else by default.** The diagram/chart use case is satisfied by that subset.
- SVG `<foreignObject>` can smuggle arbitrary HTML; **disallow it** (hard, tested rejection — on the blocklist *and* absent from the allowlist *and* in the regression corpus, 6.3b).
- **SVG `<use>` is dropped entirely in v1.** It can reference external documents (a data-leak / SSRF-flavored vector) and is a recurring mXSS surface; constraining it to internal fragments requires a custom hook and buys little for static diagrams. v1 simply does not allow `<use>` (it is on the blocklist, 6.2). Revisit only if a concrete need appears, and then as fragment-only via an explicit `uponSanitizeAttribute` hook (6.3a).
- **Forbid `<math>` / MathML entirely** — and via namespace/parser handling, not merely `FORBID_TAGS:['math']`, since MathML is reachable through namespace confusion (6.3a pins the mechanism). It is a foreign-content namespace like SVG, a frequent mXSS vector for the same parser-boundary reason, and the platform has no need for it.

**Honest limit:** the SVG/MathML attack surface cannot be fully enumerated in a spec. The named restrictions above are necessary, but the *durable* defense is the pinned-config artifact (6.3a) plus the maintenance discipline (6.3b) plus the universal serve-time sandbox/CSP (Section 7) underneath. That honest-limit framing is only *true* if all three exist — and two of them (the config artifact and the maintenance apparatus) are specified below rather than left as verbs, because "process with rigor / treat updates as security patches" names a property without naming the mechanism that delivers it.

### 6.3a The sanitizer profile is a pinned, versioned artifact (not prose)

The actual DOMPurify configuration is the single most security-critical artifact in the system, so it is specified as a concrete, version-pinned **sanitizer profile** — code reviewed and changed under the same discipline as code, not described in prose that two implementers would realize two different (and differently-wrong) ways.

- **Named DOM environment.** DOMPurify is a DOM library; server-side at ingest (6.4) it needs a DOM implementation. **Pin `jsdom`** (closest to browser parsing semantics of the server-side shims; `linkedom`/`happy-dom` are faster but diverge more from real browsers, which is the wrong trade for a security parser). Pin its version too — the shim's parser *is* the security-relevant parser at ingest.
- **The ingest-vs-serve parser-divergence is acknowledged and bounded, not silent.** mXSS is *defined* as "the sanitizer's parser and the browser's parser disagree," and choosing ingest-time server-side sanitization (6.4, for preview/cost) over jsdom *widens* exactly that gap versus the real Chrome/Safari that serve-time renders to. This is a genuine tension between §6.4's performance argument and §6.3's security argument, and the spec states it openly. Bounding it: (a) the static-tier serve-time sandbox is the backstop for the *script* consequence of any divergence (6.6/Section 7 — but note 6.6's limit on non-script consequences); (b) the regression corpus (6.3b) is seeded with known parser-differential payloads; (c) if divergence risk ever proves material, the escalation is to run the ingest sanitizer in a real headless-browser engine so ingest and serve parsers match — recorded as the hardening path, not built in v1. **One honest limit on the trigger:** the corpus (b) can only contain *known* differentials, so a corpus hit cannot be the *only* trigger for escalation (c) — by definition the corpus cannot detect the *unknown* jsdom/Chrome disagreement that is the actual risk. So the headless-browser escalation must be **evaluated on a schedule** (periodic differential testing — fuzz jsdom vs. a real engine on a sample, watch upstream jsdom parser-bug reports), not only on a corpus hit. The corpus is a known-bypass tripwire; the scheduled differential review is the unknown-divergence tripwire; they are different instruments and you need both.
- **The profile pins, at minimum:** explicit `ALLOWED_TAGS` / `ALLOWED_ATTR` allowlists for HTML **and** the finite SVG subset (6.3); namespace/parser handling that closes MathML and foreign-content confusion (not just tag-name forbids); `FORBID_TAGS`/`FORBID_ATTR` for belt-and-suspenders; `SAFE_FOR_TEMPLATES` (note: this addresses template-expression mXSS like `{{...}}`, *not* the foreign-content reparse vectors — it is one item among many, not the mXSS answer); disabling unknown/data-attribute passthrough; and the forced-link-attribute behavior (6.5). If `<use>` is ever re-admitted (6.3), the fragment-only `uponSanitizeAttribute` hook lives here.
- **Each option is mapped to the threat it answers**, in the profile artifact's own documentation, so a reviewer can audit "which config line stops which attack" rather than trusting a prose summary.
- **The machine-readable content contract (6.1) is generated from this artifact**, never maintained separately — single source of truth, so advertised capability and enforced capability cannot drift.

### 6.3b Sanitizer maintenance and regression testing (the durable defense)

"Pin the version and treat updates as security patches" is a property; here is the apparatus that discharges it. mXSS bypasses are discovered over time and fixed upstream — an outdated sanitizer is a known-vulnerable one — so the maintenance discipline, not any static config, is what keeps the gate sound across time. **This apparatus is a pre-public-launch blocker** (not strictly a prototype blocker — but it must exist before any author who is not the spec's own author touches the gate), with the single exception of the `sanitizer_profile_version` column, which lands in the prototype because backfilling it later is expensive.

1. **Record `sanitizer_profile_version` on every stored version** (3.1, in the prototype). "Which stored documents were sanitized by a now-known-vulnerable profile?" becomes a `WHERE` clause, and re-sanitization (6.6) becomes targetable instead of a blind whole-corpus pass.
2. **A regression corpus, in-repo, run in CI.** A growing set of known-mXSS / known-bypass payloads (seeded from the DOMPurify test suite, published bypass write-ups, and Cure53's corpus) plus a set of *known-good* documents (to catch false-reject regressions). Each entry asserts input → sanitized output, or input → "rejected with violation X." **The pinned config and the gate are pinned by these tests, not by prose**; no config change or version bump deploys without passing the corpus.
3. **A written "sanitizer update" runbook.** Watch channel: subscribe to DOMPurify releases/security advisories and Cure53; a security-tagged release triggers the runbook. On trigger: add the new bypass payload to the corpus; run it against the *currently pinned* version to confirm or deny exposure; if exposed, bump the pinned profile, re-run the corpus, and deploy — so all *new* writes are immediately safe. What happens to *already-stored* documents is governed by the three-way re-sanitization model (item 6), **not** by a reflexive whole-corpus sweep.
4. **The in-the-wild signal feeds it** (6.2 divergence logging): "the allowlist dropped something the blocklist didn't" is the early warning that complements the upstream advisory watch.
5. **Re-sanitization must be drift-safe** wherever it runs (item 6): re-running a newer profile over an original can change benign output (normalization drift), so it must only *tighten* (never reintroduce a construct), re-hash and update `sanitized_hash`, update `sanitizer_profile_version`, leave `original_key` untouched, be idempotent, and — per the unifying principle (6.2) — **not** advance `version_no` (it is a cache regeneration, not a content change).
6. **Re-sanitization is three distinct operations, not one corpus-scale job — and the routine corpus sweep is deliberately *not* built.** Conflating these was a cost-and-stability trap; separated, the expensive one disappears:
   - **(a) New writes always use the current pinned profile.** No action needed — the *current, actively-edited* version of every live document self-heals simply by being rewritten in the normal course of agent iteration. This covers the documents that matter most, for free.
   - **(b) Lazy re-sanitization on fetch (kept — cheap, self-amortizing).** When an old version is actually fetched and its `sanitizer_profile_version` is stale, regenerate its sanitized body from the retained original at that moment, before serving. Cost is amortized across real reads and touches **only** what someone actually views; a document nobody fetches is never re-processed. This is the everyday mechanism, and it is exactly the "regenerable cache" the storage model (6.6) already describes — regenerating a stale cache entry on miss.
   - **(c) Targeted incident re-sanitization (kept as a capability, not a routine job).** For a specific, exploitable, *non-script* bypass (the only class serve-time doesn't already contain — 6.4) where you have reason to believe stored documents weaponize it, force re-sanitization of the affected set, identified by `sanitizer_profile_version` (and narrowed further where possible). This is an incident response run rarely against a scoped `WHERE` clause, not a sweep on every profile bump.
   - **(d) Routine whole-corpus re-sanitization on every profile bump: explicitly NOT done.** It scales with documents-served (most expensive exactly at success), it rewrites served bytes under live documents nobody is looking at (a stability risk for ~zero benefit), and the only thing it would buy over (a)+(b)+(c) is closing the *non-script* residual on *deep-history, never-fetched* versions — a corner already named and accepted (6.6). The script consequence of any residual is contained at serve time regardless (6.4). So the durable defense against a new bypass is: bump the profile (new writes safe), let (b) heal what's read, and reach for (c) only if a concrete non-script exploit warrants it. The `sanitizer_profile_version` column is what makes (b) and (c) targetable; it is the whole reason the column is worth carrying.

### 6.4 Where the layers apply

- **Sanitization** runs once at ingest (cheaper than per-request; lets the operator preview the served form).
- **Sandbox + CSP** (Section 7) are applied **universally at serve time**, regardless of when a document was stored or who is viewing it. They are the always-on net under the stored-clean layer. Improving the sanitizer later doesn't retroactively protect old stored content — the serve-time controls do, **but only partially: they contain the *script-execution* consequence of a residual bypass (static tier has no `allow-scripts`), not the *navigation / redirect / CSS-redress* consequence** (6.6/6.7, and §7). The retained original body (`original_key`) is the basis for *re-sanitizing* stale content when rules harden — but note this is done **lazily on fetch and via targeted incident response, not as a routine whole-corpus sweep** (6.3b item 6): new writes self-heal, read content heals on access, and the deep-history non-script residual is an accepted risk (6.6). Do not over-credit serve-time as a total backstop (it is strong for the *script* case specifically), and do not assume a corpus-wide re-sanitization runs on every profile bump (it deliberately does not).

### 6.5 Hyperlinks

Hyperlinks are supported but are a **named, handled category**, not pass-through markup. They matter for two reasons: external links are the one egress channel CSP cannot close (navigation isn't governed by `connect-src`, so a link can carry data out in a query string or impersonate a destination), and internal links interact with the per-document origin model in a way that naive `href`s get wrong. Both link types are critical to the use case — external links in particular, since operators will want to follow an agent's cited sources to audit its output — so the goal is to support them safely, not to forbid them.

`href` scheme allowlist: `https:` only for external links, plus the internal logical-reference scheme below. Everything else — `javascript:`, `data:`, `http:` (insecure), `file:`, exotic schemes — is rejected at validation (6.2).

#### External links (`https:`)

- The platform **forces attributes at sanitize time** (not trusted to the agent): `target="_blank"`, `rel="noopener noreferrer"`. `noopener` is non-negotiable — without it the opened page receives a `window.opener` handle back into the frame, a real attack even from a sandboxed opaque origin. `noreferrer` prevents leaking the content-origin URL to the destination. **Crucially, this forcing is implemented *inside* the sanitizer profile (a DOMPurify hook, 6.3a) — it is part of stage 2's pass, NOT a post-sanitize string rewrite.** This is load-bearing, not a stylistic note: the §6.2 ordering rule forbids any markup mutation after the sanitizer's final serialization, because a post-pass re-serialization is exactly how mutation-XSS gets manufactured. An implementer who reads this bullet but not §6.2 would naturally reach for a tempting post-pass `.replace()`/DOM-rewrite to force `rel`/`target` — and would thereby rebuild the single worst finding (the ordering bug) from a different section. Force the attributes in the hook, while the sanitizer still owns the DOM; never after.
- The sandbox must permit the link to open: the served iframe needs `allow-popups` and `allow-popups-to-escape-sandbox` (so the opened page is not itself sandboxed). Note this corrects the bare `sandbox=""` posture from an earlier draft, which would have made external links non-functional.
- **Explicit marking is applied by the platform at render**, not by the agent (same principle as 7.4 — the platform decides posture, the document doesn't): external links are visually distinguished as outbound (an affix/icon and/or styling) so a reader always knows a link leaves the platform. Mechanism note (same ordering concern as the forced attributes above): prefer doing this as **presentation** — a serve-time stylesheet/attribute the rendering layer applies to flagged links — rather than mutating the stored markup; if any marking *does* add to the markup, it must be part of the sanitizer profile's hook (6.3a), never a post-serialization rewrite (6.2).
- *V2 to-do:* route external links through a confirmation interstitial (`app.com/leaving?url=...`) that shows the real destination before navigating. Deferred for v1; the forced `rel`/`target` and visible marking are the v1 mitigations. (Mirrors the Phase 2 viewer interstitial in §8.)

#### Internal links (project-relative logical references)

Literal relative URLs do **not** work under this architecture, and the reason is the per-document origin split, not the sandbox. A document is served inside an iframe from its own content origin (`<docid>.yourappusercontent.com`), so the browser resolves any relative `href` against *that* origin, not against the `app.com/<project>/<doc>` URL shown in the address bar. `<a href="/document_B">` from document A resolves to `https://<docA-id>.yourappusercontent.com/document_B` — wrong origin, dead URL. Injecting a `<base>` tag to fix resolution is rejected: it has global side effects on every relative URL, and it re-couples content to the app domain (your `base-uri 'none'` CSP directive forbids it anyway).

Instead, agents author internal links as **logical references** that name the target, and the platform resolves them to the correct top-level app-domain URL **at serve time, by slug, on every render** (the full resolver model is in 3.7):

- Syntax: `<a href="doc:document_b-slug">` for a same-project sibling; a qualified form (`doc:other-project/document_c` or `doc:id:<uuid>`) to reach across projects (3.7).
- **Project-relative by default**: an unqualified reference resolves within the author's current project, so an agent working in one project links to siblings by short slug without knowing the full URL or even the project. This is the project-level relative-navigation ergonomic, delivered without depending on browser relative resolution.
- **Resolution is serve-time, by slug, every time** — no link-graph, no binding (3.7). Each render does a fresh slug lookup (against `unique (project_id, slug)`), rewrites a found target to its displayed app-domain URL with `target="_top"` (so navigation breaks out of the iframe to the app shell), and renders a not-found or soft-deleted target as a disabled/marked link. Forward references and recursion work for free because every lookup is fresh; rename/delete deading a link is the accepted "internet has 404s" tradeoff.
- **Access is re-checked on navigation, never granted by the link.** Routing internal links through the app domain means the top-level navigation runs `can_access` (Section 4) on the target for the *current viewer*, **at the moment of the click, not cached at render time** (the TOCTOU rule in 4.8). Resolution is *existence*, not authorization (3.7): it finds the target by slug but does not check whether the author could read it; the viewer's access is evaluated at navigation. A link is a reference, not a grant. (This is also why internal links must not point at raw content origins — a direct content-origin URL would bypass the access check.)
- **Dangling references render inert, not as 404s.** A reference whose slug resolves to nothing (never existed, renamed, or soft-deleted) renders as a disabled/marked link rather than a broken navigation. ("What links here"/backlinks is *not* available — that would need a maintained index this model omits by choice; see 3.7 and 11.5.)

### 6.6 Resource bounds (DoS and storage)

Unbounded agent input is both a denial-of-service surface (a pathological document can pin a CPU during parse/sanitize) and a storage-cost problem. The following are **defaults to tune**, not physical constants — the architecturally important point is that each bound *exists* and is enforced at the API write layer with a clear rejection error. **Critically, the bounds must be enforced in the right place and the right way — several cannot be enforced where the naive design would put them** (the mechanical findings below are load-bearing, not pedantic):

- **Per-document payload: ~5 MB.** Enormous for a text/SVG knowledge artifact (a long, diagram-heavy article is low-hundreds of KB), so this is generous headroom while still bounding the parser. Enforced on the raw bytes *before* parsing.
- **A cheap pre-parse gate runs before the heavy parser (depth cannot be checked post-parse).** You cannot count nesting depth without parsing — but handing a 50,000-deep nested document to jsdom/DOMPurify blows the V8 call stack or OOMs *during the parse*, long before a tree-walker could count and reject. So a **lightweight SAX/streaming pre-scan** (e.g. `htmlparser2` tracking open-tag depth) runs first, at the raw-string level, and rejects on:
  - **Parse nesting depth: ~512 levels.** Far beyond any real document; catches deeply-nested-node attacks before they reach the stack-blowing parser.
  - **Total node count and per-element attribute count caps.** Depth alone bounds neither *width* nor total nodes: 5 MB of shallow-but-massive or attribute-heavy markup can be quadratic in the real parser/sanitizer without being deep. Cap node count and attributes-per-element here too.
  - **Limit of the pre-gate (why the killable worker below is the real backstop, not this).** A SAX/streaming scan reads a *token stream*; it does **not** run the HTML5 tree-construction algorithm (adoption-agency reparenting, table fixup, unclosed-formatting-element expansion). So a payload that is *shallow and small as a linear token stream* can force jsdom to construct a *massively deep or memory-heavy AST* when it auto-corrects malformed markup during tree construction — depth the token-level counter cannot see because it does not exist yet at the token level. The pre-gate therefore catches *lazy* depth/size/billion-laughs attacks cheaply (worth doing — it rejects the obvious cases before they reach the stack-blowing parser), but it is **not** a complete defense against crafted AST-expansion. The guarantee against that class is the killable worker (next bullet): when tree construction goes pathological, the worker's OOM/wall-clock kill is what actually contains it. Treat the pre-gate as a cheap first filter, the worker as the backstop.
- **Sanitization runs in an isolated, killable worker — the wall-clock timeout is otherwise a footgun, AND it is the real backstop for AST-expansion the pre-gate can't predict.** A "~5 s sanitizer timeout" cannot be enforced by a timer on a single-threaded Node event loop: jsdom parse + DOMPurify are synchronous and block the loop, so the timeout callback cannot fire until the work already finished — and meanwhile the *entire API stops responding to all other requests*. A runaway agent submitting complex documents would trivially take the write path offline (you would hit this in normal testing, not just under attack). So sanitization **must run in a `worker_thread` or subprocess that can be physically killed** (`worker.terminate()`) when it exceeds the wall-clock budget or trips a memory ceiling. The timeout becomes "kill the worker," not "hope a timer fires" — and because the kill is triggered by actual resource consumption (time/memory) rather than by a predicted structural metric, it catches the crafted AST-expansion payloads that slip the token-level pre-gate.
- **A global concurrent-sanitization bound, not just per-key rate limits.** The ~5 s budget is per-document; N concurrent near-budget sanitizations = N×5 s of pinned CPU, and sanitizer CPU is the most expensive operation in the write path and the easiest to make adversarially slow. Per-key write limits (4.7) do not bound *aggregate* CPU across a fleet or across operators. Specify a **bounded sanitization worker pool with a global concurrency cap**, queueing or rejecting (`429`/`503`) beyond it. Sanitizer CPU is a shared cross-operator resource and must be rate-bounded at the platform level, or per-operator quotas don't stop cross-operator CPU starvation. (Implementation is the build agent's call and the spec stays library-agnostic — a pool manager like `piscina` is the sensible default for `worker_thread` lifecycle + bounded concurrency rather than hand-rolling it, but "bounded killable pool with a global cap and per-task hard kill" is the requirement; the library is not.)
- **Version retention — requires an active background pruning job, not just a passive cap.** Each version stores two bodies in object storage (served + original), and because agents iterate rapidly this accumulates fast (linear, not exponential — but linear-with-a-fast-agent is still enough to drown storage). Opportunistic pruning on write will not keep up; specify a **scheduled background job** that prunes objects for versions older than a threshold (last N versions, or an age cutoff) and clears the corresponding `*_key` on the row. What survives vs. what is dropped, precisely:
  - **Legal hold is checked first and is absolute (3.5.3).** Before pruning any version, the job tests `document_versions.held` (the denormalized cache of an active `legal_holds` row, 3.2). **A held version is skipped entirely — neither its original nor its sanitized body is dropped, regardless of age or threshold.** This is the one exemption that overrides every retention heuristic below; the held bytes (especially `original_key`, which preservation duties specifically want) survive until the hold is released. The held check fails safe: if the cache and `legal_holds` disagree, the version is treated as held and not pruned.
  - **Retained:** version *metadata* (the provenance row — version_no, who, when, model, the content hashes, size) for the audit trail, kept indefinitely. The current version's bodies, always.
  - **Dropped beyond threshold:** the historical original-body object (and optionally older sanitized-body objects for non-current versions, per policy). The statement that nulls each `*_key` to record the drop **also decrements `operators.physical_bytes` by that body's size** (`original_size` / `sanitized_size`, 3.1) in the same statement, guarded `WHERE <key> IS NOT NULL` — so the decrement fires exactly once per object freed and a repeated prune pass over an already-pruned (or skipped-held) version mutates nothing. This `WHERE key IS NOT NULL` guard is the entire idempotency mechanism; **no latch column is needed**, because the physical-free of a key is a genuine one-time transition. `live_bytes` is **not** touched here — it was already credited at the operator's soft-delete (3.5.1), or not at all if the version is still live (a non-current version of a live document still counts toward the operator's live footprint until the document itself is soft-deleted).
  - **Recommended model — treat the original as durable, the sanitized form as a regenerable cache.** Since the sanitized body is *derivable* from the original (re-run the sanitizer) but the original is *not* recoverable from the sanitized form (sanitization is lossy and one-way), the original is the security-relevant ground truth — it's what a hardened future sanitizer must inspect, because hardening targets dangerous *input shapes* that the laundered output no longer contains. Prefer **keeping originals longer (compressed — HTML/SVG compresses ~4:1) and pruning non-current sanitized bodies more aggressively**, regenerating a sanitized body on demand if an old version is ever fetched (this is the **lazy-on-fetch re-sanitization** of 6.3b item 6 — a stale cache entry regenerated on read, from the original). This inverts the naive instinct and preserves re-sanitization capability at lower cost. **Note the corollary: already-sanitized bytes cannot be reliably re-sanitized** — sanitization is lossy, so a future mutation-class bug that needs the *original arrangement* can't be caught by re-running a hardened sanitizer over laundered output. Re-sanitization works *from originals*, which is why originals are the durable asset.
  - **Explicit tradeoff (and its residual risk, stated honestly):** once an original is pruned, that specific version **can no longer be re-sanitized and is permanently locked to the security posture of the `sanitizer_profile_version` that processed it** (3.1/6.3a). The universal serve-time sandbox/CSP (Section 7) still applies — but that backstop is **partial, not total**: it contains the *script-execution* consequence of a residual bypass (static tier has no `allow-scripts`), and does **not** contain *navigation / redirect / CSS-redress* consequences (6.6 below / Finding-level detail in §7). So the precise residual on pruned-original history is: *a non-script mXSS payload authored before a later-discovered bypass, on a version whose original is gone, is neither re-sanitizable nor fully serve-time-contained.* This is a narrow corner and **acceptable for a private prototype**; it must be a **named, accepted risk before public exposure**, not an unexamined "serve-time covers it." Audit/provenance is unaffected (metadata is retained).
- **Per-operator storage quota — two counters, one bound (3.1).** Configurable, e.g. ~1–2 GB default; generous for text artifacts (thousands of compressed SVG-bearing documents fit in 1–2 GB) while bounding liability. The accounting uses **two denormalized columns on `operators`, never a `SUM(size_bytes)` over version history** (which would put a full-history scan on the write hot path and choke once an operator has thousands of iterative versions). Both are maintained **synchronously inside the write and prune transactions** (an async counter lets a runaway agent outrun it and defeat the bound):
  - **`physical_bytes` — the bound that is actually enforced.** Bytes physically resident in R2 for this operator. `+= body size` at create (per body, in the write txn, 4.6); `−= body size` at the statement that nulls each `*_key` during pruning or hard-delete, guarded `WHERE key IS NOT NULL` (above). **The write-time quota check tests this counter**, and the write that would exceed quota is rejected (the quota error, 11.11). This is deliberately the *physical* number because the threat is bytes-in-R2: a create→soft-delete→create cycle cannot game it, since **soft-delete frees nothing physically** (3.5.1) and so does not decrement `physical_bytes` — only an actual object free does. Held bytes correctly stay counted here until released-and-purged, because they are physically present; this is invisible to the operator (it is never shown) so it discloses no hold (3.5.3).
  - **`live_bytes` — display/fairness only, never the gate.** The operator's *live footprint*: what "you're using X of Y" shows. `+= size` at create, `−= size` at the operator's own soft-delete (3.5.1), `+= size` again on restore. Because it moves only on **operator actions**, it never reflects whether bytes physically survive under a platform hold — which is precisely what keeps a held document from silently consuming the operator's visible quota and thereby disclosing its own retention (3.5.3). **If writes were ever gated on `live_bytes` instead of `physical_bytes`, the create/soft-delete-cycle storage hole reopens** — the visible counter must remain display-only.
  - On R2 (3.6) the platform's own cost is ~$0.015/GB-month with zero egress, so quotas are about fairness and abuse-bounding, not vendor cost pressure; storage does not become a material line item until tens of thousands of active users, at which point it is single-digit dollars of overage. (Storage half of the rate-limiting in 4.7.)

### 6.7 CSS is allowed, with egress closed at the CSP layer

The contract allows "all CSS," and for a static, sandboxed document that is almost entirely inert — but two notes prevent a wrong assumption. CSS can load external resources (e.g. `background: url(https://attacker.com/...)`), which would be both a privacy beacon and an egress channel that, like links, sidesteps `connect-src` (resource loads are governed by `img-src`/`font-src`, not `connect-src`). This is **closed by the CSP in 7.3**: `img-src`/`font-src`/`style-src` are scoped to self/inline/`data:` with **no external origins**, so CSS-driven external fetches simply fail. State this explicitly so nobody reads "all CSS" as "including remote fetches." Second, and more than cosmetic: **CSS can fixed-position-overlay the viewport, which is a UI-redress (clickjacking-*within*-the-frame) vector, not just a visual annoyance.** The per-document iframe origin and `frame-ancestors` (7.3) close clickjacking *of* the document (it can't be framed by an attacker), but they do nothing about an overlay *inside* the document that makes a forced outbound link look like a benign button — and navigation is the one egress CSP can't close (6.5). This is a **sanitizer/CSS-allowlist concern**, not a serve-time one: the layers below do not contain it. **V1 decision (not a fork): accept this as a named, documented residual risk**, because the audience is private and principal-gated (the author and viewer are within a known operator's trust circle), which bounds the blast radius — and because actually *blocking* it is not a cheap toggle: a markup sanitizer like DOMPurify does not parse CSS property values structurally enough to forbid "fixed-position overlay over an interactive element," so the pre-public mitigation requires **structural CSS hooks / a CSS property allowlist / a separate CSS sanitizer** (genuine engineering, not a flag — which is itself why "just block it for v1" would be a verb-not-mechanism regression). **Pre-public, this residual must be revisited** (it matters far more once arbitrary strangers can be lured to a document) and either closed with the structural CSS work or formally re-accepted with counsel-aware eyes. Until then it is tracked, not closed. (Note the tension with §6.1's headline "all CSS" allowance — that headline carries this caveat; see 6.1.)

### 6.8 No image hosting in v1

v1 does **not** host images. `<img>` and SVG `<image>` are on the named blocklist (6.1, 6.2) and rejected at ingest with a structured violation, exactly like `<script>` — the agent gets a clear "images are not supported in v1" signal rather than a silently broken document.

**Why this is a scope decision, not a CSAM control.** The motivating question was whether banning images removes CSAM risk; it largely does not, and the spec should not pretend otherwise. The mandatory-preservation/reporting surface (3.5.3) keys on *apparent CSAM and related offenses*, much of which is **textual** (grooming, trafficking solicitation, written sexual content involving minors under §§ 1591/2422(b)). The platform serves agent-authored text; text is the primary payload. So the no-image decision rests on its **own merits** — raster hosting means binary blobs in R2, larger storage/egress, an EXIF-metadata privacy surface, and a different moderation profile, none of which the core use case needs — and the CSAM detection/reporting/preservation structure (3.5.3) **remains required regardless**. Do not let "images are banned" create a false belief that the CSAM problem is handled; it is not, and the text-side runbook still needs to exist.

**Why a sanitizer rule and not "let CSP handle it."** An external `<img src="https://...">` is a remote resource load — precisely what `img-src` (no external origins, 7.3) blocks at render. "Allowing" external images by simply not having a rule does not produce working images; it produces an `<img>` the browser refuses to load, i.e. a broken-image icon in every document. So the real choice is "strip-and-tell-the-agent" vs. "ship silently broken renders," and the former is strictly better and consistent with the 6.2 gate. (Actually *permitting* external images would require allowlisting external origins in `img-src`, which reopens the egress/tracking channel `connect-src 'none'` and the 7.3 scoping exist to close — and it is the one option that genuinely re-touches CSAM, since the platform would then render arbitrary remote imagery, including illegal content, to viewers. "Hosted elsewhere" is a weaker disclaimer than it sounds when you are the one presenting the bytes. Not done.)

**The one edge worth stating: data-URI raster inside SVG.** A raster bitmap can be embedded as `<image href="data:image/png;base64,...">` *inside* an otherwise-vector SVG. Because the blocklist rejects SVG `<image>` (not just top-level `<img>`), this is covered by the same rule — the data-URI raster path does not slip through the "inline SVG is allowed" allowance. Vector SVG (paths, shapes, text — the actual diagram/chart use case) is unaffected.

**Revisit post-launch.** This is a deliberate v1 narrowing in the same spirit as deferring JS (Phase 2) and network calls. If real agent demand for hosted images appears, raster hosting can be added later as its own phase — with the storage, moderation, and (if ever external) egress questions addressed explicitly at that point, rather than smuggled in via an unenforced markup allowance now.

---

## 7. Serving and Sandbox Architecture

The sandbox is a serving-and-browser-boundary problem, entirely outside the database. In v1 (no script) these controls are **defense in depth** — the primary wall is "there is no script." Build them anyway, because they are the seam Phase 2 requires intact; retrofitting origin isolation onto a single-origin v1 is the migration that hurts.

### 7.1 Origin model — per-document origins on a separate registrable domain

The browser's security boundary is the **origin**, not the document. To guarantee one document's content can never reach another's, give each document its own origin.

- Serve each document from `<docid>.<content-domain>`, where `docid` is the unguessable random document id.
- Use a **separate registrable domain** for content (e.g. `yourappusercontent.com`), distinct from the app domain (`yourapp.com`). This is the Google `googleusercontent.com` pattern. It guarantees no cookie scoped to the app domain can ever leak to content, and vice versa. ~$12/yr of insurance against a whole class of mistake.
- Requires a wildcard DNS record (`*.yourappusercontent.com`) and wildcard TLS cert. Both trivial.
- **Never** scope app cookies to a parent domain shared with content.
- **The serving origin is always per-document, never per-project.** Projects are an organizational and ACL-scoping concept (Section 4), not an origin concept. Per-*project* subdomains would put multiple documents on one origin, which in the Phase 2 scripted tier lets script in one document reach into the others on the same origin — rebuilding exactly the cross-document leak per-document origins exist to prevent, scoped to the project boundary. Do not collapse the origin to the project level.

### 7.2 The iframe sandbox

Documents are embedded in a sandboxed iframe.

- **v1 (static tier)**: no script is permitted, so no `allow-scripts`. The frame does need `allow-popups allow-popups-to-escape-sandbox` so external links (6.5) can open in a new, non-sandboxed tab; without them external links are non-functional. Do not add `allow-same-origin` or `allow-scripts`. (An earlier draft specced bare `sandbox=""`; that is corrected here because it breaks external links.)
- **Phase 2 (scripted tier)**: `sandbox="allow-scripts"` **and crucially NOT `allow-same-origin`**. Those two together are a footgun — the spec lets a frame remove its own sandboxing if it has both. With `allow-scripts` alone, script runs in an opaque origin: no cookies, no `localStorage`, no access to its real origin. Combined with per-document origins, that's two independent walls. Start with `allow-scripts` only; add capabilities (`allow-forms`, `allow-popups`, `allow-modals`) one at a time as real use cases demand, each a deliberate widening. Do not pre-grant.

### 7.3 Content Security Policy — the network boundary

The sandbox controls what a frame can touch locally; CSP controls what it can reach over the network. This is the control that actually addresses "don't be an exfiltration/phishing/relay host."

For **all documents, all tiers, v1**:

> **Where these headers come from (delivery mechanism).** A raw R2/S3 presigned URL cannot carry a per-object CSP, so the body is **never** served by redirecting the browser to a bucket URL. It is served by the edge Worker on the content origin (11.4), which reads the object via its R2 binding and attaches every directive below at response time. CSP is therefore a property of the *serving path*, not of the stored object — which is exactly why it can be "applied universally at serve time, regardless of when a document was stored" (6.4) and why the posture is set by the document's tier, never the viewer (7.4). If a future path serves bytes (e.g. the deferred public CDN path, 4.9), it must attach these same headers; "served" always means "served with this CSP."

- `connect-src 'none'` — documents cannot make network calls. No exfiltration surface. (This is also the decision that defers the LLM-calls-LLM pattern; if ever revisited, do it through a server-side mediated, authenticated, rate-limited proxy endpoint — never by allowlisting `api.anthropic.com` or any third party directly from user content, which would let any document burn quota or use the platform as an open relay.)
- `script-src` — in v1 there is no script; in Phase 2, forbid `eval`.
- `base-uri 'none'`
- `form-action 'none'` (belt-and-suspenders with the sandbox)
- `frame-ancestors` — permit only the app to embed the content frame, preventing clickjacking of rendered documents into a third-party site.
- `default-src` / `img-src` / `font-src` / `style-src` — scope to `'self'` / `'unsafe-inline'` (for inline styles) / `data:` as needed for the static subset; **no external origins**. This is what closes CSS-driven egress (6.7): external `url(...)` fetches in CSS fail because no external origin is permitted for `img-src`/`font-src`. (Note `img-src` is **not** tightened to `'none'` even though v1 hosts no images: `<img>`/SVG `<image>` elements are stripped at ingest, 6.8, so `img-src` here governs only resources a stylesheet might reference — e.g. a `data:` background — not document images. The two layers are independent, not redundant.)

### 7.4 Posture is determined by the document, never by the viewer

> The security posture of a served document is determined by the document's own `security_tier`, never relaxed by the viewer's relationship to it.

An operator viewing their **own** scripted document gets the **same** sandbox and CSP as a stranger. There is no "trusted because it's mine" fast path in the serving layer — that shortcut is exactly how same-origin leaks get introduced. (This is independent of the access decision in Section 4: access says *whether* you may see the document; tier says *how* it is served once you may.)

### 7.5 Displayed URL vs hosted URL

The per-document content origin (`<docid>.yourappusercontent.com`) is ugly and unguessable by design. That conflicts with the legitimate desire for friendly, readable URLs (`yourapp.com/<project-slug>/<doc-slug>`). Resolve this by separating the two layers:

- The **displayed URL** lives on the app domain and uses human-readable slugs: `yourapp.com/<project-slug>/<doc-slug>`. This is what appears in the address bar, what people share and bookmark. The app resolves the slugs to a `docid` (via `projects.slug` + `documents.slug`), runs the Section 4 access check, and renders the app shell.
- The **hosted URL** is the per-document content origin. The app shell embeds the document by pointing its sandboxed iframe at `<docid>.yourappusercontent.com`.

So the nice project-scoped URL is purely a routing/display concern on the app domain; the security boundary stays per-document on the content domain. The user sees `yourapp.com/research/north-island-listings`; the iframe inside is served from the unguessable content origin. You get readable URLs and per-document origin isolation at once. Do not let the URL-aesthetics desire pull the security boundary up to the project level — these are different layers and stay different layers.

---

## 8. Phased Build Plan

### Phase 1 — Static knowledge host (this spec)

The full v1 surface:

- Operators (Google OAuth) and agents (per-agent keys: ≥32-byte CSPRNG secret, fast-hashed via HMAC-SHA-256 + pepper, constant-time compare — see 5.2).
- Projects as an organizational + ACL-scoping layer (`projects`, `documents.project_id`, `project_agents`); never an origin concept.
- Documents + versions with provenance; the data model in Section 3. Document bodies in object storage (Cloudflare R2), database holds metadata + `*_key` pointers (3.6).
- The `can_access` function (Section 4) as the sole data path; operator-access invariant structural; authorization resolved server-side at every request, never render-cached (4.8).
- Share policies: `writing_agent_only`, `all_operator_agents`, `all_project_agents`, `operator_only`, `explicit`; account-level default; polymorphic principal target with room for groups. The `explicit` policy covers private person-to-person sharing (grant a named, signed-in operator read access) — the safe "share with a specific person" model. **Public link sharing (4.9) is DEFERRED, not in V1** (no `public_links` table, no public-token path; reasoning in 4.9 / 10.1).
- Content contract published (human docs + machine-readable profile via `GET /v1/contract`, **generated from the pinned sanitizer profile, 6.3a**). Sanitizer hardened against mXSS: MathML forbidden (via namespace handling), SVG restricted to an **explicit diagram/chart allowlist** with `<use>` and `<foreignObject>` dropped, DOMPurify pinned as a **versioned profile artifact** on a named DOM shim (jsdom), `<meta refresh>`/`<base>` blocked (6.1/6.2/6.3/6.3a).
- Validate-then-sanitize ingest: **allowlist sanitizer is the security boundary, named blocklist is agent-feedback ergonomics only** (not gated on the sanitizer's `removed` array); **no markup mutation after the sanitizer's final serialization** (the ordering rule, 6.2); divergence (blocklist-passed-but-sanitizer-dropped) logged to ops as novel-construct early-warning; store sanitized + original + `sanitizer_profile_version`. Resource bounds enforced (6.6): per-document size, a **pre-parse SAX gate** for depth/node/attribute caps (before the heavy parser), **sanitization in a killable worker with a global concurrency bound** (the wall-clock timeout is unenforceable on the main event loop), and the **two-counter storage quota** (`physical_bytes` enforced at write, `live_bytes` display-only — 3.1/6.6), maintained synchronously in the write/prune transactions.
- **Pre-public (tracked, not prototype): the sanitizer maintenance apparatus (6.3b)** — CI regression corpus, update runbook, advisory watch, scheduled jsdom-vs-browser differential review, and the three-way re-sanitization model (new writes self-heal; **lazy re-sanitization on fetch**; targeted incident re-sanitization keyed on `sanitizer_profile_version` — **no routine whole-corpus sweep**). The `sanitizer_profile_version` column itself lands in the prototype (cheap now, expensive to backfill); lazy-on-fetch is cheap enough to include early.
- Background version-pruning job (6.6): drops old body objects past threshold, retains version metadata for the audit trail; originals kept (compressed) longer than sanitized bodies; each freed object decrements `physical_bytes` at key-null (idempotent, `WHERE key IS NOT NULL`). Skips held versions.
- Write path (4.6): idempotency key (dedupe retries, ephemeral with 48h sweep) plus optimistic concurrency (`If-Match`/`ETag`); the "new attempt ⇒ new idempotency key" rule documented in the agent API; **document-level-hold inheritance set in the write txn** so versions born under a hold are preserved (3.2/4.6).
- Per-agent rate/creation limits and per-operator storage quota (the `physical_bytes` gate) enforced at the API layer (4.7).
- Audit log (3.4) as core: append-only, captures reads/writes/admin events and denials, content-free rows, partitioned by month.
- Deletion lifecycles (3.5): soft-delete (operator-visible; credits `live_bytes`) and account-wide deletion with `deleted_at` gate in `can_access`; hard-delete/erasure path that purges R2 bodies (decrements `physical_bytes`); platform-only legal hold (`legal_holds`) overriding all destruction paths.
- Minimal trust & safety surface (Section 12): `reports` table + one authenticated intake endpoint, operator suspension (`operators.status`, auth-level fail-closed), agent disable / key revocation (already in 3.1/5.2), append-only `enforcement_actions` log, and the CSAM-report→`csam_preservation`-hold wiring (12.5). Anonymous intake, strikes automation, detection, and queue UI are deferred as additive-over-the-same-schema (12.6).
- Hyperlinks (Section 6.5): external `https:` links with forced `rel="noopener noreferrer" target="_blank"` and platform-applied outbound marking; internal `doc:` slug references resolved serve-time on every render (3.7, no link graph), `can_access` re-checked on navigation, dangling/renamed/deleted targets render inert. Backlinks and external-link confirmation interstitial both deferred.
- **Public agent API (Section 11):** REST `/v1`, bearer-key auth, create/update with header-based idempotency + `If-Match` concurrency, single-call body read via a `302` to the content-origin **edge Worker** that verifies a ~60s signed token and attaches the §7.3 CSP/headers (a raw R2 presigned URL can't carry per-object CSP; the CDN path is deferred with public links, 4.9/11.4), `can_access`-filtered cursor-paginated discovery (documents/projects), structured `422` rejection. No agent delete; history operator-gated. Private app/management API specified separately when web/mobile clients are built.
- Serving: per-document origins on a separate content domain, bodies served from R2 **through a thin edge Worker that verifies the read token and attaches the CSP/headers** (3.6/11.4); sandboxed iframe (static tier: `allow-popups allow-popups-to-escape-sandbox`, no script); universal CSP with `connect-src 'none'` and external-origin-free `img/font/style-src`, stamped by the Worker at serve time. Friendly app-domain URLs (`yourapp.com/<project>/<doc>`) resolve to and embed the per-document content origin (Section 7.5).

Ships the Willison/Shihipar "rich explanation" use case (SVG, CSS, in-page nav) without interactive widgets. Small, defensible surface.

### Phase 2 — Scripted tier (deferred)

- Per-document `security_tier = 'scripted'`.
- `sandbox="allow-scripts"` (never with `allow-same-origin`); capabilities added one at a time.
- CSP still `connect-src 'none'` unless/until a mediated proxy is built.
- **Required: a viewer interstitial.** Gates *viewing a scripted document you do not own*; warns that the document contains active content from another party running in a sandbox. Shown once per viewer; not shown for the owner's own documents; never shown on the static tier.
  - *Open question (defer):* is "dismiss" remembered per-document or per-author?

### Phase 3+ — Candidates (not committed)

- External-link confirmation interstitial (`app.com/leaving?url=...`) showing the real destination before navigating off-platform (V2; see 6.5).
- Agent groups as share targets (`agent_group`); unlisted-link sharing (`link`).
- Postgres RLS as defense-in-depth mirror of `can_access`.
- Mediated server-side proxy for documents that need outbound calls (only if a real use case justifies the metering/abuse surface).
- Real-time sync, if collaborative editing becomes a goal.

---

## 9. Recommended Stack (prototype)

- **Database (metadata only)**: PostgreSQL — Neon or Supabase's Postgres (managed, generous free tier). Supabase is a good fit because it is Postgres-with-Google-auth-and-RLS included, giving Firebase-like onboarding *and* a real relational engine; its RLS becomes the natural Phase-3 defense-in-depth layer. (Original Firebase instinct was for Google auth + free tier; Supabase satisfies both without Firestore's Security-Rules pain on transitive/policy-based sharing.) The database holds metadata, ACLs, audit log, and `*_key` pointers — **not** document bodies.
- **Document bodies**: Cloudflare R2 (3.6) — S3-compatible object storage with zero egress, matching the read-heavy serving workload; ~$0.015/GB-month storage, no per-read egress charge. Bodies referenced from Postgres by `sanitized_key` / `original_key`.
- **Auth**: Auth.js / Lucia for Google OAuth (operators); custom key mint/verify for agents (≥32-byte CSPRNG secret, HMAC-SHA-256 + server pepper, constant-time compare — **not** a password hash; see 5.2).
- **API**: thin server in whatever's fastest to ship; it is the sole data path and the home of `can_access`.
- **Content serving + edge**: Cloudflare — separate registrable content domain, wildcard DNS + TLS, per-document subdomain origins served from R2 **through an edge Worker (required, not optional: it verifies the read token, reads R2 via binding, and attaches the §7.3 CSP/headers a raw presigned URL cannot carry — 11.4)**, sandboxed iframe + CSP applied at serve time, and the WAF/DDoS/rate-limit backstop (4.7). Storage, CDN, edge-auth, and edge protection collapse into one provider.

---

## 10. Known Gaps and To-Be-Specified

Items consciously deferred or not yet detailed. Listed so the implementer knows they were considered, not forgotten — and so none is mistaken for an oversight.

- **Agentic API surface — now specified in Section 11.** The public agent API (endpoints, write semantics, body-fetch model, error shapes, pagination, discovery) is drafted in Section 11. The private operator/management API is being specified incrementally: its **auth-routing foundation and the key/agent-management cluster are now in Section 14**; the remaining operator clusters (share management, history/rollback, byte-deletion, account deletion) are subsequent passes over that same foundation, specified as the web/mobile clients are built.
- **Platform-admin identity & authz — now SPECIFIED in Section 13.** Three tables carry columns pointing at a platform-staff identity distinct from `operators`: `legal_holds.placed_by`/`released_by` (3.1/3.5.3), `enforcement_actions.actor_admin_id` (3.1/12.4), and `reports.resolved_by` (3.1/12.1). These are deliberately **not** `operators.id` — platform admins are a separate principal type with their own authentication and authorization, because their powers (place a hold invisible to the owning operator, suspend an account, take down a document) are exactly the powers an operator must *not* have over others. Section 13 resolves the three open questions: the platform-admin principal and its auth (a `platform_admins` table with real auth on a separate IdP/origin, 13.1–13.2); the authz model (a **separate privileged path**, not a `can_access` branch, with an `admin_can(admin, capability)` check, 13.4); and the audit treatment (every action logged and reasoned via `enforcement_actions`, 13.5). V1 builds real per-admin auth rather than the single hardcoded identity §12.4 sanctioned (13.1). The **operator-facing** half of the management API (key minting, share management, history/rollback, account deletion) remains a separate pass, specified when the web/mobile clients are built.
- **Read / list / discovery interface — specified in Section 11** (`GET /v1/documents`, project scoping, cursor pagination, all `can_access`-filtered; backlinks deferred, 11.5).
- **Machine-readable content profile — endpoint specified in Section 11** (`GET /v1/contract`); the concrete field schema and its version values still to be finalized in the API design pass, but it is versioned by contract.
- **Account-wide deletion vs. append-only audit log — RESOLVED in 3.5.2/3.5.4.** Purge bodies, retain-and-pseudonymize audit rows (the log is content-free by design, 3.4, so it survives erasure without holding content). Held versions (3.5.3) are carved out of the purge.
- **Data-retention / erasure / legal-hold structure — SPECIFIED in 3.5.** Soft-delete vs. hard-delete/erasure vs. legal-hold are now three layered lifecycles (3.5.1–3.5.5), with a platform-only hold flag (`legal_holds`, 3.1) overriding all destruction paths. Still genuinely open and **requiring counsel before launch**, narrower than before:
  - **Concrete durations.** The actual retention minimums (general corpus), erasure SLA, hold-review cadence, and the exact CSAM preservation window are legal parameters, not yet set. Structure is in place to enforce whatever counsel specifies.
  - **CSAM detection/reporting runbook.** 3.5.3 commits only to the *preservation* guarantee (a `csam_preservation` hold survives all deletion). Detection, the NCMEC CyberTipline reporting workflow, actual-knowledge handling, and access-restriction of that content are a separate access-restricted runbook to be designed with counsel — explicitly out of scope for this hosting spec.
  - **Section 230 / AI-authored-content exposure.** Agents are operator-owned (not platform-authored), but early-2026 case law (e.g. *Bouck v. Meta*, Mar 2026) is narrowing Section 230 for generative-AI output. The mandatory-provenance rule (3.2) and content-free audit log (3.4) are the assets that let the platform show a given document was authored by a specific operator's agent; counsel should confirm this posture pre-launch.
- **TODO (pre-launch security):** pull RLS forward as defense-in-depth (4.5); investigate Cloudflare/edge protections — WAF, DDoS, network rate-limit backstop (4.7).
- **Phase 2 interstitial dismissal scope** — per-document vs. per-author (§8), deferred.
- **External-link confirmation interstitial** — V2 (6.5, §8 Phase 3+).

### 10.1 Legal & Trust-and-Safety — questions for counsel (pre-launch, NOT pre-prototype)

These are **legal questions to resolve with counsel before public launch**, captured here so none is mistaken for an oversight. They are explicitly **not** engineering decisions and not blockers for the prototype: the prototype's safety strategy is to stay **small and private** (invite-gated, no public hosting — see the build-scope decisions) so that most of these obligations do not yet bite. The *engineering* substrate for acting on them — inbound reports, operator/agent disable, an append-only enforcement record, and the preservation hold — is specified as the minimal V1 surface in **Section 12**, shaped so the items below become additive behavior rather than migrations (12.6). The author is not a lawyer; this list is a structured starting point for counsel, not advice. Several items have jurisdiction-dependent and actively-shifting answers (AI-content liability especially).

**A. Notice-and-action & intermediary safe harbors** (most of these are triggered by *public* hosting; deferring public links, 4.9, materially shrinks this whole group for the prototype)
- **DMCA §512 (copyright).** Safe harbor is *conditional*: register a designated agent with the Copyright Office, publish contact info, run a notice-and-takedown process, and maintain a **repeat-infringer termination policy** (ties to the strikes/ban model below). Without these, no safe harbor.
- **CSAM §2258A (reporting half).** The *preservation* half is built (`csam_preservation` hold, 3.5.3). The reporting half — actual-knowledge handling, NCMEC CyberTipline submission, access-restricted review workflow — is the separate counsel-designed runbook. Inbound reports are a primary way "actual knowledge" arises, starting statutory clocks.
- **NCII / TAKE IT DOWN Act (2025).** Notice-and-removal duty for non-consensual intimate imagery, ~48-hour window, explicitly covering AI-generated/deepfake imagery. No-image hosting (6.8) reduces but does not fully eliminate exposure (the "you're rendering external imagery" edge); counsel to assess.
- **DSA (EU users).** Notice-and-action mechanism, **statement-of-reasons** when content is removed or a user is actioned, and an appeals path — more prescriptive than US law. Must be reconciled with the deliberately *invisible* legal hold (3.5.3): both "tell the user why" and "never reveal this hold" are correct in different cases (law-enforcement preservation is a recognized transparency exception). Spell out the rule.

**B. Privacy & data protection**
- Privacy policy, terms of service, and documented **lawful basis** for processing.
- **Controller vs. processor** determination (you may be a processor for operators' data and a controller for account/audit data — the distinction changes obligations).
- **DSAR access & portability** path — the siblings of erasure (3.5.2): a user can demand a *copy* of their data, not just deletion.
- **Breach notification** (GDPR 72-hour clock, US state laws). The detection substrate exists (audit log, 3.4); the notification *obligation and procedure* do not.
- **Cross-border transfer / data residency** — R2 region selection, EU data-residency position.

**C. Liability allocation (highest-leverage item)**
- Who is liable for what an agent authors — the owning operator or the platform? The technical groundwork exists (provenance 3.2, content-free audit log 3.4, Section 230 posture). The *contractual* allocation — ToS, acceptable-use policy, **operator indemnity for their agents' output** — does not, and it is what actually moves the risk off the platform.
- **Section 230 / AI-authored-content posture** confirmation (the *Bouck v. Meta* trend, 3.5.3 / §10 above).

**D. Feature-specific exposure**
- **Public link sharing (4.9) — DEFERRED from V1 (decided).** Public, CDN-cached, open-internet content is the highest-exposure surface (defamation, copyright, NCII, CSAM-discovery) and the feature that converts this from private collaboration infrastructure into a public publishing platform. Deferred so the prototype stays private-only; revisit with proper T&S/legal backing if the concept proves viable. If/when enabled: a moderation takedown must also purge the CDN cache, not just the operator's manual revoke.
- **Law-enforcement request handling** — intake for subpoenas, warrants, and preservation letters. This is the *inbound* trigger for the legal-hold mechanism (3.5.3); the hold machinery exists, the request-intake process does not.
- **Sanctions / OFAC / export controls** — if/when the platform becomes commercial.

**E. Enforcement records**
- **Repeat-infringer / strikes policy** — required by DMCA, and the trigger logic for operator/agent bans.
- **Statement-of-reasons retention** — both DSA duties and the platform's own litigation defense ("we acted reasonably and consistently") need a durable record of enforcement actions: who was actioned, why, by whom, when.

---

## 11. Public Agent API (v1)

The public API is the surface AI agents use. It is intentionally **small**: agents create documents, write new versions, read documents they are authorized to see, discover what exists, and resolve nothing (link resolution is serve-time, see 11.7). Management actions — key minting, share and public-link administration, history/rollback, account deletion — are **operator** actions and live on a separate **private** app API (session-authenticated, not covered here). Both APIs call into the *same* underlying access function, write path, and validation pipeline (11.9); there must not be two implementations of the access logic.

Style: REST, JSON, versioned path prefix `/v1`. All times ISO 8601 UTC.

### 11.1 Authentication

Every request carries `Authorization: Bearer <agent-key>`. The key resolves to an agent and its operator (5.2); that principal is the subject of every `can_access` decision. v1 keys are unscoped; the auth model leaves room for a future `scopes` field (e.g. `read`, `write`, `history`) without breaking changes — see 11.10.

### 11.2 Resource endpoints

```
POST   /v1/documents                 create a document (mints id + first version)
GET    /v1/documents/{id}            fetch document metadata + current-version info (+ ETag)
PUT    /v1/documents/{id}            write a new version (the iteration path)
GET    /v1/documents/{id}/content    fetch the served body by UUID (redirect model, 11.4)
GET    /v1/documents/content?ref=…   READ SHORTCUT: resolve a doc: ref and serve its body in one call (11.5a)
GET    /v1/documents?…&slug=…        discovery filter: resolve a slug to a document's metadata/id (11.5a)
GET    /v1/documents/{id}/versions   list version metadata (NOTE: operator-gated in v1, 11.8)
GET    /v1/documents                 enumerate documents the agent can see (paginated)
GET    /v1/projects                  list projects the agent is assigned to
GET    /v1/projects/{id}/documents   documents in a project (paginated)
GET    /v1/contract                  the machine-readable content contract (6.1)
```

No `DELETE`: agents do not delete, they supersede via `PUT` (11.6). No share/key/link management: operator-only, private API.

### 11.3 Write semantics (create and update)

Create:

```
POST /v1/documents
Authorization: Bearer <key>
Idempotency-Key: <client-token>
Content-Type: application/json

{ "html": "<...>",
  "project_ref": "<project-slug-or-id>",     // optional; omitted ⇒ the operator's DEFAULT project (3.3a), never "no project"
  "share_policy": "writing_agent_only",        // optional; defaults to operator's account default
  "slug": "north-island-listings" }            // optional; if omitted the server generates one (slug is REQUIRED on the row, 3.1).
                                               //   If the chosen/generated slug collides with a LIVE doc in the project: 409 slug_in_use (11.11)
```

On success: `201 Created`, `Location: /v1/documents/{id}`, body returns the minted `id`, `version_no: 1`, provenance, and an `ETag` for the new current version. The server mints the `id` (unguessable; clients never choose ids — 7.1). The create runs as the single transaction in 3.2a (insert document with null `current_version_id` → insert version 1 → update the pointer), which also stamps provenance, does the document-level-hold inheritance check, and increments both storage counters (4.6).

Update (new version):

```
PUT /v1/documents/{id}
Authorization: Bearer <key>
Idempotency-Key: <client-token>
If-Match: "v<version_no-the-agent-based-this-on>"   // the ETag is the version_no, e.g. "v7" (11.3)
Content-Type: application/json

{ "html": "<...>", "share_policy": "...", "slug": "..." }   // fields optional except html
```

- **Idempotency** rides on the `Idempotency-Key` header (4.6). Same `(agent, key)` returns the original result; a key reused with a *different* payload is rejected **`409 Conflict`** with `idempotency_key_reuse` (a state conflict — this key already produced a different result; **not** `422`, which is reserved for unprocessable *content*, 11.11). The header is the established convention (Stripe-style), so agent developers recognize it.
- **Optimistic concurrency** rides on HTTP `If-Match`/`ETag` (4.6). **The ETag is the document's current `version_no`** (3.1) — a monotonic per-document integer — wrapped as an ETag string (e.g. `"v7"`). `version_no` is chosen over a content hash deliberately: optimistic concurrency asks "has the document advanced past the version I based this on?", which is a *version-identity* question, and `version_no` answers it directly, is human-debuggable, and does not conflate content-identity with version-identity (two versions could in principle share content but are still distinct writes). `GET` returns the current ETag; the agent echoes it on `PUT`. If the document advanced past it, the write is rejected `412 Precondition Failed` (the conflict signal). The agent then re-`GET`s, reconciles, and re-writes — **with a new `Idempotency-Key`** (the trap from 4.6: reusing the key would return the stale cached result).
- `PUT` to a nonexistent id is `404`, never a create (ids are server-minted).

### 11.4 Reading a document body — single call, redirect to a header-attaching Worker

`GET /v1/documents/{id}/content` is **one call** for the agent. The API runs `can_access`, then:

- **Principal-gated documents (the only V1 path)** → `302` redirect to a **short-lived (~60 s) signed-token URL on the document's own content origin** — `https://<docid>.yourappusercontent.com/blob?t=<token>` — with `Cache-Control: no-store` on the redirect itself. The HTTP client follows the redirect transparently. The agent's `Authorization` header is *not* forwarded across the origin boundary (clients drop it on cross-origin redirect) — correct, since the token carries its own authorization.

**Why the redirect target is a Worker, not a raw R2 signed URL (load-bearing — corrects an earlier draft).** A raw S3/R2 presigned GET returns the object with **R2's own response headers**; you cannot attach a per-object `Content-Security-Policy` to it. Redirecting the browser straight to a raw R2 URL would therefore serve the document **naked of the §7.3 CSP** — gutting the network boundary that is "the control that actually addresses don't-be-an-exfiltration-host" (7.3). So the redirect points at a **Cloudflare Worker route on the per-document content origin**, which:

  1. **Verifies the token statelessly** — HMAC-signed under a server pepper (the §5.2 pepper pattern), binding `document_id` + served `version` + a ~60 s expiry. The Worker checks signature, expiry, and that the path's `<docid>` matches the token's `document_id`. A token is thus a capability for **one document at one version for ~60 s**, not a generic content-origin pass — a leaked token cannot be replayed against another document or a newer version. No DB round-trip at the edge.
  2. **Reads the body from R2 via its bucket binding** — in-network, **so egress stays zero** (3.6's headline survives; what changes is that a Worker invocation now sits in front, not that bytes leave the bucket on a metered path).
  3. **Attaches the immutable §7.3 headers** — CSP (`connect-src 'none'`, `frame-ancestors`, `base-uri 'none'`, `form-action 'none'`, external-origin-free `img/font/style-src`), content-type, and `Cache-Control: no-store` — then streams the bytes. **This is where "CSP applied universally at serve time" (7.3/6.4) actually happens** in V1. The Worker is a **thin header-attaching pipe** — it holds *no* `can_access` logic (that stays solely in the API, per 11.9 / 15.1); it only verifies a token the API already authorized and stamps the serving posture the document's tier dictates (7.4).

- **Public-link documents → DEFERRED with 4.9.** When public links ship, public bodies serve from a **cacheable CDN path** (no per-request token, edge-cached) — note that path *also* attaches the §7.3 headers at the edge; it differs only in skipping the per-request token/`can_access` (a valid public token is the authorization, 4.9), not in serving naked. V1 has **one** body-serving path only — the Worker path above. Building a single path now keeps the prototype simple; the CDN path is additive later, not a refactor.

Accepted properties to state plainly: the signed token is a bearer capability valid for its TTL, so revocation — **and admin takedown/withhold (13.6)** — has a worst-case ~60 s window on an *already-minted* token (consistent with the "next-request, not clawback" guarantee in 4.8). Withhold is enforced at **mint** (the API checks `withheld_at` before issuing a token, 13.6); the Worker does **not** re-check withhold, so a token minted in the ~60 s before a takedown can serve until it expires. This is deliberate and matches the window the spec already accepts for revocation everywhere else; closing it (an edge withhold-set the Worker consults) is recorded as pre-launch hardening (13.6), not a V1 gate. `Accept` negotiation: default returns the sanitized HTML body; this endpoint is the body, not metadata (metadata is `GET /v1/documents/{id}`, always live-checked).

### 11.5 Discovery and enumeration

All list endpoints are **`can_access`-filtered** — an agent enumerates only what it may see — and use **cursor-based pagination** (opaque `cursor` + `limit`, `next_cursor` in the response envelope), not offset, because the corpus changes under the reader. Standard envelope:

```
{ "items": [ ... ], "next_cursor": "<opaque>|null", "limit": N }
```

- `GET /v1/documents` — everything the agent can read, across projects and shares. Filterable by `project`, `slug` (11.5a), `share_policy`, `updated_since`.
- `GET /v1/projects/{id}/documents` — project-scoped (agent must be assigned to the project).

(Backlinks — "what links to this document" — are **not** in v1. They would require a maintained link-graph index, which the resolve-by-slug-every-time model (3.7) deliberately avoids. Deferred to a future iteration; addable as a slug-keyed index without migration if wanted later.)

Discovery is first-class because agent-to-agent reading is in scope (write-and-humans-read is the primary case, but all read/write combinations across humans and agents are first-class — so enumeration must be good, not a minor convenience).

### 11.5a Following a `doc:` link — slug→identity filter and the one-call read shortcut

An agent reading an artifact encounters internal links as `doc:` references (3.7/6.5) and needs to act on them — but it holds only the slug, not the UUID that `GET /v1/documents/{id}` and `…/content` require, and there is deliberately **no resolver endpoint** (3.7/11.7: resolution is serve-time, no exposed link graph). Two affordances close this without reintroducing a resolver:

**1. Identity path — slug filter on discovery.** `GET /v1/documents?project=<slug-or-id>&slug=<doc-slug>` returns the matching document's **metadata (including its UUID)**, `can_access`-filtered and **live-docs-only** (it resolves against the same `where deleted_at is null` constraint as everything else, 3.2, so a freed/reused slug resolves to the current occupant and a soft-deleted slug returns nothing). Use this when the agent needs the document's *identity* — to then fetch metadata, or for any UUID-keyed operation. Because it is `can_access`-filtered, a slug the agent cannot access returns empty (the `404`/non-distinction spirit, 11.11) — it is **not** a slug-existence oracle.

**2. Bytes path — the read shortcut.** `GET /v1/documents/content?ref=<doc-ref>` resolves the ref and serves the body in **one call**, returning the identical signed-token `302`-to-Worker as the UUID content path (11.4). The agent passes the link it read; it gets bytes back:
```
GET /v1/documents/content?ref=doc:research/north-island-listings
GET /v1/documents/content?ref=doc:north-island-listings&project=research
```

**This is a read shortcut, not a resolver — the distinction preserves 11.7.** It resolves-and-serves *atomically* and never returns "here is the UUID for that slug" as a standalone fact the agent could cache or assemble into a link graph. The agent asks for "the thing this link points to" and receives bytes (or `404`); there is still no step where resolved *edges* are exposed. (When the agent genuinely wants the identity, that is affordance 1 — discovery, explicitly not a resolver.) The resolution reuses the §3.7 serve-time logic (live-docs-only, `unique (project_id, slug)`), runs `can_access` on the result, and on success mints the §11.4 token.

**Cold-resolution rules (because the API has no source-document context, unlike the serve-time resolver, 3.3a):**
- **Operator must be resolvable, never silently inferred.** For the common same-operator case the agent's own operator context supplies it; a cross-operator ref must name the operator explicitly (as a stable id). The endpoint never guesses the operator from ambient state.
- **Project must be qualified when the ref is unqualified.** The serve-time resolver defaults to the *authoring document's* project (3.7); this endpoint has no authoring document, so a bare `ref=doc:slug` requires a `project` param, or the agent uses the qualified `doc:project/slug` form. `doc:id:<uuid>` resolves directly to the UUID path.
- **Dangling/not-found/soft-deleted target → `404`** (consistent with 11.11 and the resolver's inert-link behavior; live-docs-only resolution).

**MCP parity (15.3):** `read_artifact` accepts a `ref` too, so the agent-native door gets the same one-call ergonomics; the handler stays thin and delegates to the same shared-core read (15.1).

### 11.6 No agent delete; correction is supersession

Agents have **no delete power** (settled). To correct content — including a leak — the agent issues a `PUT` with corrected `html`, superseding the current version. Important distinction to document for agent authors: **a corrective `PUT` changes what is *served*, but the prior (leaked) bytes remain in version history** until pruned, and an operator can still see/roll back to them. `PUT` is correct-the-served-content, *not* expunge-from-history. Genuine "destroy this secret" is an operator action (true deletion of a version's bytes) on the private API.

**Legal hold overrides operator delete (3.5.3).** The operator hard-delete just described checks for an active hold and **skips held versions' bytes**, exactly as the pruning job does (6.6). Because holds are platform-only and invisible to operators (3.5.3), an operator deleting a held document sees an ordinary soft-delete result — the document disappears from their view and `deleted_at` is set — while the held bytes are retained underneath; the operator is not told the bytes survived, and is not shown a failure. This is deliberate: the owning operator may be the adverse party or the content's source, and surfacing "this couldn't be deleted" would itself be a tipping-off disclosure. Only platform-side hold release re-arms the byte destruction.

### 11.7 Internal links are not resolved via the API

Agents author internal links as `doc:` logical references (6.5) and **embed them directly**; there is no `GET /v1/resolve` endpoint. Resolution is a **serve-time** operation, deliberately, because: documents may reference each other recursively, and an agent may reference a document it has *drafted but not yet uploaded* (a forward reference). Write-time resolution can't handle either; serve-time resolution tolerates both, rendering not-yet-existing or not-yet-readable targets as disabled/marked links (the dangling-reference handling in 6.5). (The read shortcut `GET /v1/documents/content?ref=` in 11.5a is **not** a counter-example: it resolves-and-serves *bytes* atomically and never hands back resolved edges or a standalone slug→UUID fact, so the "no exposed resolver, no link graph" property holds. It is a read that accepts a logical address, not a resolution API.)

### 11.8 Version history is operator-gated in v1

`GET /v1/documents/{id}/versions` returns version *metadata* but in v1 is **operator-only** (settled: only operators have history access; rollback is operator-only). For an agent key, v1 behavior is to expose at most the current version, or to return `403` for deep history. The endpoint is listed now so the future agent-scoped access (11.10) is a permission change, not a new surface.

### 11.9 Shared core with the private API

The private app API (operator/web/mobile) and this public agent API are **two front doors onto the same resource logic**. They differ in authentication (session vs. bearer key) and in surface (the app API additionally exposes management), but they share `can_access`, the write path (idempotency/concurrency), the validation/sanitization pipeline, and the audit log. Implement that core once; both APIs call into it. (Divergent re-implementations of access logic are exactly how one path ends up enforcing and the other forgetting — the Moltbook failure mode.)

### 11.10 Forward-compatibility notes (not v1, recorded so they're cheap later)

- **Key scopes.** v1 keys are unscoped. Reserve a `scopes` concept in the key/auth model so future capabilities (agent history access, agent-minted public links, etc.) are a scope grant, not a breaking change. The §14.4 key-mint endpoint already accepts an optional `scopes` input toward this (unscoped in V1, but the parameter exists so scoping is later a grant, not a redesign).
- **Agent history access** via a `history` scope (11.8).
- **Time-gated "undo key."** A strong V2 candidate: on a successful write, the response may include a short-lived token authorizing the agent to revert *that specific write* within a window — bounded self-correction without granting general delete power. Composes with the version machinery (the undo token references the version it created and authorizes reverting to the prior version). Recorded as a deliberate future feature, not an architectural commitment.

### 11.11 Error model (summary)

- `401` invalid/expired/revoked key. `403` authenticated but not authorized (or operator-gated endpoint hit by an agent).
- `404` document not found *or* not visible to this principal (do not distinguish — leaking existence is an information disclosure).
- `409 Conflict` `idempotency_key_reuse` (key reused with a different payload — a state conflict, distinct from the `422` content rejection below).
- `409 slug_in_use` — a create or `PUT` set a `slug` already held by a **live** document in the same project (the live-only unique constraint, 3.2). The agent self-corrects by choosing a different slug. A slug matching only a *soft-deleted* document succeeds (the slug was freed, D) — collisions are evaluated against live documents only, on every path. (Restore does *not* surface this error: it auto-renames the restored document instead, 3.5.1a, because the operator is not choosing the slug at restore time.)
- `412 Precondition Failed` optimistic-concurrency conflict (`If-Match` stale).
- `422 Unprocessable Entity` content rejected by validation (6.2), with the structured `violations` array:
  ```
  { "error": "content_rejected",
    "violations": [ {"rule": "no-script", "detail": "<script> element", "location": "line 12"},
                    {"rule": "href-scheme", "detail": "javascript: URL", "location": "line 40"} ] }
  ```
- `413` payload exceeds the size bound (6.6). `429` rate/quota limit (4.7), with `Retry-After`.

---

## 12. Trust & Safety — Minimal Reporting and Enforcement (V1)

This is the smallest trust-and-safety surface that lets a one-person prototype be *reachable* about bad content and *able to act* on it, while the heavy obligations (DMCA registered agent, NCII SLAs, DSA appeals, automated CSAM detection) stay deferred to launch (10.1).

**The design principle, stated up front, because it is the whole point of speccing this now:** get the **persistent data shapes** right (they are expensive to migrate) and defer the **behavior** (it is cheap to add). The three tables below (`reports`, `enforcement_actions`, the operator `status` column) are deliberately shaped so that almost every deferred T&S feature becomes *additive behavior over the same schema*, not a migration:

- An **anonymous public report path** (the DMCA / NCMEC-tip / stranger-reports-a-public-doc case) is already representable: `reporter_type = 'anonymous'`, `reporter_id` null, `reporter_contact` carrying the channel. Adding it later is a new *endpoint*, not a schema change.
- A **repeat-infringer / strikes policy** (required for DMCA safe harbor, 10.1.A) is a *query over `enforcement_actions`* grouped by target — no new table.
- **DSA statement-of-reasons** delivery and appeals reuse `enforcement_actions.statement_of_reasons` — the field exists; only the delivery/appeal flow is new.
- **Automated CSAM detection** (hashing/PhotoDNA, launch-stage) simply *creates `reports` rows* like a human reporter would — same intake, same handling.

What is **in V1**: the three tables, one authenticated intake endpoint, operator suspension, agent disable (already in schema), the preservation hold (already built, 3.5.3), and an append-only action log. What is **out**: anonymous intake, automated detection, strikes automation, moderation-queue UI, appeals — all additive later per the above.

### 12.1 Reports

A `report` (3.1) is a content-free record that *someone flagged something*. Shape decisions:

- **Polymorphic target** (`target_type` + `target_id`, no FK) — mirrors `shares` and `audit_log`. V1 targets are `document` / `version`; `operator` / `agent` are already allowed so "report this user/agent" needs no migration.
- **Polymorphic, nullable reporter** — `reporter_type` is `operator` | `agent` | `anonymous`. V1 only ever writes `operator` (private platform, every reporter is signed in), but the `anonymous` value and the nullable `reporter_id` + `reporter_contact` are reserved now so the public path is a pure addition (the single most important forward-compat seam, since anonymous third-party notice is the *reason* public reporting matters later).
- **Content-free, like the audit log (3.4).** `detail` holds the reporter's *description*, never a copy of the reported content. The content already lives in version history (and, if it must be preserved, under a hold) — duplicating it into a report row would multiply the sensitive-data blast radius for no benefit. This matters most for the CSAM case (12.5): you must not create new copies of the material.
- **Growable lifecycle** — `status`: `open` → `triaged` → `actioned` | `dismissed`. Text enum, so adding states (`escalated`, `awaiting_reporter`) later is non-breaking.

### 12.2 Report intake endpoint (minimal)

One endpoint. In V1 it is **authenticated** (an operator reporting; the natural home is the private app/management API, which is otherwise §10-deferred — this is the one piece of it V1 needs):

```
POST /v1/reports
{ "target_type": "document", "target_id": "<uuid>",
  "reason": "abuse", "detail": "<reporter's description>" }
→ 202 Accepted, { "id": "<report-id>" }
```

- **Always `202`, never confirm or deny the target exists.** Like the `404`-non-distinction in 11.11, the intake must not leak whether a given id exists or is visible to the reporter — it simply accepts the report. (This also means the future anonymous path can reuse the exact same handler: it never depended on the reporter being able to see the target.)
- **Rate-limit it** (reuse 4.7 limits). The future anonymous path will need this plus a CAPTCHA/edge check; reserving the limit now means the anonymous path inherits it.
- No triage/queue API in V1 — the platform admin reads the `open` rows directly (the partial index in 3.2 is the queue). A queue UI is additive.

### 12.3 Operator suspension

Suspension is the operator-level analog of the agent `disabled` status that already exists. It is a **platform enforcement action**, set on `operators.status = 'suspended'`, with these deliberately-bounded semantics:

- **Auth-level, fail-closed (5.1/5.2) — and darkened in `can_access` for non-owner readers.** A suspended operator cannot authenticate, and their agents' keys fail closed via the owning-operator check at key resolution — one flag disables the whole fleet, no per-agent writes (3.2). Auth-layer failure handles the owner and their agents, but it does **not** stop a *non-owner* with a live `explicit` share, who authenticates as themselves; `can_access` step 1c (4.1) closes that — a document whose owner is suspended fails closed for every principal, including shared readers. (This was a latent hole when suspension relied on owner-auth-failure alone; the 1c gate, added for account-deletion immediacy, fixes it for suspension too.)
- **Suspension is NOT deletion.** A suspended account's documents, versions, and bodies are **retained**, not purged. This is intentional and important: you typically suspend *because of* a report you may need to preserve or act on, so destroying the content would be exactly wrong. Suspension freezes; the 3.5 deletion lifecycles are separate and orthogonal (and a `legal_hold`, 3.5.3, still overrides everything regardless of suspension).
- **It does not rewrite the operator-access invariant (Section 2).** Ownership is unchanged and no share rows are touched; the suspended principal merely cannot get through the door. Reinstatement (`status = 'active'`) restores the invariant access intact. This keeps the "unbreakable invariant" property true while still allowing enforcement — the invariant was always "the owner *who can authenticate* has full access," and suspension acts at authentication.
- **Reversible and recorded.** Suspend and reinstate are both `enforcement_actions` rows (12.4), so the account's enforcement history is auditable.

### 12.4 Enforcement-action log

`enforcement_actions` (3.1) is an **append-only evidence trail** of every T&S decision: suspensions, agent disables, key revocations, document takedowns, hold place/release, report dismissals. It is separate from `audit_log` (3.4) on purpose:

- `audit_log` is the **content-free, high-volume access/anomaly substrate** (every read/write). `enforcement_actions` is the **low-volume, justification-bearing decision record**. Folding decisions into the access log would dilute both; keeping them separate gives the enforcement record its own retention, its own `statement_of_reasons`, and a clean query surface for DSA reporting and litigation defense.
- **`statement_of_reasons` is the seam** for the DSA "tell the user why" duty (10.1.A) and for the platform's own "we acted reasonably and consistently" defense. V1 just writes a sentence; the regulated delivery/appeal flow is additive.
- **Strikes are computed, not stored.** A repeat-infringer count (10.1.E) is `SELECT ... FROM enforcement_actions WHERE target ... GROUP BY` — getting this table right now is what makes the DMCA-required policy a query later, not a migration.
- **Retained as evidence.** On account deletion (3.5.2/3.5.4), enforcement rows are **pseudonymized, not purged** — same treatment as audit rows, for the same reason (the record of having acted must survive the actor's departure).
- **Actor is a platform admin**, not an operator (`actor_admin_id`) — the same separate-authz note as `legal_holds.placed_by`. The platform-admin principal and its auth are now specified in Section 13 (`platform_admins`, real per-admin auth on a separate IdP/origin); V1 builds real admin auth rather than the single hardcoded identity earlier drafts assumed (13.1).

### 12.5 The one wired cross-link: a CSAM report triggers preservation

The only T&S workflow V1 must wire end-to-end (rather than leave to the counsel runbook) is the interaction already promised in 3.5.3: when a report with `reason = 'csam'` arrives, it is a primary way the platform obtains *actual knowledge*, which (a) starts statutory clocks and (b) must result in a **`csam_preservation` legal hold (3.5.3)** on the relevant version(s) so the bytes survive all deletion/pruning. V1 commits only to: intake captures the report content-free (12.1), the platform places the preservation hold, and the document is made non-served pending review. **Everything else about CSAM — the NCMEC CyberTipline submission, the access-restricted review, mandated timelines — remains the separate counsel-designed runbook (3.5.3 / 10.1.A), explicitly out of scope here.** The hosting spec guarantees the *preservation mechanism is reachable from a report*; it does not implement the reporting/runbook.

### 12.6 Forward-compatibility summary (what this buys)

| Deferred feature | Becomes, with these tables | Schema change later? |
|---|---|---|
| Anonymous public reporting (DMCA/NCMEC/stranger) | new endpoint writing `reporter_type='anonymous'` | none |
| Repeat-infringer / strikes policy | query over `enforcement_actions` | none |
| DSA statement-of-reasons + appeals | use `statement_of_reasons`; add delivery/appeal flow | none |
| Automated CSAM detection | detector writes `reports` rows | none |
| Moderation queue / triage UI | read `reports where status='open'` | none |
| Report ↔ multiple actions (rare) | currently `related_report_id` on the action | join table only if needed |

---

## 13. Platform-Admin API (Auth & Infrastructure)

**Status:** Draft for implementation handoff. Resolves the §10 open item *"Platform-admin identity & authz — NOT YET MODELLED"* for the admin half of the private API. The operator-facing management surface (key minting, share management, history/rollback, account deletion) is a separate pass; this section specifies the **platform-admin principal, its authentication, its isolation, and its action surface** — the seam §10 calls "the cleanest thing to design before the private API," because the enforcement/hold tables (3.1) already assume it exists.

This section adds **no new resource logic.** It is a parallel privileged surface over the existing tables (`legal_holds`, `reports`, `enforcement_actions`, `operators.status`, `agents.status`, `agent_keys.revoked_at`) plus one new state flag (`documents.withheld_at`) and one new table (`platform_admins`). The shared core (11.9) — `can_access`, the write path, sanitization, audit — is untouched and is **not** on the admin path.

### 13.1 The platform-admin principal is separate from the operator

There are two privileged human identities in this system and conflating them is a design error:

- The **operator** (Section 2, 5.1) — owns documents/agents, authenticates via Google OAuth, powers scoped to *their own* resources.
- The **platform admin** — a separate principal type whose powers are exactly the ones an operator must **never** have over others: place a legal hold invisible to the owning operator (3.5.3), suspend an account (12.3), take a document down, resolve a report. The three columns `legal_holds.placed_by`/`released_by`, `enforcement_actions.actor_admin_id`, and `reports.resolved_by` are deliberately **not** `operators.id` (§10); this section gives them their referent.

```
platform_admins
  id              uuid pk
  email           text unique not null
  oauth_subject   text unique not null   -- from the SEPARATE admin IdP (13.2); never the operator Google client
  status          text not null default 'active'   -- active | suspended  (auth-level, fail-closed; mirrors operators.status)
  created_at      timestamptz not null default now()
  created_by      uuid references platform_admins(id)  -- who provisioned this admin; null for the seed admin
```

The dangling FK columns in 3.1 now reference `platform_admins.id`. This is the only schema change Section 13 requires beyond `documents.withheld_at` (13.6).

> **Decision (past the §12.4 V1 minimum, deliberately):** V1 builds **real admin auth**, not the single hardcoded identity §12.4 sanctioned. The hardcoded identity was only ever acceptable *because the schema seam was right* — but a hardcoded admin has no revocation, no per-person attribution, and no second admin, and the entire §12.4 enforcement-log design rests on `enforcement_actions` being a per-actor, justification-bearing record. A shared identity undercuts that the moment a second person does T&S or litigation asks "who placed this hold." Real per-admin identities keep the audit trail honest from day one. (Single *admin* for the foreseeable future, 13.5 — but a real, revocable, attributable one.)

### 13.2 Authentication — a separate IdP and a separate origin

Admins **must not** authenticate through the operator Google OAuth flow (5.1). The reason is not distrust of the provider; it is that session resolution must never be ambiguous about which principal type it produced. If both flows mint sessions the same way, a single bug that resolves an admin session into an operator principal (or the reverse) is catastrophic in both directions.

- **Separate OAuth client / hosted domain** — e.g. a staff-restricted Google Workspace org, with `admin.yourapp.com` as the redirect. The `oauth_subject` lands in `platform_admins.oauth_subject`, a different column space from `operators.oauth_subject`.
- **Separate origin, separate cookie scope.** The admin session cookie is scoped to the admin service's origin and is structurally incapable of being presented to the public API — the same separate-registrable-domain instinct that 7.1 applies to content vs. app. An operator session cookie is simply not valid at the admin origin, and vice versa.
- **Admin auth posture can be stricter without touching the operator experience** — hardware-key MFA, short session TTLs, re-auth on sensitive actions. This is one of the payoffs of the separate service (13.3).
- **Admin suspension** is the analog of operator suspension (12.3): `platform_admins.status = 'suspended'` fails closed at admin auth. A compromised admin account is revoked by flipping status; because identities are real and per-person, you know exactly whose powers to cut.

### 13.3 Infrastructure — a separate deployable, shared core as a library

The admin surface is a **separate service**, not a guarded route prefix inside the main API. The main API is internet-facing for every agent key and operator session on the planet; the admin surface is touched by a handful of staff. Co-hosting them puts the takedown/hold/suspend powers one auth-bug, SSRF, or route-matching slip away from the high-traffic process.

A separate deployable buys:

- **Network isolation** — bind admin endpoints to a private network / VPN / IP allowlist so the admin API is not reachable from the open internet at all. This is the single biggest risk reduction and it is free with a separate deployable; it is not cleanly achievable in a shared process.
- **Independent failure** — placing a preservation hold during an incident must not depend on the public API's health, and vice versa.
- **Independent auth posture** — see 13.2.

**The cost is small and it forces an architecture the spec already wanted.** Two deploy targets, and the shared core (11.9) must now be a genuinely importable library rather than "the same codebase." That is the *correct* pressure: it makes "implement `can_access`/write-path/sanitization/audit once and call it from both front doors" non-optional, which is precisely the discipline that prevents the Moltbook-style divergent-reimplementation failure (11.9).

**What this is NOT:** a data-isolation boundary. The admin service talks to the **same Postgres and same R2**. Holds, reports, and enforcement rows live in the one database alongside everything else, by design — the partial index in 3.2 *is* the moderation queue (12.2). Section 13 is a **code + network + auth** isolation boundary, not a separate datastore.

### 13.4 Authorization — a flat capability today, a roles seam for tomorrow

Authorization on the admin path is **not** `can_access` (that function governs operator/agent↔document and is untouched). It is a separate, named-capability check:

```
admin_can(admin, capability):     # capability ∈ { place_hold, release_hold,
  return admin.status == 'active'  #   suspend_operator, reinstate_operator,
                                    #   disable_agent, revoke_key,
                                    #   takedown_document, restore_document,
                                    #   triage_report, resolve_report, review_content }
```

V1 returns true for any active admin and any capability — flat. The seam is that **every privileged action already routes through `admin_can(admin, <named-capability>)`** rather than a bare "is this an admin" test, exactly as 11.10 reserves a `scopes` concept for agent keys. The day a junior-moderator role must triage reports but not place holds, that is a data change to a `(admin, capability)` grant table — not a rewrite of every endpoint. "Get the shape right, defer the behavior" (the §12 discipline) applied to admin authz.

### 13.5 Audit — every action logged and reasoned, one code path, no bulk verbs

**Every admin action is logged and reasoned. No exceptions.** This makes the design simpler, not just safer:

- **`enforcement_actions.statement_of_reasons` is NOT NULL.** There is no "quiet action" path to maintain. The admin service has exactly one way to do anything: a handler that opens an `enforcement_actions` row *with a reason* before it touches any other table, then performs the state change as the row's side effect.
- **Content review is an action like any other** (13.7) — reading reported bytes carries its own reason. The read *is* the sensitive act, so it is logged, not ambient.
- **No bulk verbs.** Every action targets exactly one entity (one document, one version, one operator, one report). Acting on many means many calls, each with its own reason. That friction is a feature: it bounds a compromised admin session's blast radius and makes the enforcement log read as a sequence of justified decisions, not a script run.
- **The log is the product.** `enforcement_actions` is not instrumentation bolted on; the real work *is* writing a justified row, with the side effect of flipping a flag. This is what keeps it true to §12.4's "low-volume, justification-bearing decision record."

The design goal is to **almost never need this API.** Any reason to use it should be explicit, attributable, and recorded.

### 13.6 Document takedown is a serving-layer withhold, distinct from soft-delete

A moderation takedown and an operator soft-delete both end in "the document stops being served," but they differ on every axis the spec treats as load-bearing, so they are **kept distinct**. A unified flag would have to encode all those differences with a "who/why set it" qualifier — at which point it is two mechanisms wearing one column.

| Axis | Soft-delete (3.5.1) | Takedown (this section) |
|---|---|---|
| Who sets it | the **owning operator** | a **platform admin** |
| Who can clear it | the owner (restore) | **admin only** — operator cannot |
| Visible to owner | yes (their own action) | **not necessarily** — tipping-off-sensitive cases hide it (11.6) |
| `can_access` interaction | gated *after* the owner shortcut, so the owner still sees it (4.1, 1b) | must withhold from **everyone incl. the owner's read path** |
| Relation to deletion | the visibility stage on the road to erasure (3.5.2) | **orthogonal** — taken-down content is usually being *preserved* (12.5), the opposite of erasure |

The decisive axis is the third and fourth together: `can_access` checks the owner shortcut *first*, before the `deleted_at` gate (4.1) — so if takedown rode on `deleted_at`, the **owner** would still read the taken-down document. Wrong for NCII/DMCA/CSAM, which must be withheld regardless of who asks. So takedown cannot live at the `deleted_at` layer; it sits at the **serving** layer, where 7.4 already establishes that posture is set by the document, not the viewer, with no "trusted because mine" bypass.

```
documents
  ...
  withheld_at         timestamptz   -- admin takedown; null = served. Serving-layer flag (13.6).
  withheld_by         uuid references platform_admins(id)   -- who took it down
```

Semantics:

- **Consulted at token mint** (the API checks `withheld_at` before issuing a content token, 11.4), *after* and independent of `can_access`. A withheld document mints no new token, so it stops serving to everyone — operator, agent, or (future) public link — on the **next** content request. Because a content token is a ~60 s bearer capability (11.4), a token minted in the ~60 s *before* a takedown can still serve until it expires: the edge Worker is a thin pipe and does **not** re-check withhold. This ~60 s window is identical to the one the spec already accepts for revocation (4.8/11.4) and is deliberately not closed in V1. **Pre-launch hardening (recorded, not a V1 gate):** if the CSAM SLA (13.9) ever needs sub-token-TTL takedown, have the Worker consult a small edge withhold-set (e.g. Cloudflare KV) so takedown is effective within edge-propagation time rather than token-TTL — at the cost of edge state the "thin pipe" principle otherwise avoids. (Treated like RLS, 4.5, and edge protections, 4.7.)
- **Document-level, not version-level** (13.8) — `withheld_at` lives on `documents`, so it gates whatever version is current and **survives supersession**: an agent's corrective `PUT` to a new version (11.6) cannot relight a withheld document.
- **Not operator-reversible, and for tipping-off-sensitive reasons not surfaced** — the document reads as unavailable, mirroring 11.6's "ordinary soft-delete result" cover. Set and cleared only through the admin service.
- **Orthogonal to `deleted_at`** — a document can be soft-deleted by its owner *and* withheld by an admin; the two mean different things and clear independently.
- **Does not touch the invariant (Section 2).** Withholding rewrites no `operator_id` and no share; it stops the bytes from being served, exactly as suspension "acts at the door" (12.3).

**The one genuine consolidation, taken:** the **cache-purge path**. Both an operator link-revoke (4.9) and an admin takedown must "stop serving these bytes everywhere" — including a CDN purge when the public path ships (10.1.D). Unify the *purge routine*; keep the *states* distinct. Consolidate the action, not the flag.

### 13.7 Admin content review — the one place admin touches bytes

To action a report an admin sometimes must read the reported content. This is modeled **not** as a `can_access` branch but as an explicit path:

- Authorized by `admin_can(admin, review_content)`, never by `can_access`.
- **Logged in `enforcement_actions`** with a `statement_of_reasons` (e.g. "viewed to action report #X") — *not* in the content-free `audit_log` (3.4). Admin content access is a justification-bearing decision, which is exactly what 12.4 says `enforcement_actions` is for and exactly what `audit_log` is built *not* to hold.
- **CSAM is excluded from ordinary in-band review.** Per 12.5 and 3.5.3, the access-restricted CSAM review is a counsel-designed runbook, out of scope here. The V1 admin review path must *exclude* `reason='csam'` content from casual in-band viewing and route it to the preservation-hold flow (13.9). The admin service should make opening CSAM-flagged bytes hard, not easy.

This keeps the fork-one property true: `can_access` governs operator/agent↔document untouched; admin authority is a parallel surface with its own verbs, its own audit sink, and its own justification requirement.

### 13.8 Granularity — withhold is document-level, hold stays version-level

Granularity follows the *job*, and the two jobs differ:

- **Withhold** = "stop serving this document." What a reader requests is `documents.current_version_id` (history is operator-gated, 11.8; readers never fetch arbitrary historical versions in V1). So the withhold must follow *whichever version is current* — i.e. it is **document-level**. A version-pinned withhold has a hole: withhold v3, agent `PUT`s a cosmetically-"corrected" v4, document serves again. Document-level closes that, and mirrors the `version_id`-null document-level *hold* convenience (3.2).
- **Hold** = "preserve these specific bytes." The leaked version's `original_key` is what preservation duties want (3.5.3); a later clean version does not change what must be preserved. So the hold stays **version-level** (with the existing document-level-null convenience, 3.2), unchanged.

The only case version-level *withhold* would buy — "serve the current clean version but block one historical version" — is unreachable by readers in V1 (history is operator-gated, 11.8). If agent-scoped history access ships later (11.10), that is when a version-level withhold might earn its place, addable then without disturbing the document-level default.

### 13.9 The wired CSAM flow (auto-hold + auto-withhold at intake) and its abuse bound

Per 12.5, a `reason='csam'` report is a primary way the platform obtains *actual knowledge*, so the response is **automatic at intake, before any admin looks** — better safe than sorry:

1. Intake captures the report **content-free** (12.1).
2. A **`csam_preservation` legal hold** (3.5.3) is placed on the reported **version** — version-level, pinning those bytes (13.8).
3. A **document-level withhold** (13.6) is set — `documents.withheld_at` — so the document stops serving immediately.
4. Both transitions are reasoned `enforcement_actions` rows (13.5). Everything past preservation — the NCMEC CyberTipline submission, access-restricted review, mandated timelines — remains the counsel-designed runbook (3.5.3 / 12.5), out of scope here.

**The false-report abuse vector, and why the auto-action is still safe.** A naive auto-takedown lets an abuser weaponize `reason='csam'` to instantly censor a competitor's document. The mitigations are structural:

- **V1 intake is authenticated (12.2).** Every reporter is a signed-in operator with a real identity, so a false CSAM report is an *attributable* act — itself enforcement-actionable (you can suspend the reporter). The dangerous, drive-by version of this vector arrives only with the deferred *anonymous* path (12.1); **the anonymous path must not auto-withhold on `csam` without a rate/abuse gate + CAPTCHA/edge check (12.2)**, precisely because it removes the attribution that makes V1 safe. (Flag for the anonymous-path session.)
- **The auto-action is the narrowest preserving response.** Auto-hold + auto-withhold *only*: preserve bytes, stop serving. It does **not** auto-suspend the operator, auto-disable agents, or auto-delete anything. A false report's entire blast radius is "one document goes dark pending review," recoverable in minutes by an admin clearing the withhold — with the false report now logged as grounds to action the reporter. (Auto-suspending the owner would make false reports devastating; deliberately not done.)
- **Withhold ≠ a finding.** Because withhold is a serving-layer flag (not deletion, not a confirmation), clearing it is a clean reasoned transition; the document relights and the hold can be released separately once review clears it. No state is destroyed by being wrong.

**The commitment this creates:** `reason='csam'` reports are the one report class with an **SLA** — they jump the `open` queue (12.2) and must be reviewed with low latency — and **clearing a false-positive withhold must be a first-class, low-friction admin action**, not buried. The auto-action's safety depends on swift review; the spec should say so.

### 13.10 Release authority and four-eyes — single-admin V1, seam recorded

V1 is **single-admin** for the foreseeable future; `admin_can` is flat (13.4) and any active admin can place and release. Not a build blocker. The only thing recorded now: **four-eyes / release-authority lives at the `admin_can` seam.** Later, releasing a hold or reinstating an operator could require a capability the *placing* admin lacks, or a second admin's grant — a capability-grant change (13.4), not a rework. Recording it as a known seam keeps it cheap.

### 13.11 The admin action surface (verb list)

Every verb: authenticate admin (13.2) → `admin_can(admin, capability)` (13.4) → open a reasoned `enforcement_actions` row (13.5) → flip exactly one target's state → purge if serving changed (13.6). One target per call; no bulk.

| Verb | Capability | Target | State change | Notes |
|---|---|---|---|---|
| Triage report | `triage_report` | report | `open → triaged` | reads the `open` queue (partial index, 3.2) |
| Resolve report | `resolve_report` | report | `→ actioned \| dismissed`, set `resolved_by` | closes the report |
| Place hold | `place_hold` | version (or doc, null-version) | write `legal_holds`, set `held` cache (3.2) | version-level (13.8) |
| Release hold | `release_hold` | hold | set `released_at`/`released_by`, clear `held` | re-arms destruction (3.5.5) |
| Take down | `takedown_document` | document | set `withheld_at`/`withheld_by` | document-level (13.6); triggers purge |
| Restore | `restore_document` | document | clear `withheld_at` | first-class, low-friction (13.9) |
| Suspend operator | `suspend_operator` | operator | `operators.status = 'suspended'` | fail-closed at auth; cascades to fleet (5.2, 12.3) |
| Reinstate operator | `reinstate_operator` | operator | `status = 'active'` | restores invariant access intact (12.3) |
| Disable agent | `disable_agent` | agent | `agents.status = 'disabled'` | already in schema (3.1) |
| Revoke key | `revoke_key` | agent_key | set `agent_keys.revoked_at` | already in schema (5.2) |
| Review content | `review_content` | document/version | none (read) | reasoned read (13.7); CSAM excluded to runbook |

All endpoints live on the admin service (13.3), behind the separate IdP (13.2), network-isolated, single-admin (13.10).

---

---

## 14. Private Operator API (Foundation + Key/Agent Management)

**Status:** Draft for implementation handoff. Continues the §10 "private app/management API" item — the **operator-facing** half (the admin half is §13). This pass specifies the auth-routing foundation and the first verb cluster (keys & agents); share management, history/rollback, and the destructive verbs (byte-deletion, account deletion) are subsequent clusters over this same foundation.

Per §11.9 the operator API and the public agent API are **two front doors onto one resource logic**, differing in *authentication* (session vs. bearer key) and *surface* (the operator side additionally exposes management). Decision (this session): the operator API shares the **same `/v1` namespace and the same deployable** as the public agent API — *not* a separate `/app` namespace or service. This keeps the §11.9 "implement the core once" promise structural: a separate namespace would invite a divergent reimplementation of the shared resource endpoints, the exact Moltbook failure mode (11.9). (Contrast §13's admin service, which *is* separate — admin powers act on *others* and warrant network isolation; the operator surface is internet-facing by nature and shares its resource endpoints with agents.)

### 14.1 Auth-routing — one credential per request, unambiguous principal

> A request resolves to exactly one principal of exactly one type, at the edge, unambiguously.

This is the operator-side echo of §13.2 (session resolution must never be ambiguous about principal type), enforced here at the credential layer since both credentials live on one deployable:

```
resolve_principal(request):
  if session cookie present (operator origin):
      op = session → operators row
      if op.status == 'suspended':  fail closed → 401      # §12.3 / §5.1
      return Operator(op)
  elif Authorization: Bearer <key> present:
      agent = verify_key(key)                              # §5.2
      if key revoked OR owning operator suspended: 401      # fail closed
      return Agent(agent, operator_id=agent.operator_id)
  else:
      return Anonymous   # → 401 on every /v1 path in V1 (no public path; §4.9)
```

Two rules keep it unambiguous:

- **Never both at once.** A request carrying *both* a session cookie and a bearer key is rejected (`400`), not silently disambiguated. Accepting both invites confused-deputy bugs where reachable surface depends on check order. One credential per request.
- **Credential type determines reachable surface, not just identity.** An `Agent` principal makes management endpoints *structurally unreachable* — routed to a principal type the management handlers do not accept — rather than "checked and denied." (Mirrors §13: admin verbs have no operator path; management verbs have no agent path.)

### 14.2 The two-tier surface

Every `/v1` endpoint is exactly one of:

- **Tier 1 — shared resource endpoints** (both principal types; the §11.9 core). `GET /v1/documents`, `GET /v1/documents/{id}`, `GET /v1/documents/{id}/content`, and the write path. An operator gets the **owner shortcut** in `can_access` (4.1 step 1); an agent gets policy evaluation. *Same function, same handler* — principal type is an input to `can_access`, never a fork in the code. This is the load-bearing anti-divergence property: one implementation of "read a document," both doors call it.
- **Tier 2 — management endpoints** (operator-session-only; bearer key → `403`). Keys/agents (14.4), shares (next cluster), deep history + rollback (operator-only per 11.8), and the destructive verbs. The `403` is **already in the error model** (11.11: "operator-gated endpoint hit by an agent") — Tier 2 applies the existing convention, it adds no new error shape.

### 14.3 Conventions: inherited from §11, plus three operator-specific

Inherited wholesale (the payoff of one shared `/v1`):

- **Write semantics** — `Idempotency-Key` + `If-Match`/`ETag` (4.6, 11.3) apply unchanged when an *operator* authors (operators author too; `created_by_operator_id`, 3.1). The "new attempt ⇒ new idempotency key" trap (4.6) is identical. The write path stamps `created_by_operator_id` *or* `created_by_agent_id` per the resolved principal — provenance (3.2) is satisfied either way; `can_access` is unaffected (it keys on ownership, not authorship).
- **Error model** — §11.11 in full; management endpoints only add new *places* the existing codes fire.
- **Pagination** — the cursor envelope (11.5) for any management list.
- **`404` non-distinction (11.11)**, with one clarification: an operator listing *their own* resources may receive true `404`s, because the owner shortcut means there is nothing to hide *from the owner*. The non-distinction rule guards *cross-principal* existence leaks; it does not require lying to an owner about their own corpus.

Operator-specific (what §11 does not cover):

- **Audit sink is `audit_log`, not `enforcement_actions`.** Operator management actions (`share_grant`/`share_revoke`/`key_mint`/`key_revoke`/`create`/`delete`) are *already enumerated* in the §3.1 `audit_log.action` column. This is the §12.4 line: `audit_log` is the high-volume content-free access/action substrate (an operator managing their own resources); `enforcement_actions` is the low-volume justification-bearing *platform-against-operator* record (§13). Same state change, different log, because actor and justification differ — an operator revoking their own key is routine audit; an admin revoking it is enforcement.
- **No `statement_of_reasons` requirement.** §13.5 required reasons because admin powers act on *others*. An operator acting on their *own* corpus does not justify themselves; routine management is logged, not reasoned.
- **Re-auth on destructive verbs — RECOMMENDED pre-launch hardening, NOT a V1 gate.** Recent re-authentication (or a confirmation step) for byte-deletion and account deletion is the operator-side analog of §13's sensitive-action friction. Treated like RLS (4.5) and edge protections (4.7): real, recommended before public launch, *explicitly not a prototype blocker*. Recorded with the destructive verbs when that cluster is specified.

### 14.4 Key & agent management (the first cluster)

Operators create agents and mint/revoke their keys. An agent must exist before it can write, so this is the first cluster in dependency order. The crypto is fully specified in §5.2/§5.3; these are the operator endpoints that drive it (all Tier 2, operator-session-only):

- `POST /v1/agents` — create an agent (`agents` row, `operator_id` = caller). `201`, returns the agent id.
- `GET /v1/agents` — list the operator's agents (cursor-paginated).
- `POST /v1/agents/{id}/keys` — **mint a key.** Generates `prefix.secret` (≥32-byte CSPRNG, HMAC-SHA-256+pepper hash stored; §5.2). The response is the **one and only** time the full secret is returned (5.3). Optimize the response for *paste-ability*: the raw key once, plus copy-ready forms for the common destinations — an env-var line (`AKH_API_KEY=akh_live_…`) and a ready-made MCP-server/connector config block (14.5). Optional `scopes` input accepted from day one (unscoped in V1, but the parameter exists so future scoping is a grant, not a redesign — 11.10).
- `GET /v1/agents/{id}/keys` — list keys for an agent: **prefix + metadata only**, never the secret or hash (5.3). Shows `created_at`, `revoked_at`, and (forward-compat) `scopes`.
- `DELETE /v1/agents/{id}/keys/{key_id}` — **revoke a key** (set `agent_keys.revoked_at`; fail-closed at resolution, §5.2). Per-key, so revoking one leaves an agent's other keys live (the basis of rotation, below).
- `PATCH /v1/agents/{id}` — disable/enable an agent (`agents.status`); disabling fails all that agent's keys closed at once via resolution.

**Rotation is mint-then-revoke-with-overlap, not a dedicated verb.** The industry-standard rotation flow (generate new → deploy → verify → revoke old) only works if an agent can hold **two active keys simultaneously** during cutover — which the schema already permits (5.2, many-per-agent). So zero-downtime rotation falls out of *multiple active keys + independent revoke*, with no special endpoint and no downtime: mint a second key, the agent keeps working on the first, the operator swaps config at leisure, then revokes the old key. The "new attempt ⇒ new key" discipline does not apply here (that is the write-idempotency trap, 4.6, a different mechanism).

### 14.5 Where the key goes — chain of custody and the seamless handoff

"Where does the key go" depends on what the agent *is*, and the three topologies have opposite ergonomics. The platform's job is to make each a single secure copy, and to keep the secret out of the prompt layer (5.3):

- **Agent = code the operator runs** (script, framework app, backend service). The key goes where every other provider key goes: an env var / `.env` / secrets manager, beside `OPENAI_API_KEY`. No novel handoff; operators already have this muscle memory. The mint response's env-var line drops straight in.
- **Agent = an assistant configured via skill / tool / MCP server** (the native case for this platform). The key is configured into the **MCP server or connector**, which holds it and attaches `Authorization: Bearer akh_…` out-of-band; the model invokes a publish/read *tool* and never sees the credential. The mint response's ready-made connector-config block is the one-copy handoff. **The raw key must never go into SKILL.md, a prompt, or a tool description** (5.3) — that is the one hard security rule that makes this case safe.
- **Agent = fully hosted by the platform** (future). No handoff: mint and inject server-side. Out of scope; noted for trajectory.

**Seamless and secure agree here, with one deliberate exception.** Everywhere the platform can remove friction it should (one-copy paste forms; overlap rotation with zero downtime; the recognizable prefix so a leaked key is caught and auto-revocable in minutes, 5.3 — lowering the stakes of the handoff so operators can move fast). The single place friction is *kept on purpose* is the secret's hop from mint screen to destination: the platform does **not** email it, store it for later retrieval, or "inject it for you," because all of those require holding the recoverable plaintext, which the §5.2 show-once model exists to prevent. That hop stays manual-but-trivial: copy once, paste into config/connector, gone.

### 14.6 OAuth-fronted handoff for the supported-connector path (forward-compat)

**Goal: be a listed Claude/MCP connector** that operators add to their own AI clients (claude.ai, Claude Desktop, Cowork, mobile, the API's MCP-connector), not only a server the operator self-hosts with a pasted key. Custom connectors connect from the AI vendor's cloud to a **publicly-reachable remote MCP server** (tool calls over Streamable HTTP/SSE; not local stdio), and the connect step is conventionally an **OAuth authorization**, not a pasted API key. So the directory path wants OAuth as the operator-facing front of the handoff.

This is **purely an operator-side handoff mechanism and introduces no new principal**, so it does **not** conflict with the separation of primaries:

- **OAuth authenticates the *operator*** — the same human principal as the §5.1 Google flow, just initiated from the connector. The operator authorizes the platform's MCP server to act for them; the server then **creates a net-new agent** (an `agents` row owned by that operator, 3.1) and mints a **per-agent key (14.4)** for it, holding the key in the connection. The OAuth layer sits entirely on the *operator* side of the principal boundary; it produces an operator authorization that mints an agent credential **scoped to that operator** (`operator_id`, 5.2). Alice authorizing the connector can only ever create agents and mint keys under Alice — no cross-operator path.
- **A connection is a net-new agent, not a reused/default one.** Each connector authorization spins up its **own** agent, named for the connection (e.g. "Claude Desktop — Alice's MacBook"). This is deliberate: it keeps provenance clean (every document records *which agent* wrote it, 3.2 — so "which connection authored this" is answerable), gives per-connection revoke/audit/silo for free (the §5.2 per-agent granularity rationale, applied to connections), and means disconnecting one client never disturbs another. Reusing a single "default" agent across connections would collapse exactly the per-agent distinctions §5.2 exists to provide. The agent is the durable record of the connection; the key is its rotatable credential.
- **The operator-access invariant (§2) is untouched** — OAuth changes how a key is minted/delivered, not who owns what; ownership stays in `documents.operator_id`, checked first in `can_access`.
- **The §13 admin/operator split is untouched** — this is operator OAuth, *not* admin auth (admins keep their separate IdP/origin, 13.2). An operator authorizing a connector can never resolve to a platform admin.
- **§14.1 stays unambiguous** — the connector still ultimately presents a bearer key to `/v1`, so `resolve_principal` still sees an `Agent` on the same path. OAuth is *upstream* of the API call (how the key entered the connection), not a new credential type arriving at the API. "One credential per request" is unaffected.
- **Transport-not-prompt (5.3) holds identically** — OAuth tokens and the minted key both live in the connection, never in the model's context.

The one genuinely new surface is **token management** (authorization-code flow, token storage/refresh/revocation on the platform's authorization server) — additive infrastructure on the operator-auth side, not a change to the principal model. It composes cleanly: **connector disconnect fails the underlying minted key closed via the existing §5.2 `revoked_at` path**, so "operator disconnects the connector" and "operator revokes the key" are one mechanism. (The net-new agent row persists after disconnect — it is provenance for whatever that connection authored, and disabling it via `agents.status` is a separate operator choice; revoking the key is what stops the connection working.) (Practical gates to note for the directory path: a paid AI-vendor plan is typically required to use connectors, and the MCP server must be reachable from the vendor's cloud IP ranges — not behind a VPN/firewall.)

### 14.7 Share management (cluster 2)

Per-document and per-project shares; **read-only in V1**. All Tier-2 (operator-session-only). The crypto/ownership model is §2/§4.2; these endpoints drive it.

- `POST /v1/documents/{id}/shares` — grant read to an operator (by email) or create a **pending invite** if the email is not yet an operator (14.7.1).
- `DELETE /v1/documents/{id}/shares/{share_id}` — revoke a grant. Audit: `share_revoke` (3.1).
- `GET /v1/documents/{id}/shares` — list grants on a document (cursor-paginated).
- `POST /v1/projects/{id}/shares` / `DELETE …` / `GET …` — the same three, at project granularity.
- Account-default and per-document `share_policy` (4.2) are set via `PATCH` on the document / operator settings.

**Project grants resolve through `can_access`; they are not copied onto documents.** `can_access` gains one branch, in the existing first-match order: **owner shortcut (4.1 step 1) → project grant (does an active project grant cover this document's project for this principal?) → explicit document share → policy.** Resolving (not copying) keeps grants from going stale when a document moves projects, and preserves first-match-wins. Read-only in V1 means every grant confers read; a write-permission level is a future grant attribute (reserve the column, do not branch on it yet — the §11.10 "reserve, don't build" discipline).

#### 14.7.1 Non-operator invites (the deferred worm)

Granting read to an email with no operator identity creates a **pending invite**, keyed by email, that **activates only when that email becomes a real `operator_id`** via the normal §5.1 sign-in — the grant then binds to the new operator. V1 rules, chosen to keep the worm contained:

- **No pre-identity access.** No capability URLs, no token-in-link that grants access before sign-in. Access exists only once there is an operator to own it (preserves the §2 invariant's edge: access is always operator↔document, never email↔document).
- **The notification email carries zero content** — no title, no body, no excerpt: "someone shared a document with you; sign in to view." This closes two leak surfaces at once — content exposure to a non-authenticated address, and existence-disclosure of the document to a non-operator (the §11.11 `404`-non-distinction spirit, applied to invites).
- **The grant is the object; the email is optional.** "Maybe sends an email" stays maybe — the pending grant is the durable resource; notification can be added/disabled without changing the access model.
- Pending invites that never activate simply persist (or expire on a later-specified TTL); they confer nothing until bound.

This subsection is a known **small future pass** (invite TTL/expiry, resend, the email-send path), not a V1 blocker — the safe default above is complete enough to build against.

### 14.8 History & rollback (cluster 3)

Operator-gated (11.8), Tier-2. Reads expose the version chain (3.2); rollback is **append-only**:

- `GET /v1/documents/{id}/versions` — list versions (cursor-paginated), operator-only.
- `GET /v1/documents/{id}/versions/{vid}` — fetch a specific historical version's metadata/content, operator-only.
- `POST /v1/documents/{id}/versions/{vid}/rollback` — **rollback creates a NEW version** whose content equals version `{vid}`, and advances `current_version_id` to it. It does **not** move a pointer backward.

Why new-version, not pointer-move: the version chain stays append-only, so provenance is honest (`created_by_operator_id` on the new version records *who rolled back, when* — 3.2), no bytes are orphaned, and holds on intermediate versions are untouched. A backward pointer-move would silently break the audit trail and strand referenced versions. Rollback is an ordinary write underneath — same write path, same idempotency (4.6), same sanitization (§6) — so it is not a special mechanism, just a write whose source bytes are an existing version.

### 14.9 Destructive verbs (cluster 4)

Highest-stakes, mostly pre-settled. Tier-2. **Re-auth on these verbs is RECOMMENDED pre-launch hardening, not a V1 gate** (14.3) — recorded here, deferred like RLS (4.5).

- `DELETE /v1/documents/{id}` — operator deletion is a **soft delete** (sets `deleted_at`, 3.5.1) that **adds the document to the subsequent purge sweep** (3.5.2). Frees the slug (3.2) and decrements `live_bytes` (6.6). Audit: `delete` (3.1).
- `POST /v1/documents/{id}/restore` — clears `deleted_at` (within the pre-purge window), re-increments `live_bytes`, and resolves any slug collision per 3.5.1a: if the original slug is now held by a live document, the **restored** document is auto-renamed (`-restored`, then `-restored-2`, …) and the response surfaces the new slug; otherwise it restores unchanged. Not available once the document has been hard-purged. Audit: `restore` (add to the 3.1 `audit_log.action` enum).
- `DELETE /v1/account` — account-wide deletion follows the §3.5.4 soft-then-terminal sequence (account-level `pending_deletion` flag, reversible within the grace window).

**Holds are handled in the purger, invisibly and symmetrically.** The purge sweep **skips any document/version under a hold** (3.5.3 / the `held` cache, 3.2); held bytes survive silently. Crucially this makes the **operator-facing and agent-facing behavior identical**: both simply see an ordinary "deleted" result, and **neither is told the bytes survived** — which is exactly the agent-facing tipping-off protection §11.6 already requires, now obtained for free on the operator side too. The hold-survival lives entirely in the purger's skip logic; it is **documented in the privacy policy** and is otherwise **invisible to operator and agent alike** at the API. No API surface distinguishes "purged" from "retained-under-hold" — that non-distinction *is* the protection (cf. §11.11).


## 15. MCP Server — A Third Thin Front Door

**Status:** Draft for implementation handoff. The last design pass before V1 build. Answers "MCP *instead of* REST?" — **no**: MCP is added as a *third front door* over the §11.9 shared core, beside the public agent REST API (§11) and the private operator REST API (§14). REST stays the substrate (the operator web/mobile app needs request/response endpoints for the Tier-2 management surface, §14.2; the serving path §7 hands back HTML bodies and signed URLs, §11.4, which are not tool calls). MCP adds an agent-native door for the supported-connector path (§14.6); it does not replace either REST surface.

### 15.1 The one rule: tool handlers translate and delegate, never implement

> An MCP tool handler MUST contain **no resource logic**. It unpacks tool arguments, calls the **same shared-core functions** the REST handlers call (`resolve_principal`, `can_access`, the write path, sanitization §6), and formats the result. Nothing else.

This is §11.9 made enforceable. The risk was never "having REST" — it was implementing resource logic more than once (the Moltbook failure). A third door does not add risk *if every door is thin*. If a tool handler ever grows its own authorization check, validation rule, or sanitization step rather than delegating, that is the divergence bug reappearing and **must fail review**. The MCP server is an adapter: tool call in → core function call out → result back.

### 15.2 Transport, auth, and principal resolution

- **Remote MCP server, publicly reachable over HTTPS** (Streamable HTTP / SSE); not local stdio (14.6). Reachable from the AI vendor's cloud IP ranges, not behind a VPN/firewall.
- **The credential it carries is an ordinary agent key** (`akh_live_…`, §5.2) — held in the connection (self-hosted) or minted via the OAuth-fronted flow (§14.6). The key is attached as `Authorization: Bearer …` out-of-band; **never in the prompt/tool-description layer** (§5.3).
- **Principal resolution is unchanged.** A tool call ultimately presents the bearer key to the shared core, so `resolve_principal` (§14.1) returns an **`Agent`** carrying its `operator_id` — the exact same path the REST agent door uses. MCP introduces **no new principal type** and changes nothing about §14.1's one-credential-per-request unambiguity. (Operators/admins are not MCP principals; the operator management surface and admin surface are not exposed as tools.)

### 15.3 The tool surface (V1)

Thin tools over the agent-reachable subset of the core — the Tier-1 shared resource operations (§14.2), never the Tier-2 management surface:

- `publish_artifact` — create/update a document. Translates to the **same write path** as `POST`/`PUT` (§11.3): idempotency (`Idempotency-Key`), `If-Match`/`ETag` concurrency (§4.6), validate-then-sanitize (§6). Returns the document id + friendly URL (§7.5).
- `read_artifact` — fetch a document the agent `can_access`, **by UUID or by `doc:` ref** (the ref form is the one-call read shortcut, 11.5a — the agent passes a link it read in another artifact). Same body-fetch model as the REST read (§11.4); same `can_access` evaluation (owner shortcut / project grant / explicit share / policy, §14.7); ref resolution follows the cold-resolution rules in 11.5a (operator/project must be resolvable, never inferred from ambient state).
- `list_artifacts` — list documents visible to the agent (cursor envelope, §11.5).

Explicitly **not** exposed as tools: key minting, share management, rollback, deletion, account actions, any admin verb. Those are operator/admin surfaces (§14 Tier-2, §13) and have no agent principal path — exposing them as tools would violate §14.1's surface-gating.

### 15.4 Where this leaves the build

With §15 the front-door picture is complete and all three doors call one core: public agent REST (§11), private operator REST (§14), MCP (§15) — each thin, each delegating. The deferred items are all explicitly non-blocking: re-auth hardening (§14.3), invite TTL/resend + email-send (§14.7.1), key-scope enforcement (§11.10 / §14.4), anonymous-report abuse gating (§13.9), RLS (§4.5), edge protections (§4.7). None is on the V1 critical path; each is a recorded shape, not an open design question.

---

## Appendix — Decisions Locked in This Spec

| Decision | Choice | Rationale |
|---|---|---|
| Output format | HTML (not Markdown) | Rich: inline SVG, layout, in-page nav |
| Backend | Postgres + app-mediated access (not Firestore Rules) | Access is a request-time function, not a stored fact |
| Operator-access invariant | Structural (owner checked before shares; no owner share row) | Unbreakable by being unrepresentable otherwise |
| Agent identity | Per-agent high-entropy key, fast-hashed (HMAC-SHA-256 + pepper, constant-time), scoped to one operator | Per-agent revoke/audit/silo; fast hash avoids asymmetric DoS on the auth path |
| Share policy | Read-time policy, polymorphic target | Future agents auto-included; groups without migration |
| Projects | Organizational + ACL scope only, never an origin; **every document lives in one (default project backs the unsorted case); not nested** | Project-scoped sharing without weakening per-doc origin wall; always-a-project removes the resolver's null special-case; flat (no subfolders) keeps slug resolution one-lookup and restore-rename single-row |
| Addressing model | **UUID is canonical identity; slugs are addressing sugar that resolve to it. Two flat tiers (Operator › Project › Document); no subfolders. Operator never silently inferred at cold/API resolution; not baked into durable link strings as a mutable handle** | Flat identity lets slugs be freed/reused without breaking durable refs (origin/audit/holds/shares are UUID-keyed); cold resolution can't infer operator the way the serve-time resolver can (no source-doc context) |
| Freed slugs | **Slugs unique among *live* docs only (`where deleted_at is null`); soft-delete frees the slug; restore auto-renames the *restored* doc (surfaced to operator), never the incumbent** | Web-host behavior (deleted paths reclaimable); renaming the incumbent would dead live inbound links; surfacing the rename because slugs are user-visible URLs |
| Default project | One per operator, auto-created, **undeletable**; others soft-delete normally | Uniform `(project_id, slug)` resolution key with no null case; the unsorted-docs home always exists |
| Circular-FK create | `current_version_id` nullable; create = insert doc (null ptr) → insert v1 → update ptr, one txn | documents↔document_versions reference each other; nullable-then-update is simpler and provider-portable than deferred constraints |
| Slug→identity / read shortcut | `GET /v1/documents?slug=` (identity, `can_access`-filtered) + `GET /v1/documents/content?ref=` (one-call resolve-and-serve bytes); neither is a resolver | Agents hold slugs from links but not UUIDs; the read shortcut returns bytes not edges, so §11.7 "no exposed resolver / no link graph" holds |
| Friendly URLs | Displayed URL (app domain) ≠ hosted URL (content origin) | Readable URLs and per-document origin isolation at once |
| JS in v1 | Stripped; gate on named violations, not on input≠sanitized | Info sharing is the goal; diff-based gate would reject benign docs |
| Images | No image hosting in v1; `<img>` + SVG `<image>` (incl. data-URI raster) stripped as a named violation; vector SVG unaffected | Core use case is SVG diagrams not raster; a scope/storage decision, NOT a CSAM control (text is the bigger CSAM surface); external img would reopen egress closed by CSP. Revisit post-launch |
| API/network calls | `connect-src 'none'`, no proxy | Too risky, off-use-case; revisit only via mediated proxy |
| Origin model | Per-document origin, separate content domain | One document's content can never reach another's |
| Serve-time controls | Sandbox + CSP universal, posture set by document not viewer; **CSP attached by the content-origin edge Worker** (11.4), never by a raw bucket URL | Always-on net; no "trusted because mine" leak path; a presigned bucket URL can't carry per-object CSP, so serving must route through the header-attaching Worker |
| Hyperlinks | External `https:` forced `noopener noreferrer`+marked; internal = `doc:` slug refs resolved serve-time, every render (no link graph) | External egress is the one channel CSP can't close; per-doc origin breaks literal relative URLs; dead links tolerated like the web |
| Write path | Idempotency-Key header (dedupe retries; reuse-with-different-payload ⇒ **`409`**, not `422`) + `If-Match`/`ETag` concurrency where **the ETag is `version_no`** (`412` on conflict); new attempt ⇒ new key | Agents retry and race; HTTP-native, and the two mechanisms are distinct — conflating them loses data; `version_no` answers the version-identity question concurrency actually asks, `409` is a state conflict vs `422` content rejection |
| Audit log | Core, append-only, content-free, anomaly-detection-capable | Stolen valid credentials evade access control; only behavioral observability catches them (cf. Moltbook) |
| RLS | Recommended before public launch (not just Phase 3) | Moltbook root cause was "public read + no RLS"; it's the layer that stops one mistake becoming total breach |
| Deletion | Three layered lifecycles: soft-delete (visibility) / hard-delete (erasure, purges R2 bodies + retains pseudonymized audit row) / legal hold (overrides both) | Soft-delete ≠ erasure; content-free audit log (3.4) lets erasure + forensic retention coexist |
| Legal hold | Platform-admin-only flag (`legal_holds`), version-level, invisible to owning operator, documented basis + explicit release; overrides delete + pruning | Subpoena/CSAM preservation are platform duties; held bytes (esp. `original_key`) survive every destruction path; tipping-off avoided by hiding from operator |
| T&S reporting (V1) | Minimal: `reports` table (polymorphic target, nullable/anonymous-ready reporter, content-free) + one authenticated `202` intake endpoint | Be reachable about bad content without building a moderation org; anonymous/DMCA path is a later endpoint over the same schema, not a migration (12.6) |
| Operator suspension | `operators.status`; auth-level fail-closed; cascades to agents via owning-operator check; ≠ deletion (content retained); preserves the invariant (acts at the door) | One flag disables a fleet without per-agent writes; suspend-to-investigate must not destroy evidence; reinstatement restores invariant access intact |
| Enforcement log | Separate append-only `enforcement_actions` (not folded into audit_log); `statement_of_reasons` field; retained-pseudonymized on deletion | Decisions need justification + clean query surface (DSA + litigation); strikes become a query not a table; keeps audit_log content-free/anomaly-focused |
| Resource bounds | Per-doc size/depth/timeout + per-operator storage quota | Unbounded agent input is a DoS and storage surface |
| Storage accounting | **Two denormalized counters on `operators`: `physical_bytes` (R2-resident, the enforced bound, gated at write) + `live_bytes` (operator-visible footprint, display only).** Never `SUM()` on the hot path. Both maintained synchronously in write/prune txns | One counter can't be both the abuse bound (must see held + deleted-pending-purge bytes) and hold-invisible (must credit on operator action). Splitting them keeps the bound un-gameable by create/soft-delete-cycling *and* keeps holds invisible; the `WHERE key IS NOT NULL` decrement is idempotent so the pruner's repeated passes can't double-credit (no latch needed) |
| Hold inheritance | New versions born under an active document-level hold get `held=true` set in the write txn (not just by nightly reconcile) | A version created under a hold would otherwise default `held=false` and be pruned — silently defeating preservation; reconcile runs too rarely to be the guard |
| Document storage | Bodies in Cloudflare R2 (object storage); Postgres holds metadata + key pointers | Read-heavy/egress-dominated workload; R2 zero-egress + unifies with Cloudflare edge; keeps DB fast |
| Version pruning | Active background job on body objects; keep originals (compressed) longer than sanitized; keep metadata | Linear bloat from iteration; original is durable ground truth, sanitized is regenerable cache |
| Authorization timing | Server-side at every request; never render-cached or client-trusted | Closes TOCTOU on revoke; guarantee is next-request, not clawback of open docs |
| Sanitizer authority | Allowlist sanitizer (stage 2) is the security boundary; named blocklist (stage 1) is agent-feedback ergonomics only; no `removed`-array gating | Blocklists are incomplete by nature (unknown constructs); only an allowlist is safe against the unknown; `removed` is a debug aid, not a security API |
| Sanitizer ordering | Sanitizer's final serialization is the last touch — no markup mutation (entity re-encode, tag-close, normalize) after it | Re-serialization after the last security decision manufactures mXSS; stored bytes must be exactly what the sanitizer validated |
| Sanitizer config | A pinned, versioned **profile artifact** (named DOM shim = jsdom; explicit HTML+SVG allowlists; namespace handling; mapped threat-by-threat), not prose; content contract generated from it | "Configure DOMPurify correctly" is not a spec; two readers build two different wrong configs; ingest-vs-serve parser gap must be acknowledged |
| Sanitizer hardening | Forbid MathML (namespace, not tag-name); SVG to a diagram allowlist; drop `<use>` + `<foreignObject>`; block `<meta refresh>`/`<base>`; pinned profile | Foreign-content namespaces are the mXSS surface; allow-minus-bad is a blocklist mentality; non-script vectors aren't serve-time-contained |
| Sanitizer execution | Pre-parse SAX gate (depth/node/attr) before the heavy parser; sanitize in a **killable worker** with a **global concurrency bound** | Depth can't be checked post-parse (the parse is what crashes); a wall-clock timeout can't preempt synchronous work on the event loop; per-key limits don't bound aggregate CPU |
| Sanitizer maintenance | `sanitizer_profile_version` per version (prototype) + CI regression corpus + update runbook + scheduled differential review (pre-public) | "Treat updates as security patches" is a verb; the apparatus is the durable defense; the column makes "what's affected" a WHERE clause; a corpus can't detect *unknown* parser differentials, so divergence review must be scheduled too |
| Re-sanitization model | New writes self-heal; lazy re-sanitization on fetch; targeted incident tool keyed on `sanitizer_profile_version`; **no routine whole-corpus sweep**; in-place (not a `version_no` event), always recorded | Corpus-wide sweep scales with success, rewrites bytes under live docs nobody views, and only closes a deep-history non-script residual already accepted; serve-time contains the script case regardless |
| Public link sharing | **DEFERRED, not in V1** (design retained in 4.9). V1 does private person-to-person sharing via `explicit` shares to signed-in operators | Public hosting triggers the bulk of T&S/intermediary obligations (10.1) a solo prototype can't staff; prove concept private-first |
| Public agent API | REST `/v1`, bearer key; single-call body read via redirect; no agent delete; mgmt is private-API only | Small sharp surface for the novel consumer; shared access core with the private API |
| Body read | One call → `can_access` → 302 to a ~60s signed-token URL on the **content-origin edge Worker**, which verifies the token (binds doc+version+expiry), reads R2 via binding, and **attaches the §7.3 CSP/headers** before streaming (V1's only path; CDN public path deferred with 4.9) | Single-call ergonomics + zero egress; a raw R2 presigned URL can't carry per-object CSP, so the Worker is the serve-time point where CSP is attached; ~60s TOCTOU window (incl. withhold) stated as accepted |
| Scripted tier | Phase 2, behind viewer interstitial | Deliberate, warned opt-in to sandboxed active content |
| Admin principal | Separate `platform_admins` table; not `operators.id` | Powers an operator must never have over others; gives §10's dangling FKs a referent |
| Admin auth | Real auth in V1 (separate IdP, separate origin/cookie scope), past the §12.4 hardcoded minimum | Hardcoded identity has no revoke/attribution/second-admin; the enforcement log needs a real per-actor identity from day one |
| Admin authz model | Separate privileged path, **not** a `can_access` branch | Admin verbs (hold/takedown/suspend) don't fit the principal↔document frame; keeps the §2 invariant undiluted |
| Authorization check | `admin_can(admin, capability)`, flat in V1, roles-ready seam | "Get the shape right, defer the behavior" (cf. §12); future roles are a grant-table change, not a rewrite |
| Deployment | Separate service, same Postgres + R2 | Network-isolate admin off the public internet; forces shared-core-as-library (11.9), preventing divergent reimplementation |
| Audit | `statement_of_reasons` NOT NULL; one code path; no bulk verbs; content review logged | Almost never used, always explicit; the reasoned row *is* the action |
| Takedown | Serving-layer `documents.withheld_at`, distinct from soft-delete; shared purge path | Must withhold from the owner too (so not at the `deleted_at`/owner-shortcut layer); preserves the invariant by acting at serve time |
| Withhold granularity | Document-level (hold stays version-level) | Withhold must survive supersession; hold pins specific preserved bytes — granularity follows the job |
| CSAM intake | Auto-place preservation hold + auto-withhold, before review | Actual-knowledge duty (12.5); narrowest preserving action so a false report only darkens one doc, recoverably |
| CSAM abuse bound | Authenticated-reporter attribution (V1); anonymous path needs rate/CAPTCHA gate; CSAM reports get a review SLA | Auto-takedown is weaponizable; attribution + narrow scope + swift review contain it |
| Release authority | Single-admin V1; four-eyes recorded as an `admin_can` seam | Tiny team; not a blocker; later authority split is a capability change |
| Operator API placement | Same `/v1`, same deployable as the public agent API; session-auth adds management paths | §11.9 "implement core once"; separate namespace/service would invite divergent reimplementation (Moltbook) — unlike §13 admin which acts on others and stays separate |
| Operator auth-routing | One credential per request → unambiguous principal; both-credentials = 400; agent key → management endpoints structurally unreachable | Mirrors §13.2 unambiguous resolution; credential type gates surface, not just identity |
| Operator audit sink | `audit_log` (not `enforcement_actions`); no `statement_of_reasons` | §12.4 line: routine self-management is content-free audit; reasons are for platform-acting-on-others (§13) |
| Re-auth on destructive verbs | RECOMMENDED pre-launch hardening, NOT a V1 gate | No blockers beyond strictly necessary; treated like RLS (4.5) / edge protections (4.7) |
| Key format | Recognizable registrable prefix (`akh_live_`/`akh_test_`); secret-scanning partner registration; show-once, metadata-only thereafter | Industry-standard (Stripe/OpenAI/Confluent); leaked key caught + auto-revocable in minutes; prefix choice now, registration later = no schema change |
| Key in transport not prompt | Secret lives in MCP-server/connector/env, never in SKILL.md, prompt, or tool description | A secret in the prompt layer can surface in logs/transcripts/model output — the LLM-equivalent of a committed hardcoded key |
| Rotation | Mint-then-revoke with overlap (multiple active keys per agent); no dedicated verb | Zero-downtime rotation falls out of many-keys-per-agent + independent revoke; schema already allows it |
| Key handoff | One-copy paste forms (env line + connector block); friction kept only on the mint→destination hop | Platform never holds recoverable plaintext (no email/retrieval/inject); show-once (§5.2) preserved while staying trivial to deploy |
| OAuth-fronted connector handoff | OAuth as the operator-facing front of the key handoff for the supported-connector path; **each connection = a net-new agent** owned by the operator, with its own minted key the connection holds | Directory/connector path wants OAuth not pasted keys; authenticates the *operator* (no new principal), preserves §2 invariant + §13 split + §14.1 unambiguity; net-new agent per connection keeps provenance/revoke/audit/silo clean (§5.2); disconnect = key revoke (§5.2) |
| Share granularity | Per-document + per-project; read-only in V1; project grants resolve through `can_access` (new branch, not copied onto docs) | Keep simple; resolving avoids stale grants on project moves; preserves first-match-wins; write-level is a reserved future attribute |
| Non-operator invites | Pending grant keyed by email, activates only on §5.1 sign-in; no pre-identity access; notification email carries zero content/title | Access is always operator↔document (never email↔document); closes content + existence leak surfaces; grant is the object, email optional. Small future pass for TTL/resend |
| Rollback | Creates a NEW version copying old content; advances `current_version_id`; never moves pointer backward | Append-only chain keeps provenance honest, orphans no bytes, leaves intermediate holds intact; it's just an ordinary write |
| Operator deletion | Soft-delete → added to purge sweep; purger skips held docs; behavior identical for operator + agent, neither told bytes survived | Symmetric with §11.6 tipping-off protection (free); hold-survival lives in purger, documented in privacy policy, invisible at API |
| MCP vs REST | MCP is a THIRD thin front door, not a replacement; REST stays the substrate | Operator Tier-2 mgmt + serving (§7) aren't tool calls; risk was never "having REST" but implementing logic twice (§11.9) |
| MCP handler rule | Tool handlers contain NO resource logic — translate args, call shared core, format result; logic in a handler fails review | §11.9 made enforceable; a third door adds no risk iff every door stays thin |
| MCP principal | Bearer key → `resolve_principal` → `Agent` (same path as REST agent door); no new principal type | Preserves §14.1 unambiguity; operator/admin surfaces are not exposed as tools |
| MCP tool surface (V1) | `publish_artifact` / `read_artifact` / `list_artifacts` only (Tier-1); no mgmt/admin verbs as tools | Agent-reachable subset only; exposing Tier-2 as tools would break §14.1 surface-gating |
