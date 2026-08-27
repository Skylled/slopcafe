# Single publisher, many readers, nothing public — the insight fork's auth model

**Status: BUILT.** Written alongside the change that added the reader tier
(`READER_TOKENS`) and the writer allowlist (`WRITER_AGENT_IDS`) to the
agent-web-host-insight fork. This is both the design rationale and the as-built
record; the executable version of the classification in §4 is
`test/authz-surface.test.mjs`.

## 1. The deployment this is shaped for

One instance, three facts that mainline Slopcafe does not assume:

1. **Exactly one legitimate writer** — the auto-insight teardown pipeline's
   agent. Nothing else should ever append a version.
2. **A small set of human readers** — people who read teardowns in a browser and
   never publish.
3. **Zero public documents.** Every document is `private`; the anonymous web sees
   nothing but the login page. `DEFAULT_DOCUMENT_VISIBILITY = "private"` and no
   document is ever flipped.

Mainline's model is *single-tenant whole-fleet trust*: the operator token is the
only destructive credential, and **any** active agent key may write **any**
document (`src/core.ts` deliberately does not scope writes by `created_by`; see
the "Single-tenant trust model" bullet in `CLAUDE.md`). That is a good model for
a fleet of collaborating agents. It is the wrong model here in two directions:

- **Too generous on write.** A second agent key — minted for an experiment, an
  MCP connector, a one-off script — silently gains the ability to overwrite the
  pipeline's entire corpus. Nothing in the model distinguishes "the publisher"
  from "some other credential the operator once created."
- **Too stingy on read.** A human who wants to *read* private documents has
  exactly two options today: hold the operator token (the one destructive
  credential, which must never be shared) or hold an agent key (which can
  overwrite everything). There is no read-only human.

Both gaps have the same shape: the model has principals for *machines* and a
principal for *the owner*, and nothing in between.

## 2. What was added

### `READER_TOKENS` — a read-only human tier (secret)

A comma-separated list of **per-person** tokens. Each buys either a browser
session (paste it at `/login`, same page and same flow as the operator) or a
`Authorization: Bearer` credential. A reader reads **everything**, private
documents included, and writes **nothing**.

Per-person is the entire point: revocation is "delete that one entry and re-put
the secret," and it logs out exactly that person. Everyone else — and the
operator — stays signed in. The mechanism is in §3.

Empty or unset ⇒ the tier does not exist. Mainline behavior, unchanged.

### `WRITER_AGENT_IDS` — a single-publisher write allowlist (`[vars]`)

A comma-separated list of `agents.id` values permitted to write. When non-empty,
any write by an agent **not** on the list fails `403 read_only_agent` through
both doors. Reads are untouched.

Empty or unset ⇒ every agent may write, which is exactly mainline's whole-fleet
behavior. That default is load-bearing: the pipeline keeps publishing before the
var is ever set, and a typo'd or emptied value fails **open** rather than locking
the publisher out of its own corpus. (The reader tier fails the other way — a
broken `READER_TOKENS` means nobody signs in as a reader — because that is the
safe direction for each.)

## 3. Reader sessions: how per-person revocation works

The session cookie is unchanged in shape (`src/session.ts`): a base64url JSON
payload plus an HMAC under a signing key derived from `OPERATOR_TOKEN` and
`SESSION_EPOCH`. One optional field is new:

```
awh_session = base64url({v, iat, exp, csrf, r?}) "." HMAC(payload, signingKey)
signingKey  = HMAC("awh-session-signing/v" + EPOCH, OPERATOR_TOKEN)
r           = HMAC("awh-reader-id/v1:" + readerToken, signingKey)[0..16]
```

- **`r` absent ⇒ operator session.** This encoding is what keeps every live
  operator cookie valid across the change: no `PAYLOAD_V` bump, no forced
  re-login. It also fails safe — a payload that lost its `r` also lost its
  signature.
- **`r` present ⇒ reader session**, and its value fingerprints the specific
  `READER_TOKENS` entry the person signed in with.

Verification recomputes `r` for every **currently configured** reader token and
requires the cookie's `r` to be in that set. So:

| lever | effect |
| --- | --- |
| delete one entry from `READER_TOKENS` | that person's sessions die; everyone else's survive |
| clear `READER_TOKENS` | every reader session dies; operator sessions survive |
| bump `SESSION_EPOCH` | everybody, readers and operator, logged out |
| rotate `OPERATOR_TOKEN` | everybody logged out (and every reader `r` changes) |

**`r` fingerprints the TOKEN, not its INDEX in the list.** An index would
silently re-point at a different human the moment an earlier entry was removed:
delete Alice (index 0) and Bob's cookie, carrying `r = 1`, would now name Carol.
Pinned by `test/session.test.mjs` ("…as a reader, not silently upgraded").

## 4. The read/mutate line

The change's safety rests on one structural decision: **`authenticateOperatorRequest`
was narrowed, not widened.** It now returns `ok` only for `tier === "operator"`,
and every pre-existing gate in the codebase calls it (directly, or through
`requireOperator` / `authorizeOperatorForm`). So the reader tier is
**deny-by-default across the entire existing surface** — a new principal that no
existing gate knows about cannot pass one by accident. Widening a surface to
readers is an explicit, greppable edit at that surface.

The gate vocabulary after the change:

| gate | admits | used for |
| --- | --- | --- |
| `requireOperator` | operator | JSON `/admin/*` mutations, `DELETE /d/:id` |
| `authorizeOperatorForm` | operator | every HTML form (manage page, console) |
| `authenticateOperatorRequest` | operator | raw resolver; manage/revoke pages |
| `requireReadSession` | operator, reader | the five `/admin/*` **reads** |
| `authenticateSessionRequest` | operator, reader | HTML reads (shell, version views, two console pages) |
| `requireReader` | operator, reader, agent | credentialed reads (`/text`, `/source`, `/links`, `GET /d`, `/d/search`, `/d/pack`) |
| `requireCurator` | operator, agent — **never reader** | the two agent-door classification writes |
| `resolvePrincipal` | all four | the visibility gate (`canRead`) |

`requireCurator` is new and exists for one reason: `PUT /d/:id/tags` and
`PUT /d/:id/status` used to be gated by `requireReader` — defensible while every
principal it admitted could already overwrite a document's content, and instantly
wrong once a read-only principal existed. Splitting the gate is what makes
"reader ⇒ zero mutations" true by construction rather than by review.

Two more compile-time backstops:

- **`Author` excludes `reader`** (`src/access.ts`). There is no value of that
  type a reader could be widened into, so a handler that tried to forward one to
  a write core would not typecheck.
- **`read_only_agent` is spliced into all five write-error unions**, and the
  route switches over them are exhaustive. Adding a write core without handling
  the refusal is a `tsc` failure at the door that consumes it.

What readers deliberately **do** get that might surprise: version history
(`GET /d/:id/v/:n`, `/v/:n/raw`, `GET /admin/documents/:id/versions`). It is a
pure read of bytes the reader can already fetch at the current version, and on a
corpus where every document is private and one agent writes, an older version
discloses nothing new. The **write** history enables — restore — stays
operator-only, and the manage page that hosts the button renders a reader the
same sign-in card an anonymous visitor gets.

What readers deliberately do **not** get: anything under `/admin/agents`,
`/admin/keys`, `/admin/oauth-clients` (or their console equivalents), even the
read-only listings. Enumerating an agent's keys is a step in an attack on the
write path, not corpus browsing.

## 5. Where writer enforcement lives, and why it can't be bypassed

**In the five write cores** (`src/core.ts`): `publishDocumentCore`,
`updateDocumentCore`, `editDocumentCore`, `setDocumentTagsCore`,
`setDocumentStatusCore`. Each calls `refuseNonWriter(env, author)` as its first
statement, before any `await`, before the id-shape check, before the body is
measured or sanitized. `refuseNonWriter` delegates to the pure `agentMayWrite`
predicate in `src/auth.ts`.

Three reasons that is the right place and not the routes:

1. **Both doors already converge there.** The project rule is "add new write
   surfaces in core, never in route handlers" (`CLAUDE.md`, "Shared write path").
   HTTP and MCP call the same five functions. A future door — a third transport,
   a queue consumer, a scheduled republisher — inherits the check by
   construction. Enforcing at the routes would mean N copies and N chances to
   miss one.
2. **The two classification cores now take a required `author`.** They took none
   before, which is exactly how a write can hide from an authorship rule.
   Required and positional means every existing caller had to be visited when the
   feature landed, and a new caller cannot forget.
3. **Before any `await`.** A refused agent cannot force a 5 MiB sanitize pass, and
   — because the check precedes the existence lookup in `updateDocumentCore` —
   cannot use the write route as a document-existence oracle: every id, present
   or absent, answers `read_only_agent`.

`test/authz-surface.test.mjs` pins all three properties, plus "no route module
re-implements the check" (no `agentMayWrite(` or `env.WRITER_AGENT_IDS` outside
`auth.ts`/`core.ts`).

### `create_publish_credential` is covered, and here is the proof

The MCP tool mints a short-lived `awh_` key via `mintEphemeralKey(env,
props.agentId, ttl)` (`src/mcp.ts` → `src/admin.ts`). The row it inserts binds
`agent_id = props.agentId` — the **caller's own** agent — and `authenticateAgent`
resolves that key back to the same `agents.id`. So a credential minted by a
refused agent authenticates as that refused agent and is refused identically at
the write core. **Enforcement-at-write genuinely covers the ephemeral path**;
no separate gate on the minting tool is needed, and adding one would only produce
a worse error message at a less useful moment. (The MCP refusal text says so
explicitly, because "mint a fresh credential and retry" is precisely the reflex
an agent has on a permission error.)

## 6. Error contract

`read_only_agent` — new `ErrorCode`, `403`, context field `agent_id` (required).

- HTTP: `POST /d`, `PUT /d/:id`, `PUT /d/:id/tags`, `PUT /d/:id/status`.
- MCP: `publish_document`, `update_document`, `edit_document`,
  `set_document_tags`, `set_document_status` — as the standard
  `"read_only_agent: <message>"` prefixed failure.

**403, not 401.** The credential authenticated correctly. Re-authenticating,
minting a new key, or reconnecting changes nothing, so both the status and the
message have to say *stop*, not *retry*.

Unreachable when `WRITER_AGENT_IDS` is empty or unset, which is why the OpenAPI
bump for all of this is MINOR (`2.4.0`): no previously-accepted request is
refused on a deployment that has not opted in.

## 7. Deliberate non-goals

- **No reader identity in the data model.** `Principal` carries `{ kind: "reader" }`
  with no id. The per-person fingerprint exists *only* to scope session
  revocation; no read decision, listing or stored row depends on which reader is
  asking, and none should start. Adding one means adding an audit story, and this
  deployment does not have one.
- **No per-document reader ACLs.** Every reader reads everything. If that ever
  changes it extends `canRead`'s branch list (as the platform spec's `can_access`
  always intended), not the write gates.
- **No reader-writable anything, ever, by analogy.** The classification writes
  looked read-adjacent and were the one real trap here. If a future surface feels
  borderline, the question is not "is this small?" but "does a reader hold write
  authority anywhere?" — and the answer must stay no.
