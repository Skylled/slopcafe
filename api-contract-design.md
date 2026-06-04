# Formalizing the API contract (code-first OpenAPI + codegen) — design note

**Status:** **Phases 1–2 BUILT** (2026-06-04; Phase 1 wire-invisible, Phase 2
adds one route — `GET /openapi.json` — and is otherwise wire-invisible; see §13);
Phases 3–4 remain planned. Direction chosen by the operator
(2026-06-04): **code-first** — Zod schemas in the Worker are the single source of
truth, OpenAPI 3.1 is *generated* from them; the **consuming repo picks its own
client generator** off the published spec (we ship the spec, not a Dart toolchain);
and the **narrative layer (`docs/http-api.md`) stays** — prose remains
hand-authored and links to the generated spec for exact shapes, rather than being
replaced by it. Everything below is a decided constraint unless tagged *deferred*.
Phase 1 has landed (`src/contract.ts`, the inverted `core.ts` types, the
`ErrorCode` enum routed through `jsonError`/`operatorError`, and
`test/contract.test.mjs`); the remaining phases are implemented in sequence (§13).

This follows the shape of `vector-search-design.md` /
`source-retention-design.md` / `byte-exact-publish-design.md`: problem →
decisions → mechanics → docs/test/cost → rollout → deferred.

---

## 1. Problem & goal

"The contract" is **three hand-maintained surfaces kept in lockstep by
discipline** — the CLAUDE.md "update all of these in the same commit" rule:

1. **TypeScript types** in `src/core.ts` — `WriteOk` (`:67`), `DocumentListing`
   (`:1468`), `SearchHit` (`:1842`), `ReadOk` (`:1078`), `ReadTextOk` (`:1185`),
   `ReadSourceOk` (`:1242`), `VersionListing` (`:1369`), and the error unions
   (`PublishErr` `:113`, `UpdateErr` `:125`, `ReadErr`, `EditErr`, `RestoreErr`,
   `ReadSourceErr`, `SearchErr`). These are the *in-code* truth, but they're plain
   TS `type`s — **not serializable, not runtime-checked**. Handlers build response
   objects that the compiler *assumes* match; nothing proves the wire bytes do.
2. **Prose** in `docs/http-api.md` — ~1,160 lines restating every route, header,
   status code, and response shape. Also published live on Slopcafe
   (`slopcafe-http-api`).
3. **MCP tool schemas** in `src/mcp.ts` — these are *already* machine-readable
   (Zod v4, `server.registerTool({ inputSchema })`), but **only for tool inputs**;
   the response envelopes are hand-built and live only in prose.

Nothing mechanically checks that the handler's response matches the TS type, that
the TS type matches the prose, or that a consumer's models (the Flutter app's
hand-written Dart) match any of them. Every sync is a human remembering a
checklist. The error catalogue — ~25 string codes (`slug_taken`,
`version_conflict`, `precondition_required`, `csrf_failed`, …) spread across the
`core.ts` unions **and** the HTTP-layer `jsonError(status, code, message, extra)`
calls in `src/index.ts` — has no single enumerated home, so a consumer switches on
magic strings copied from prose.

**Goal:** one machine-readable source of truth from which the server types, the
precise reference, and **client SDKs in any language** are generated — so the
Flutter app stays in sync mechanically and a *new* app (TS, Python, Swift…)
bootstraps off the same artifact for free. **Non-goal:** rewriting the Worker
around a web framework, or replacing the hand-authored narrative.

## 2. Decisions (locked)

1. **Code-first, Zod as the source of truth.** Zod is already a dependency
   (`^4.4.3`) and already the MCP input contract — so we *extend* Zod from "MCP
   inputs only" to "the whole HTTP contract" rather than introduce a parallel
   IDL. The hand-written `core.ts` response types become `z.infer<>` of Zod
   schemas, so **code and contract can't diverge** (the type a handler is checked
   against *is* the contract).
2. **OpenAPI 3.1 is the generated wire artifact.** 3.1 because it *is* a superset
   of JSON Schema 2020-12, which is what Zod 4's native `z.toJSONSchema()` emits —
   so the Zod → spec path needs no impedance-matching. The spec is generated,
   never hand-edited.
3. **Zod 4 native, thin in-repo assembler — no heavy generator dep.** Zod 4 ships
   `z.toJSONSchema()` (targets draft-2020-12 → OpenAPI 3.1, and has an
   `openapi-3.0` target too) and a schema **registry** so shared shapes emit as
   `#/components/schemas/<id>` `$ref`s instead of being inlined four times
   (critical for clean codegen — one `DocumentListing` class, not anonymous
   copies). That covers the hard per-schema part natively; a small in-repo route
   registry assembles `paths`/`operations`/security. This matches the repo's
   "small pure standalone module" ethos (`search.ts`, `edit.ts`, `conditional.ts`,
   `vector.ts`). `zod-openapi` (samchungy, Zod-4-compatible) is the **fallback**
   if hand-assembly gets unwieldy — not the default.
4. **The consuming repo owns client generation.** We publish a standards-compliant
   `openapi.json`; the Flutter repo (and any future app) chooses its own generator
   off it (`openapi-generator` `dart-dio`/`dart`, pure-Dart
   `swagger_dart_code_generator`, `openapi-typescript`, etc.). **No Dart/JVM
   toolchain enters this repo.** Our deliverable boundary is the spec.
5. **Serve the spec from the Worker** at `GET /openapi.json` (public, like
   `/healthz`). On-brand with the existing "publish the docs live" pattern — a
   consumer's codegen can point straight at production. Optionally a rendered UI
   (Scalar/Redoc) at `/docs`, *deferred*.
6. **Validate in tests, not in the production response path.** The schemas back
   **contract tests** (hit `wrangler dev`, parse live responses through the Zod
   schema, fail on mismatch) and a **build-time spec freshness check** — *not* a
   per-request response validator in prod (cost on the hot path + the risk a schema
   bug 500s a real response). Request-side validation is a *later, opt-in* bonus
   (§5) — the existing hand-validation has subtle, deliberate behavior (silent tag
   sanitize vs. loud slug reject) we are **not** rewriting in this work.
7. **The narrative layer stays.** `docs/http-api.md` remains hand-authored prose
   — it carries the *reasoning* OpenAPI can't (the 404-not-401 no-oracle property,
   inheritance-on-omit, the capability-URL model). It **links to** the generated
   spec for exact field shapes instead of restating them, and its
   "Shared response shapes" tables become *generated-or-checked-against* the spec
   over time (§9). Not deleted, not auto-overwritten.
8. **Single canonical `ErrorCode`.** One exported union/enum that both the runtime
   `jsonError` helper and the Zod error-envelope schema draw from, so a new error
   code is one edit and the consumer gets a generated enum to `switch` on.

## 3. Architecture at a glance

```
ONE Zod module (src/contract.ts) — pure, no D1/R2/WASM
  ├─ shared model schemas: DocumentListing, SearchHit, WriteOk, ReadOk,
  │                        ReadSourceOk, VersionListing, ErrorEnvelope, …
  ├─ ErrorCode enum (single source for jsonError + the envelope)
  └─ request/param/header schemas per route
         │
         ├─ z.infer<>  ─────────────►  src/core.ts TS types  (code can't drift
         │                              from the contract it's checked against)
         │
         ├─ registry + z.toJSONSchema ─► src/openapi.ts route registry
         │                                      │  assemble paths + components
         │                                      ▼
         │                               openapi.json  ──►  GET /openapi.json
         │                                      │
         │                                      ├─►  Flutter repo codegen (its choice)
         │                                      ├─►  future TS/Python/Swift clients
         │                                      └─►  docs/http-api.md links to it (narrative stays)
         │
         └─ same model schemas ───────►  src/mcp.ts  (tool inputSchema you already
                                          have; + outputSchema for envelopes — §7)

CI:  regenerate openapi.json → git diff --exit-code        (freshness)
     wrangler dev + parse live responses through Zod        (contract tests)
```

The unifying move: the shared **model** schemas (`DocumentListing` and friends)
are defined **once** and feed *both* doors — the HTTP OpenAPI document and the MCP
tool registration. The transports differ (REST vs JSON-RPC envelopes); the models
don't.

## 4. The Zod module — `src/contract.ts` (the bulk of the work)

A pure, standalone module (no D1/R2/WASM imports) so `test/contract.test.mjs`
runs under the Node strip-types runner, exactly like `search.ts` / `edit.ts` /
`conditional.ts` / `vector.ts`.

- **Port the `core.ts` response types to Zod**, then invert the dependency:
  `core.ts` does `export type DocumentListing = z.infer<typeof DocumentListingSchema>`
  (re-exported from `contract.ts`). **Type names and import sites stay stable** —
  only the *definition* moves from hand-written to inferred. This is the
  zero-behavior-change Phase 1.
- **Get nullability exact.** The #1 codegen footgun: `current_ver: number | null`
  (null on revoked), `current_size: number | null` (bytes purged on revoke),
  `title`/`description`/`slug` nullable, `tags` always-present `string[]`. A sloppy
  schema makes Dart generate non-null fields that throw at runtime on a revoked
  doc. The Zod schema is where this gets pinned once.
- **`ErrorEnvelope` + the `ErrorCode` enum.** `{ error: ErrorCode, message: string }`
  with the per-code context fields (`version_conflict` adds `current_version` +
  `expected`; `too_large` adds `limit` + `size`; `storage_cap_exceeded` adds
  `used`/`cap`/`this_write`; `slug_taken`/`slug_retired` add `slug`). Express as a
  discriminated union on `error`, so a consumer narrows context by code. `jsonError`
  in `src/index.ts` takes `code: ErrorCode` (compile-time-checked against the same
  enum) — closing the gap where a typo'd code string ships silently today.
- **Request/param/header schemas** per route: the write-metadata headers
  (`X-Doc-Title|Description|Tags|Slug`), `If-Match`/`If-None-Match`/`X-Content-SHA256`,
  the query params (`limit`/`cursor`/`tag`/`slug`/`q`/`mode`). These *document* the
  surface for OpenAPI; they do **not** replace the existing hand-validation in
  Phase 1–2 (§5, decision 6).
- **Register shared shapes with stable ids** (`z.globalRegistry` / `.meta({ id })`)
  so `toJSONSchema` emits `$ref`s and the client gets one named class per shape.

## 5. Wiring into the Worker

- **`src/openapi.ts`** — a route registry: an array of
  `{ method, path, summary, security, params, request, responses }` entries, one
  per `innerHandler` route (the dispatch in `src/index.ts:120`). The manual
  exact-match dispatch is **unchanged** — we annotate it, we don't reroute it. A
  small assembler walks the registry, calls `z.toJSONSchema()` on the registered
  components, and emits the OpenAPI document. `npm run build:openapi` writes
  `openapi.json` to the repo root (committed, so the CI diff check works offline).
- **`GET /openapi.json`** — serve the generated doc (import the built JSON as a
  bundled asset, or assemble on demand — the surface is small). Public, beside
  `/healthz` in the dispatch.
- **Security schemes** — model the three credential types from §Authentication of
  `http-api.md` as OpenAPI `securitySchemes` (`awh_` bearer, operator bearer,
  OAuth2 for `/mcp` discovery) and tag each operation with which it needs. This is
  what makes a generated client wire auth correctly.
- **Request validation (opt-in, later).** Once the request schemas exist, a route
  *may* adopt `Schema.safeParse` at its entry to replace bespoke parsing — but
  only where it doesn't change the deliberate behavior (e.g. **not** the
  silent-tag-sanitize / loud-slug-reject split in `metadata.ts`, which a generic
  validator would homogenize). Treat as case-by-case cleanup, not a sweep.

## 6. What OpenAPI can't express (prose stays — codebase-specific)

Be honest about the seams; these stay in the narrative layer *next to* the spec,
not in it:

- **Content negotiation on `GET /d/:id` and `GET /s/:slug`** — same URL returns an
  HTML shell / raw bytes / `401` keyed on the `Authorization` header. OpenAPI can
  list the media types, but the *conditional* is prose.
- **Visibility `404`-not-`401`** (the no-existence-oracle property) — a deliberate
  behavior the schema language has no vocabulary for.
- **Inheritance-on-omit** of write metadata, **`ETag`/`If-Match` → `304`/`412`**,
  **`X-Content-SHA256` → `422`** — the headers and status codes are declarable;
  the *semantics* are prose.
- **MCP (`/mcp`) is JSON-RPC, not REST** — OpenAPI doesn't describe it at all. That
  door stays formalized by the Zod tool schemas (shared models, different
  envelope), optionally emitted as a separate tool manifest (§7).

So OpenAPI is the **precise shape reference**; `http-api.md` is the **behavioral
contract**. They're complementary, which is exactly decision 7.

## 7. MCP convergence (one model, two doors)

`src/mcp.ts` already registers Zod `inputSchema`s. Two converging moves, both
*additive*:

- **Share the model schemas.** Where a tool returns a `DocumentListing` /
  `SearchHit` / `ReadSourceOk`, it returns the *same* `contract.ts` shape the HTTP
  surface does — so the envelopes can't drift between doors.
- **Adopt `outputSchema`.** The MCP SDK (`^1.29.0`) supports structured tool
  output; pinning the response envelopes there gives the MCP surface the same
  schema-checked guarantee the HTTP surface gets, from the same source. *Deferred*
  to a later phase — inputs first, outputs when the shared module exists.

## 8. Client generation (the consuming-repo boundary)

Out of scope **for this repo** by decision 4 — recorded here so the boundary is
explicit:

- The Flutter repo points its generator at `https://slopcafe.com/openapi.json` (or
  a pinned committed copy) and picks `dart-dio` / `dart` / `swagger_dart_code_generator`
  per its own toolchain constraints (JVM-available vs pure-Dart). It swaps its
  hand-written models for generated ones and switches on the generated `ErrorCode`
  enum.
- A new app (TS via `openapi-typescript`, Python, Swift) bootstraps off the **same**
  artifact with zero work here — that's the "easily bootstrap future apps" payoff.
- Our **only** obligation to those repos: keep `openapi.json` correct and stable,
  and version it (§14).

## 9. The narrative layer (`docs/http-api.md`) — kept, re-pointed

Decision 7 in practice:

- The prose **stays hand-authored** for everything in §6 (the reasoning).
- The **"Shared response shapes"** tables (`DocumentListing`, `SearchHit`,
  `ReadSourceOk`) stop being a hand-restated copy and instead **link to the
  generated component** (`/openapi.json#/components/schemas/DocumentListing`), or
  are validated-against it by a doc test so they can't silently disagree.
  *Deferred* refinement; Phase 1 just adds the link.
- The published Slopcafe copy (`slopcafe-http-api`) re-publish discipline is
  unchanged.

## 10. Drift enforcement — the real payoff (CI)

This replaces the CLAUDE.md honor system with a failing build:

1. **Spec freshness.** `npm run build:openapi` then `git diff --exit-code
   openapi.json` — a handler whose response shape changed without regenerating the
   spec fails CI. (Same idea as the `typecheck` gate today, but for the wire.)
2. **Contract tests.** Spin up `wrangler dev`, exercise each route, and
   `safeParse` the live response through its `contract.ts` schema. Catches the
   case the type system can't: the handler builds an object that *compiles* but
   omits a field or sends the wrong nullability. This is the first time the
   **runtime bytes** are checked against the contract.
3. **Client smoke (optional).** A downstream check that runs the consumer's
   generator against the new spec and typechecks — catches a breaking change
   before it reaches the Flutter repo. *Deferred* (cross-repo wiring).

## 11. New modules & tests

- **`src/contract.ts`** — the Zod schemas + `ErrorCode` enum (§4). Pure,
  standalone, unit-tested in `test/contract.test.mjs` under the strip-types runner
  (round-trip a representative object through each schema; assert the `ErrorCode`
  enum covers every code `jsonError` is called with — a reflection/grep test so a
  new code can't skip the enum).
- **`src/openapi.ts`** — the route registry + assembler (§5). Typecheck-covered;
  a unit test asserts the assembled document parses as valid OpenAPI 3.1 (shape
  check) and that every `innerHandler` route appears in the registry (a
  completeness test, so a new route can't ship spec-less).
- **`openapi.json`** — committed generated artifact; the CI diff target.
- Wire `test:contract` into the `npm test` chain (and `build:openapi` into
  `predeploy`, so a deploy can't ship a stale spec).

## 12. Docs-sync obligations (do at implementation time)

Per CLAUDE.md, the implementing commit(s) must, in lockstep:

1. **`CLAUDE.md`** — add `src/contract.ts` + `src/openapi.ts` + `GET /openapi.json`
   to "Where things live"; add a Conventions bullet that the **Zod schema is now
   the source of truth** and the old "update three surfaces by hand" rule is
   superseded by "edit `contract.ts`, regenerate, let CI check" (the human rule
   relaxes *because* a machine now enforces it).
2. **`docs/http-api.md`** — add the `GET /openapi.json` endpoint; re-point the
   "Shared response shapes" section at the spec (§9). **Re-publish the live
   `slopcafe-http-api` copy** (`0EtsEq6cnCeuOhBKO6ICzA`) byte-exact via the
   `create_publish_credential` + `curl --data-binary` recipe (`docs/README.md`).
3. **`docs/README.md`** — note the spec as a second machine-readable artifact
   alongside the prose.
4. **`agent-knowledge-host-spec-SOLO-v1.md`** — the contract surface gains a
   formal, generated representation; reflect it where the spec discusses the wire
   contract. **Re-publish `slopcafe-spec-solo`** (`ClcgZMaOEcworHzhr17gVQ`) if
   touched.
5. **`src/mcp.ts`** — only when §7 (`outputSchema`) lands; not in Phase 1–2.

## 13. Rollout phases

1. ✅ **DONE — Zod-ify the shapes, zero behavior change.** Built `src/contract.ts`;
   ported the `core.ts` response types to `z.infer<>` (13 types, re-exported so no
   importer changed); introduced the canonical `ErrorCode` enum and routed **both**
   error helpers through it (`jsonError` in `index.ts`, `operatorError` in
   `session.ts`). `test/contract.test.mjs` round-trips the schemas, pins the
   `ErrorCode` vocabulary, and scans `src/` so any literally-emitted code outside
   the enum fails the build (covers the un-typed `Response.json({error})` paths).
   `tsc` + all JS suites green; no user-visible change, no new endpoint, no wire
   byte changed. Internal error unions (`PublishErr` etc.) were deliberately left
   hand-written — the typed `jsonError` enforces their codes transitively, so
   inverting them was unnecessary risk. Discovery for this phase used a verified
   multi-agent inventory of every response shape (exact nullability), error code,
   and type-import site.
2. ✅ **DONE — Generate + serve + enforce.** Built `src/openapi.ts` (a dedicated
   `z.registry()` of every wire shape from `contract.ts` + a route registry of
   all 48 HTTP routes), an assembler emitting an OpenAPI 3.1 document via
   `z.toJSONSchema` (one named `#/components/schemas/X` per shape, `oneOf`
   `ErrorBody` discriminated on `error`), the committed `openapi.json` (`npm run
   build:openapi`, wired into `predeploy`), and the public `GET /openapi.json`
   route (assembled on demand, request-origin baked into `servers`). Added the
   wire-response schemas to `contract.ts` (`WriteResponse`/`RevokeResponse`/
   `ReadSourceResponse`/the list/admin/oauth shapes + the `ErrorBody` union) as
   `.omit({ ok: true })`-derived variants. `test/openapi.test.mjs` checks OpenAPI
   3.1 validity, `$ref` resolution, registry completeness (vs the documented
   surface AND a scan of `index.ts`'s static routes), and **freshness**
   (regenerate ⇒ byte-identical to the committed file — the CI gate
   `git diff --exit-code openapi.json`). `test/contract.test.mjs` round-trips the
   new wire shapes + asserts `ErrorBody` discriminates. The narrative
   (`docs/http-api.md`) gained a `GET /openapi.json` section; no other wire byte
   changed. **Phase 2b — the shared response-mapper — also landed:** `src/wire.ts`
   (`toWriteResponse` / `toEditResponse` / `toRevokeResponse`, typed against the
   `WriteResponse` / `EditResponse` / `RevokeResponse` schemas) replaced the
   THREE hand-copied field lists (`createDocument` + `updateDocument` in
   `index.ts`, `writeOkResponse` in `mcp.ts`) with one byte-identical, compiler-
   checked copy — the strip of the internal `ok` tag (and revoke's `ok`→`revoked`)
   now lives in exactly one place. The `wrangler dev` live contract tests (§10.2)
   remain a deferred follow-on.
3. **Consumer adoption.** The Flutter repo generates its client off the spec and
   deletes hand-written models (its work, not ours — §8). Re-point `http-api.md`'s
   shape tables (§9).
4. **(Deferred) Convergence + polish.** MCP `outputSchema` (§7); opt-in request
   validation on safe routes (§5); rendered `/docs` UI; cross-repo client-smoke CI
   (§10.3).

## 14. Versioning the contract

The API has **no `/v1` prefix** today and this note doesn't add one. Decisions:

- `openapi.json` carries an `info.version` (start `1.0.0`), bumped semver-style:
  **patch** = docs/clarification, **minor** = additive field/endpoint, **major** =
  a breaking shape change. The consuming repo pins or watches it.
- A **breaking** change (removing/retyping a field) is the one case that still
  needs human care — the contract tests will catch the server drift, but the
  *consumer* break is a coordination problem semver signals, not prevents.
- Path-versioning (`/v2/...`) stays *deferred* — single-tenant, single consumer
  today; revisit only when an external app pins to a shape we need to break.

## 15. Deferred / open questions

- **Rendered docs UI** (`/docs` via Scalar/Redoc) — nice-to-have, not required for
  codegen; deferred.
- **Request-side validation** from the same schemas — opt-in, route-by-route,
  *only* where it preserves deliberate behavior (§5). Not a sweep.
- **MCP `outputSchema`** — phase 4; inputs are already schema'd.
- **Generating `http-api.md`'s shape tables** from the spec (vs. linking) —
  deferred; link first, generate if the tables drift in practice.
- **Cross-repo client-smoke CI** — needs the consumer repo's cooperation; deferred.
- **Generator dep fallback** — if the in-repo Zod-4 assembler proves fiddly for
  `$ref`/security-scheme assembly, adopt `zod-openapi`; decision deferred to
  implementation, not pre-committed.
- **Heavy nullability/oneOf shapes** (the content-negotiated `GET /d/:id`, the
  HTML-or-JSON 404) may codegen awkwardly in some target languages — accept prose
  + a thin hand-written wrapper in the consumer for those few routes rather than
  contorting the spec.
