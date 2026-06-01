# Source retention — design note

**Status:** approved direction, **building (Case A)**. The operator approved
**Case A** (edit the source; see §3) on review of the A/B analysis. This note is
the plan of record. The two former **[RESEARCH NEEDED]** gates have been
researched and operator-ratified: **§8 (unsanitized-at-rest threat model +
gating) is RESOLVED** — agent-key gating, provenance tagging, revoke purges
`.src` — and code may build against it; **§9 (re-sanitization-from-source)
remains deferred** but is now unblocked, with the storage-layout constraints it
needs honored. Everything not tagged deferred is a decided constraint.

This note follows the shape of `byte-exact-publish-design.md`: problem → root
cause → decision → mechanics → deferred/research. The full Case A vs Case B
reasoning is preserved in the appendix so the decision is auditable.

---

## 1. Problem

An agent hit this in practice: **`edit_document` silently converts an
originally-Markdown document into an HTML one**, and that loses the reading
theme. A Markdown doc renders inside an automatic reader theme (centered column,
typography, light/dark — `READER_THEME_CSS` in `src/serve.ts`); an HTML doc is
assumed author-styled and served verbatim. The theme decision keys on the
**current version's** `source_format` (`serveRaw`, `src/serve.ts:744`). Because
`editDocumentCore` can only edit the stored *sanitized HTML* and re-stores it as
`source_format: "html"` (`src/core.ts:743`), any edit to a Markdown doc flips it
to HTML and strips the theme from that version on.

This is already documented as a known wart with a workaround
(`skills/publishing.md:122`), but documentation didn't prevent the surprise.

## 2. Root cause: convert-and-discard, and a column doing two jobs

The defect is a direct artifact of **convert-and-discard** — the deliberate v1
decision to retain only the sanitized output and throw the submitted source away
(`agent-knowledge-host-spec-SOLO-v1.md:133`). Because the source is gone, an edit
has nothing to edit *but* the sanitized HTML, so it must re-store as HTML.

Underneath that, `versions.source_format` is doing two unrelated jobs:

- **Provenance** — which input pipeline parsed the bytes (`markdownToHtml` vs
  identity). Its designed purpose (`src/core.ts:44`). It has **no other live
  consumer**: `DocumentListing` doesn't even select it.
- **Presentation intent** — whether `serveRaw` injects the reader theme. The
  serve path quietly repurposed the column for this.

These coincide at publish and **diverge under edit**. The presentation intent of
a typo-fix didn't change; only the provenance tag flipped — and the theme rode
on the provenance tag.

The spec already names the fix: re-healing stored docs "would require either
re-supplying the source bytes or **reversing the no-original-retention
decision**" (`agent-knowledge-host-spec-SOLO-v1.md:140`). The re-sanitization
story is the advertised reason to reverse it; this bug is a second thing that
falls out of the same reversal. Reversing convert-and-discard addresses the bug
**correctly** rather than papering a sticky flag over an honestly-conflated
column — and it's already under consideration after security audits, so the two
motivations converge.

### The three representations (the invariant that governs everything)

Once source is retained there are **three** representations of an HTML doc, not
two:

- **S** — the source as submitted (Markdown, or original HTML).
- **H** — sanitized HTML, stored at `r2_key`; the *only* thing that renders.
- **M** — `htmlToMarkdown(H)`, the derived ingest view `read_document` markdown
  returns *today*.

The load-bearing invariant: **the representation `read_document` hands back and
the representation `edit_document` matches against MUST be the same one.** The
current design enforces this with `read html → H` and `edit → H`. Any redesign
must keep some version of this invariant or reintroduce the silent-miss failure
the current design fought to prevent (an `old_string` taken from a
representation nobody stores).

## 3. Decision — Case A: edit the source

Approved. Three parts:

1. **Storage:** retain source **S** for **both** doc kinds (Markdown and HTML),
   one source blob per version, alongside the existing sanitized **H** blob.
2. **Edit target:** `edit_document` matches against **S** for both kinds, then
   re-renders (md→html or identity) → re-sanitizes → stores a fresh `(S, H)`
   pair. `source_format` stays honest; the theme decision becomes correct *by
   construction* and `serveRaw` is untouched.
3. **Mechanism (how an agent obtains the original):** `read_document` keeps
   returning the **rendered** view by **default** (H, or M for markdown) —
   back-compat for every existing consumer — and exposes **S by explicit
   request** (a `representation: "source"` knob, see §5). `edit_document` matches
   the requested source. Source reads carry the existing `stripped` /
   `will_not_render` advisories so "the live render differs from this source
   here" is surfaced, never silent.

**Why Case A and not Case B (edit the sanitized bytes).** The decisive
asymmetry is what happens to the retained source over time:

- **Case B** (keep editing sanitized H for HTML docs) lets the retained source
  go **stale on the first edit, silently and permanently** — you cannot fold a
  post-sanitize edit back into a pre-sanitize source, so "retain the original"
  decays to "retain the original as of the last full republish." That erodes the
  audit motive (re-sanitize-from-source re-heals *old* content) — the very
  reason convert-and-discard is being reversed.
- **Case A** keeps **S** authoritative per version, in lockstep with H, which is
  exactly what re-sanitization and forensic re-verification need.

Case A's cost is the inverse footgun — `read_document` *source* can return bytes
that differ from what renders — but only for docs the sanitizer actually touches
(`modified: true`), which are already instrumented with advisories. Narrow,
conditional, instrumented (Case A) beats broad, unconditional, silent (Case B).
Full A/B reasoning in the appendix.

## 4. How the bug dissolves

- A Markdown doc edits its **Markdown source** → re-render → re-sanitize → the
  new version is *still Markdown*. `source_format` stays `markdown` honestly and
  `serveRaw` injects the theme as before. **No change to the serve path.**
- An HTML doc edits its HTML source → stays HTML. Correct, unchanged behavior.
- Secondary win: for Markdown docs, **read-markdown == edit-markdown**. The
  current "read with `format:"html"` before copying an `old_string`" caveat and
  the "editing flips a Markdown doc to HTML" warning in `skills/publishing.md`
  both get **deleted**, not rewritten. The agent contract gets *simpler*.

## 5. The `edit_document` / `read_document` rework (the hard part)

This is the genuine rebuild the operator anticipated.

**`read_document`** gains a representation axis distinct from the existing
`format` (html/markdown) output knob:

- Default (unspecified): **rendered** — unchanged from today (H for html-format,
  M for markdown-format). Preserves back-compat for the Flutter app and existing
  agents.
- `representation: "source"` (name TBD): returns **S** in its authored format,
  plus `source_format` and the `stripped` / `will_not_render` advisories so the
  agent knows where the live render diverges. This is the read an agent does
  *before editing*.
- The response must echo which representation was returned so an agent can't
  confuse source for rendered.

**`edit_document`** matches against **S**:

- Match, the `replacements` count, and sequential multi-edit semantics all
  operate on the source string (Markdown for md docs, HTML for html docs).
- After applying edits, the pipeline re-renders (`markdownToHtml` for md,
  identity for html) and re-sanitizes, producing the new `(S, H)` pair. `S` is
  the post-edit source; `H` is its sanitized render.
- `modified` is redefined: it now describes the sanitizer's effect on the
  *re-rendered* output, one step further removed from the agent's diff than
  today. Keep `replacements` as the "my patch landed" signal; document that
  `modified` is about sanitization, not about the edit.
- An agent that lazily edits against a *rendered* read (H/M) instead of a source
  read will simply get a loud `edit_no_match` when S≠H — a self-correctable,
  non-silent failure. The tool descriptions must steer: read with
  `representation:"source"` before editing.

**Pipeline note (do not regress):** `editDocumentCore` today delegates to
`updateDocumentCore` with a hardcoded `"html"` format. Under Case A the edited
artifact's format is the doc's own `source_format`, and `prepareForStorage` runs
the matching pipeline. The core must thread the doc's retained `source_format`
through the edit path — **not** assume html — or a Markdown source gets fed to
the HTML identity path (or vice versa) and corrupts.

## 6. Storage model

- One additional R2 object per version for the source, e.g. key
  `<docId>/v<n>.src` next to the existing `<docId>/v<n>` (exact scheme TBD at
  build). Stamp its content-type from `source_format`
  (`text/markdown` | `text/html`).
- **Cap accounting — DECIDED:** source bytes **count toward** the fleet storage
  cap (`checkStorageCap`). Single-tenant — the cap is the literal R2 budget, so
  every stored byte counts. Retention roughly doubles per-doc storage; the cap
  was recently raised 100 MiB → 2 GiB, so there's headroom.
- Dedup-when-identical (store one blob when S == H, the clean-HTML case) is an
  **optional optimization, deferred.** Start by storing the source
  unconditionally for clarity; revisit only if storage pressure warrants. (Note
  it never helps Markdown docs — S is a different language from H, always
  distinct.)

## 7. Legacy backfill — manual, no code path (DECIDED)

**There is no legacy fallback branch in code.** `edit_document` may assume every
live document has a retained source. The ~dozen existing dogfood documents are
migrated once, by hand, by the operator. Rationale (operator): a one-time manual
migration over a handful of owned documents beats a permanent legacy code path —
limited blast radius vs. forever-maintained branch.

Precise backfill rule (the falsification differs by kind — **this is the subtle
part**):

- **HTML docs** (`source_format = "html"`): set source **S := the sanitized
  bytes H**. Benign — for a clean doc S == H anyway, and the identity re-render
  pipeline handles it correctly on the next edit.
- **Markdown docs** (`source_format = "markdown"`): **do NOT** copy the
  sanitized HTML in as the source — it's HTML, and the edit pipeline would feed
  it to `markdownToHtml` and corrupt it. Instead:
  - **Preferred:** re-publish from the *true* repo source. Several live docs are
    repo-backed and already published byte-exact from their `.md`:
    `docs/http-api.md` (slug `slopcafe-http-api`),
    `agent-knowledge-host-spec-SOLO-v1.md` (slug `slopcafe-spec-solo`),
    `agent-knowledge-host-spec-PLATFORM-v2.md` (slug `slopcafe-spec-platform`).
    Re-publishing these under the new write path stores their real Markdown
    source — a perfect backfill, no falsification.
  - **Fallback** (no repo source — e.g. the homepage doc
    `hdbOcFnhL1y9fe0tWpBvXA`, or any ad-hoc dogfood doc): set
    **S := `htmlToMarkdown(H)`** so the stored source is real Markdown that
    round-trips through the pipeline. Lossy vs. the vanished original, but
    structurally valid.
- Enumerate the actual set with `list_documents` at migration time; the list
  above is the known repo-backed subset, not necessarily exhaustive.

## 8. Security: unsanitized bytes at rest — RESOLVED

Researched and operator-ratified. The full ratified decisions live in
`/tmp/source-retention-decisions.md` (this session); the resolution in brief:

**Gating — agent-key, NOT operator-only (the one genuine fork).** Both
source-read surfaces require a valid agent key (Door B `awh_` bearer, or an
OAuth-resolved `agentId`) — the same auth floor as `read_document` today. Never
public, never unauthed. The render path stays **H-only** and never serves S.
Rationale (bake an abbreviated form into a code comment near the source-read
surfaces, mirroring the CLAUDE.md "don't fix the session signing key to the
pepper" guardrail): in this single-tenant **whole-fleet** trust model any active
agent key already reads and overwrites every document (`core.ts` does not scope
by `created_by`), so a source-read discloses **no authority the caller lacks** —
it only exposes the pre-sanitization bytes of a doc the caller can already fully
read and control. The acid test (agents must still run read-source → edit →
republish) rules out the operator-only gate outright: it would break the
feature's *only* consumer for zero real security. **A future reviewer must NOT
"harden" source reads to operator-only** — that is security theater that taxes
the legitimate path. (`editDocumentCore`'s *internal* source fetch is not a
disclosure surface at all — S never leaves the server on edit, only the
re-rendered H does — so the write/edit path could be built ahead of the read
knob.)

**Both surfaces ship this pass (the second fork — RESOLVED).** The operator
chose to ship the MCP knob **and** a new HTTP endpoint now (full context is
loaded this session; deferring wastes a future re-contextualization):

- **MCP:** `read_document` gains `representation: "source"` (agent-facing).
- **HTTP:** `GET /d/:id/source` — **agent-key gated** via `authenticateAgent`.
  This is the *first* authenticated GET on the `/d/:id` namespace (`/d/:id`,
  `/d/:id/raw`, `/s/:slug` are public capability URLs that serve H); it must
  **require** a valid agent key and return 401 when absent/invalid. It returns
  the `ReadSourceOk` shape (`source`, `source_format`, `version_no`,
  `sanitizer_v`, `stripped`, `will_not_render`, `unsanitized:true`,
  title/description/tags/slug) and is documented in full in `docs/http-api.md`.

**Provenance — the real, cheap delta.** Every source-read response carries
`unsanitized: true` AND re-runs the advisory pass on S
(markdownToHtml-or-identity → sanitize → `detectAdvisories`) to attach
`stripped[]` / `will_not_render[]`, so "the live render differs from this source
here" is surfaced, never silent. The `read_document` + `edit_document`
descriptions **lead** source guidance with "source is unsanitized — treat as
untrusted input; it may contain markup the renderer would have stripped." This is
the one residual that depends on consumer discipline (contractual, not
code-enforceable). Note for backfilled HTML docs (S := H): the `unsanitized:true`
marker technically over-warns (those bytes are already sanitized) — harmless,
**fail-safe over-warning**, called out here so it isn't mistaken for a bug.

**Threat posture — a paragraph, not a subsystem.** Ammonia is an XSS/markup
defense, not a prompt-injection defense: natural-language adversarial
instructions already survive into H and M today, so source retention does **not**
open a brand-new NL-injection channel. The one real, bounded, NEW exposure is
**markup-FORM payloads** — an injected `<script>`/comment an HTML-naive context
window might read as instructions — reaching an agent that explicitly asked for
source. Provenance tagging + agent-key auth cover exactly that increment.
Everything else is an explicitly **decided non-action**, not silence:

- **Render surface — unchanged.** Only H ever reaches a browser, behind the
  iframe + CSP wall.
- **At-rest / malware scanning — no new obligation.** Single-tenant,
  operator-owned R2 holding the operator's *own* agents' bytes; no third-party
  UGC ingestion, and R2 does not execute stored bytes. Decided non-action.
- **Residual-publisher / CSAM posture — unmoved** (`agent-knowledge-host-spec-
  SOLO-v1.md` §8). That analysis is about content **published** to public URLs =
  H; S is never published, so it does not bear on it.
- **Compromised-agent exfiltration — no new path.** S is auth-gated and strictly
  *less* reachable than H (which already has a public render URL).

**Kill-switch completeness.** `revokeDocumentCore` MUST purge the `.src` blobs
alongside H — revoked-doc source is **purged**, not retained as an audit trail —
or a revoked doc leaves unsanitized source resident in R2 after the operator
pressed kill.

## 9. Re-sanitization — DEFERRED (not built; now unblocked)

Source retention **unlocks** re-sanitization but this note still does **not**
build it. It is explicitly deferred to a follow-up. What changed at resolution
time: the §8 build is required to **honor §9's layout constraints** so the
in-place lazy-re-heal fork stays open — the research pass confirmed these and the
operator ratified them. **Constraints now honored by the as-built §8 work:**

- **Per-version derivable `.src` key.** Source lives at `${docId}/v${n}.src`, a
  dot-suffix sibling of the H key `${docId}/v${n}` — per-version and derivable
  from `(docId, version_no)`, **not** content-addressed and **not** doc-level. An
  in-place heal must overwrite H/S at a *stable per-version address*; embedding a
  content-hash or `sanitizer_v` in the key would foreclose that fork (and is why
  §6's dedup-when-identical stays deferred — content-addressing would close this
  door).
- **`sanitizer_v` stays per-version, readable, and mutable.** It is BOTH the
  re-heal trigger (stored stamp vs current profile) and the post-heal stamp.
  Migration 0008 adds **no** immutability mechanism — no generated/derived
  column, no CHECK, no trigger pinning it — so a heal can `UPDATE`
  `versions.sanitizer_v`. D1 is the authoritative copy the trigger reads; R2
  `customMetadata` is a secondary copy a heal may leave stale or update
  deliberately.
- **`source_format` recoverable per version, preserved across a heal.** A re-heal
  re-renders the *existing* S with the matching pipeline (`markdownToHtml` for
  markdown, identity for html) and must keep `source_format` unchanged (never a
  format change) — which is also what keeps `serveRaw`'s reader-theme decision
  correct after a heal.
- **`size_bytes` / `source_size_bytes` stay per-version and mutable.** An
  in-place heal changes H's byte length, so both remain `UPDATE`-able on an
  existing row or the cap drifts. Append-only applies to *rows*, not to
  per-version *fields* — different axes; do not conflate them.
- **FTS body stays derived from H** (`htmlToMarkdown(cleanedHtml)`), never from
  S. A future heal must re-derive the FTS body from the *healed* H inside the
  same batch.
- **`serveRaw`'s D1-lookup-before-R2-stream shape is preserved.** It SELECTs
  `sanitizer_v`/`source_format` before opening the R2 stream — the hook point a
  read-time heal needs (the streaming path can't buffer+WASM inline). The §8 work
  does not collapse that lookup into the stream open.

**Both forks of §9's open question stay open:** mint a new `versions` row vs.
rewrite H in place under the same version with a new `sanitizer_v`. In-place
needs the stable per-version keys + mutable `sanitizer_v`/`size_bytes` above;
new-version needs S carried forward, which is automatic because every write now
stores S per version.

**Still open for the §9 follow-up (unchanged questions):**

- Where the re-heal fires given the **streaming** serve path (read-time vs a
  separate trigger).
- Idempotency / thundering-herd on the first read after a profile bump.
- Version stamping: new `versions` row vs in-place re-store (the real fork above).
- Lazy-on-read vs offline batch vs sanitize-at-serve (Variant S) — and how each
  composes with the integrity/ETag story.

## 10. Doc / spec sweep (rollout checklist)

Per the CLAUDE.md API-surface and spec-sync rules, the build commit(s) must
update, in lockstep:

- **MCP tool descriptions** (`src/mcp.ts`): `read_document` (the new
  `representation` axis + source semantics), `edit_document` (matches source;
  read-source-first guidance; redefined `modified`), and the write tools as
  needed.
- **`docs/http-api.md`**: any new source-read endpoint/param, response-shape
  changes, status codes — then **re-publish** the live copy (slug
  `slopcafe-http-api`, public_id `0EtsEq6cnCeuOhBKO6ICzA`) byte-exact.
- **`skills/publishing.md`**: **delete** the "Editing flips a Markdown doc to
  HTML" warning (§122) and the "read with `format:"html"` before editing"
  caveat; add the source/edit model.
- **`agent-knowledge-host-spec-SOLO-v1.md` §5**: promote convert-and-discard
  from a deferred simplification to **as-built reversed**; update the
  "re-sanitization is deferred — not built" note (line 140) to reflect that
  source is now retained and re-sanitization is unblocked (state whether built).
  Re-publish (slug `slopcafe-spec-solo`, public_id `ClcgZMaOEcworHzhr17gVQ`).
- **`agent-knowledge-host-spec-PLATFORM-v2.md`**: lineage note only if the SOLO
  change diverges from what the frozen platform spec documents — it is not
  edited for SOLO-scope changes.

## 11. Status summary

| # | Item | Status |
|---|------|--------|
| — | Direction: Case A (edit the source) | **Decided** |
| 1 | Retain source for both doc kinds | **Decided** |
| 2 | Legacy: manual backfill, no code path | **Decided** (§7 — mind the md rule) |
| 3 | Source-read surface is auth-gated (agent-key, not operator-only) | **Decided** |
| 3 | Unsanitized-at-rest threat model + gating granularity | **Resolved** (§8) |
| — | Ship both surfaces (MCP `representation:"source"` + HTTP `GET /d/:id/source`) | **Decided** |
| 4 | Source counts toward storage cap | **Decided** |
| 5 | Re-sanitization (lazy-re-heal-on-first-read leading) | **Deferred** — unblocked, layout honored (§9) |
| — | `edit_document` / `read_document` rework | Decided in shape (§5); §8 resolved — clear to build |
| 6 | Doc/spec sweep | **Decided** (§10, at build time) |

---

## Appendix — the Case A vs Case B analysis (preserved)

The edit-target choice came down to which representation `read`/`edit` operate on
for **HTML** docs (Markdown clearly edits its source under any source-retaining
design).

### Case A — edit the source (both kinds), source fetched by request

- `read_document` returns rendered (H/M) by **default**; `representation:
  "source"` returns S. `edit_document` matches S, re-renders, re-sanitizes.
- **For:** the editor-model agents expect (edit source, a build step produces
  output); keeps retained source **authoritative per version** — the audit's
  whole point; symmetric across kinds; `source_format` honest; theme correct by
  construction.
- **Against:** `read` gains two meanings (mitigated: source is opt-in, response
  echoes representation); the inverse footgun — source can show bytes that
  differ from the live render — **but only when `modified`**, and those cases
  already carry advisories; the real price is the `edit_document` rework.

### Case B — edit the sanitized bytes for HTML; Markdown edits its source

- HTML keeps today's rule (`edit` matches H, returned by default); only Markdown
  edits its source. No new representation knob.
- **For:** preserves "what you edit is exactly what renders" for HTML; zero
  change to HTML docs; minimal blast radius (rework scoped to Markdown, which is
  where the bug is).
- **Against:** retained HTML source **goes stale on the first edit, silently and
  permanently** (post-sanitize edits can't be folded back into a pre-sanitize
  source), partially defeating the audit motive; permanent asymmetry —
  `edit_document` means "patch source" for md and "patch rendered" for html, and
  `read` markdown means "editable source" for md docs but "derived ingest" for
  html docs.

### The crux

Case A's risk is **narrow, conditional, instrumented** (read can show non-live
bytes, only for sanitizer-touched docs, already advised). Case B's risk is
**broad, unconditional, silent** (retained source rots after any HTML edit, no
signal). Because the audit motive is what put source retention on the table at
all, Case A is correct. Case B would be right only if the goal collapsed to "just
fix the Markdown theme bug" with no per-version source-fidelity ambition — a
coherent but cheaper destination that retains Markdown source only. The operator
chose Case A.
