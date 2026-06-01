# Source retention — design note

**Status:** approved direction, **not built**. The operator approved **Case A**
(edit the source; see §3) on review of the A/B analysis. This note is the plan
of record. Sections tagged **[RESEARCH NEEDED]** are deliberately unresolved —
a separate agent will research them and revise this note before any code lands.
Everything not so tagged is a decided constraint.

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

## 8. Security: unsanitized bytes at rest — [RESEARCH NEEDED]

**Decided:** any surface that returns the raw source **S** is auth-gated (agent
key or operator), never public. The render path never serves S — only sanitized
**H** ever reaches a browser — so retaining source does not widen the *render*
attack surface.

**Open — research before building.** Retaining originals means R2 now holds
**un-sanitized** bytes at rest (whatever an agent submitted, including anything
the sanitizer would have stripped). The operator flagged malware / prompt-
injection concern. Questions for the research agent:

- **Ingestion-as-context injection:** an agent fetching raw source as context
  ingests bytes that may carry injected instructions the sanitized view would
  have neutralized. Does source retrieval need to be operator-only, or is
  agent-key sufficient? Should source reads carry a provenance/"unsanitized"
  warning to the consuming agent?
- **Stored-payload / malware posture:** does holding un-sanitized submissions at
  rest create any at-rest-scanning or handling obligation, even single-tenant?
- **Interplay with the residual-publisher posture** (`agent-knowledge-host-spec-
  SOLO-v1.md:166`, §8 — compromised-agent exfiltration, CSAM-law-not-gated-on-
  tenancy). Does a retrievable raw-source channel change that analysis?
- **Gating granularity:** operator-only vs agent-key for the source-read
  endpoint(s); whether `read_document representation:"source"` (an agent-facing
  MCP tool) is an acceptable disclosure surface or should be operator-gated.

Resolve this section before exposing any source-read surface.

## 9. Re-sanitization — deferred + [RESEARCH NEEDED]

Source retention **unlocks** re-sanitization but this note does **not** build it.
Recorded so the storage layout doesn't foreclose it.

**Leading proposal (operator-preferred):** **lazy re-heal on first read after a
new sanitizer profile release.** On read, if the stored `sanitizer_v` is behind
the current profile, re-sanitize from the retained source, re-store H, bump the
stamp — so the first reader after a profile bump pays the re-heal and everyone
after gets the healed bytes, with no batch job.

Questions for the research agent:

- Where the re-heal fires given today's **streaming** serve path (`serveRaw`
  streams R2 directly; a re-sanitize needs buffer + WASM). Read-time vs a
  separate trigger.
- Idempotency / thundering-herd on the first read after a bump (concurrent
  readers all racing to re-heal the same doc).
- Version stamping: does a re-heal mint a new `versions` row or rewrite H in
  place under the same version with a new `sanitizer_v`? (Append-only versions
  vs in-place re-store is a real fork.)
- Lazy-on-read vs an offline batch vs sanitize-at-serve entirely (Variant S from
  the earlier analysis) — and how each composes with the integrity/ETag story.

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
| 3 | Source-read surface is auth-gated | **Decided** |
| 3 | Unsanitized-at-rest threat model + gating granularity | **[RESEARCH NEEDED]** (§8) |
| 4 | Source counts toward storage cap | **Decided** |
| 5 | Re-sanitization (lazy-re-heal-on-first-read leading) | **Deferred + [RESEARCH NEEDED]** (§9) |
| — | `edit_document` / `read_document` rework | Decided in shape (§5); build after §8 resolves |
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
