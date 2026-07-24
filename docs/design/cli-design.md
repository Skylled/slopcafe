# CLI design note

**Status: BUILT (v0.1).** A Dart command-line client for the agent-key-reachable
HTTP surface, living in [`cli/`](../../cli/). The headless counterpart to the MCP
connector — for `claude` in headless mode, scripts, CI, and devices where a
single binary beats wiring an MCP server. Also makes **byte-exact publishing**
ergonomic wherever the CLI is installed.

## Scope

**Agent-key surface only**, deliberately — but the *whole* agent surface, so the
CLI is as capable as the MCP connector for a single agent:

- Writes: `POST /d` (publish), `PUT /d/:id` (update, with `If-Match` +
  `X-Content-SHA256`), and `edit` — a **client-side `edit_document`**: read the
  retained source, apply literal find/replace pairs, then `PUT` the result in the
  doc's own source format (`edit_document` has no HTTP route, so the CLI does the
  find/replace locally — mirroring the MCP tool's semantics: each `find` must
  match once unless `--replace-all`).
- Reads: `GET /d/:id/raw` (html), `/text` (markdown), `/source` (authored
  source), `/links` (link graph); `GET /s/:slug` and `/s/:slug/text`.
- **Discovery (added — full MCP parity):** `list` (`GET /d`), `search`
  (`GET /d/search`), and `pack` (`GET /d/pack`) — the agent-reachable HTTP twins
  of MCP `list_documents`/`search_documents`/`load_context_pack`. `find <slug>`
  prints a slug's `public_id` (the explicit slug→id resolver; the auto path is
  below). `pack <slug-or-id>` was the last missing verb (contract 1.5.0 added
  `GET /d/pack` for it): stdout is the pack as one markdown stream (root prose,
  then each member under a `---` separator with an HTML-comment header), the
  accounting + omitted-members menu go to stderr — so a boot prompt gets a
  one-call ingest and `--json` gets the raw `PackResponse` envelope. `from` is
  resolved server-side (live-slug-first), so `pack` skips `resolveDocId`.
- Meta: `GET /healthz`, `GET /openapi.json`; a key-acceptance probe (`whoami`).

**Every document command takes a `public_id` *or* a slug interchangeably.** The
identifier is auto-detected by shape (`looksLikePublicId` — 22 base64url chars)
and a slug is resolved to its `public_id` via `GET /d?slug=` (`client.resolveDocId`)
before hitting an id-only route (`PUT /d/:id`, `/source`, `/links`). A 22-char
*lowercase* name is ambiguous — it is BOTH a well-formed `public_id` and a
well-formed slug (`isAmbiguousDocIdentifier`; `zenyatta-shared-memory` bit
exactly this way, misrouting to `/d/:id` and 404ing "stale") — so since 0.2.3
`resolveDocId` disambiguates **live-slug-first**: probe `GET /d?slug=`, fall
back to the `public_id` reading on a miss (the same order the server uses for
`GET /d/pack?from=`); keyless callers skip the credentialed probe and keep the
assume-id guess, and `read --slug` still forces the slug reading. This closed
the original gap (the feedback that motivated this work): `update` and
`read --as source` were id-only and there was no agent-reachable slug→id lookup,
so a headless agent that knew only a `proj-*` slug couldn't edit the doc. The
server side of the fix is small — `GET /d` and `GET /d/search` are `requireReader`
-gated (agent key OR operator) wrappers over the *same* `listDocumentsCore` /
`searchDocumentsCore` the operator `/admin/documents*` routes use, so the only
difference from the admin twins is the auth door. Consistent with the
single-tenant trust model: an agent key already reads every doc by id, so
enumeration discloses nothing new.

Out of scope (operator-only over HTTP): the `/admin/*` management surface,
`DELETE`, and operator-only historical-version reads (`/d/:id/v/:n`). This keeps
the CLI a *single-principal* tool — one agent key, one trust level — and avoids
re-implementing the operator console.

## Language: Dart

Chosen so the client shares the **Flutter operator app's** language and, more
importantly, its **code-generation pipeline**. `dart compile exe` yields a
single static binary (the "drop on a headless box" story); `dart run` works for
iteration; `dart pub global activate` puts `slopcafe` on the PATH.

## The reuse win: generate the model layer from `openapi.json`

The Flutter app (`slopcafe_ui`) already has a bespoke, **pure-Dart** generator
(`tool/generate_api.dart`) that reads the backend's OpenAPI 3.1 spec and emits
freezed/json_serializable models with **correct 3.1 nullability** (the
`anyOf:[T,null]` case that crashes naive generators on revoked docs), plus the
`ErrorCode` enum from the `ErrorBody` `oneOf`. None of it touches Flutter.

Rather than extract a shared package (which would mean refactoring the working
app and coordinating a third repo), the CLI **vendors the generator** and
regenerates its own client from **this repo's** `openapi.json` — so the CLI's
models always match the backend this repo builds, and the CLI stays fully
self-contained for the eventual repo split. When split out, it carries its own
pinned `tool/openapi.json` + `tool/CONTRACT_VERSION`, exactly as `slopcafe_ui`
does today. The only hand-written piece reused verbatim is `api_error.dart` (the
dio-typed envelope glue, ~90 lines).

Alternative considered — a shared `slopcafe_api` package depended on by both the
app and the CLI — is the right move *if/when* a single source of truth across
both is wanted. It was rejected for v1 as more coordination than the lift saves.

## Architecture

```
cli/
  tool/generate_api.dart + openapi.json + CONTRACT_VERSION   # vendored generator + pinned spec
  lib/api/        # GENERATED model layer (+ api_error.dart, api.dart barrel)
  lib/src/
    config.dart        # pure precedence merge + config-file I/O (0600)
    format.dart        # format inference, ETag/If-Match parsing, ASCII-header guard
    client.dart        # dio wrapper: auth, X-Content-SHA256, X-Doc-*, If-Match; → CliException
    output.dart        # human vs --json; stdout=result, stderr=notes; emitJson/emitBody honour -o
    paths.dart         # path confinement: file args must resolve under CWD/SLOPCAFE_PATH_ROOT
    errors.dart        # CliException (code/status/fields/retryable) + exit codes + the JSON error envelope
    read_envelope.dart # the one-call read envelope: body + version/title/tags/status metadata
    command_base.dart  # shared base: globals, config, client, input reading, intOption
    entrypoint.dart    # the single error funnel: every throw → one CliException → one render
    runner.dart        # CommandRunner + global flags; stashes GlobalOptions so a throw can see --json
    commands/*.dart    # publish, update, edit, read, get, list, search, pack, find, links, health, whoami, spec, config
                       #   doc_render.dart — shared listing/hit row formatters AND the pack renderers
  bin/slopcafe.dart    # thin main(): delegates to entrypoint.dart
```

Design choices worth recording:

- **Config precedence is a single pure function** (`mergeConfig`) separated from
  I/O, so it's exhaustively unit-tested. Flag → `SLOPCAFE_*` env → `AWH_*` env
  (compat with `scripts/doc-web.mjs`) → config-file profile → default base.
- **The write body is sent as a `Stream`, never a `List<int>`.** dio's default
  transformer would `toString()` a byte list (corrupting it); a stream with an
  explicit `content-length` is passed through raw — load-bearing for byte-exact.
- **`--if-match auto`** (the default) resolves the expected version without the
  caller tracking versions; `--force` sends `*`. `update` preflights via a
  bodyless `HEAD /d/:id/raw` (reading the `ETag`); `edit` instead reuses the
  version it **already read** via `GET /d/:id/source` and guards THAT — so a
  concurrent write between the source read and the republish 412s (re-read and
  retry) rather than silently clobbering the newer version with stale-source
  edits, and `edit` never touches the `ETag` path at all.
- **Errors are machine-readable, not just human-readable** (since 0.4.0). The
  backend returns a fully typed error body and the generated layer models it, so
  throwing that structure away at the CLI boundary left an agent parsing prose.
  `CliException` now carries `errorCode` / `status` / `fields` / `retryable`, and
  under `--json` a single funnel (`entrypoint.dart` → `Output.fatal`) emits an
  envelope on **stderr**:

  ```json
  {"ok": false, "error": "slug_taken", "message": "…", "status": 409,
   "exit_code": 1, "retryable": false, "slug": "q3-report"}
  ```

  `error`/`message`/`exit_code`/`retryable` are always present; the server's
  context fields (the `slug` above, the two hashes on `integrity_mismatch`, the
  version context on `precondition_failed`) spread in alongside but can never
  overwrite a reserved key. A wire code newer than the pinned contract passes
  through verbatim rather than being flattened to `cli_bad_response` — that
  forward-compat case is why `CONTRACT_VERSION` exists. Human output is
  unchanged.

- **Exit codes are coarse; the envelope carries the detail.** `0` ok · `1`
  failure · `64` usage (**argv only** — never "the server said 404") · `66`
  not-found · `75` temp-fail · `77` no-permission. `slug_taken` and
  `precondition_failed` both exit `1`; `error` is how a caller tells them apart.
  Retry policy is explicit: `408`/`429`/`5xx` and a refused/reset connection are
  `75` + `retryable: true` (the flaps worth riding out), but a **failed DNS
  lookup is `1` + `retryable: false`** — an unresolvable host is a
  misconfiguration, and marking it retryable would send a harness into an
  infinite loop over a typo'd `--base`.

- **The two transport budgets are not symmetric, and that is load-bearing.**
  Verified against dio's `IOHttpClientAdapter`: `receiveTimeout` is an
  *inactivity* bound, but `sendTimeout` wraps `addStream(body)` and so caps
  **total upload duration** — a healthy but slow uplink aborts at the deadline
  while bytes are still flowing. They therefore get separate defaults (receive
  60 s, send 300 s, connect 15 s). Sharing one 60 s budget would demand ~87 KB/s
  to publish a 5 MiB document and would break byte-exact publishing, the CLI's
  headline feature, on exactly the large files it exists to serve. `--timeout`
  can only ever *lower* a budget.
- **File arguments are path-confined** (`paths.dart`, since 0.3.0). Every
  user-supplied file path (`publish`/`update <file>`, `-o <file>`) must resolve
  — **after symlink resolution** — under a single allowed root: the CWD, or
  `SLOPCAFE_PATH_ROOT` when set (must exist; canonicalized). Sandboxed agents
  drive this CLI and their harness can't see inside the process, so without the
  guard `slopcafe publish ~/.ssh/id_rsa` exfiltrates anything the process can
  read. There is deliberately **no off-switch**: the initial build registered
  `--unsafe-paths` + `SLOPCAFE_UNSAFE_PATHS=1`, but both were commented out
  before release (operator decision) — a built-in disable is a free escape
  hatch for exactly the callers the guard targets. The commented plumbing in
  `runner.dart` / `command_base.dart` / `paths.dart` is the re-add seam if a
  real need appears; if restored, the hatches must not become config-file
  settings (a stored knob is invisible at call time). `SLOPCAFE_PATH_ROOT` is
  itself hardened so the widening knob can't be spelled into an off-switch
  (`pathRootRejection`): the root must be an **ancestor or descendant of the
  CWD** (no unrelated subtrees), never the filesystem root, and must not
  contain `$HOME` — on a dev machine `~/Repos` is grantable but `~` (and
  `~/.ssh` with it) is not. Still not a hard security boundary — argv/env
  control ultimately implies running arbitrary code — but the residual widening
  is bounded (along the CWD's lineage, below home) and every use is an
  explicit, visible act in the invocation a harness permission prompt or audit
  log shows, never the silent default. Both chokepoints (`readInput`/`emitBody` in
  `command_base.dart`) read/write the *canonical* path the check approved, so a
  symlink can't split "what was checked" from "what was opened"; internal CLI
  paths (the XDG config file) are not confined — only command-line values.
  stdin/stdout (`-`) always pass.

## The dart:io header limitation (a real constraint)

The backend reads `X-Doc-*` metadata as **UTF-8** (issue #31) because browsers
and `curl` send raw bytes. **`dart:io`'s `HttpClient` rejects any header-value
byte ≥ 0x80** (a `FormatException`), so a Dart process *cannot* transmit a
non-ASCII title/description via a header at all — the latin1 round-trip trick
that works elsewhere is impossible here. The CLI therefore validates metadata up
front and **fails with actionable guidance** instead of an opaque transport
error: for a non-ASCII title, author it as the document's H1 and omit `--title`
(the server derives it); the document **body** is unaffected (it's a byte
stream). `--tags`/`--slug` are ASCII-only by the backend's own charset rules, so
only title/description are touched. A custom raw-socket dio adapter could lift
this, but it's not worth the fragility for v1.

This is **working-as-intended** in the Dart SDK, not a bug we can wait out:
[dart-lang/sdk#53914](https://github.com/dart-lang/sdk/issues/53914) (closed —
the maintainers' stance: header field values "do not define any encoding… it is
the user's responsibility to encode" non-ASCII), with the history in
[#41688](https://github.com/dart-lang/sdk/issues/41688) (a 2020 change made the
validator strict; Dart *used* to pass header bytes through as Latin-1) and the
open RFC 5987 request [#55156](https://github.com/dart-lang/sdk/issues/55156).
Verified empirically on Dart 3.12.1: the outgoing validator throws on **every**
byte ≥ 0x80 — even a single Latin-1 code unit (`0xE9`) — so the
`latin1.decode(utf8.encode(value))` round-trip a maintainer once suggested no
longer passes validation either. (The same wall applies to the Flutter app if it
ever sets a non-ASCII `X-Doc-*` via a `dio`/`HttpClient` header.)

## The missing-`Accept` header (why the client sends `Accept: */*`)

`dart:io`'s `HttpClient` sends **no `Accept` header** by default (unlike `curl`,
which sends `Accept: */*`, or a browser). Cloudflare treats a request with no
`Accept` header differently: it serves `/d/:id/raw` (and `/text`, `/source`) via
a chunked/transform path that **strips the strong `ETag`** the Worker set — the
version signal simply vanishes before the response reaches the client. The Worker
is not involved and not at fault (verified: an authed `HEAD` from `curl` returns
`ETag: "v<n>"`; the identical request from `dart:io` comes back with no `ETag`,
and replaying `dart:io`'s exact header set from `curl` — same `Accept`-less
request — reproduces the strip).

Because the CLI reads the current version from that `ETag` (`currentVersion` for
`update --if-match auto`, and the `version` field on every read), the missing
header made `update --if-match auto` fail with **"no ETag" even for a single
writer**, and left every read's reported version silently `null`. The fix is a
one-liner: the client sends `Accept: */*` on every request (see `client.dart`
`BaseOptions.headers`) — exactly what `curl`/browsers send. With it present the
tag survives (Cloudflare weakens it to `W/"v<n>"` under gzip, which
`parseVersionTag` already handles; the CLI re-synthesizes a fresh strong
`"v<n>"` for the outgoing `If-Match`, so the server's strong-only rule is met).
Note `Accept: text/html` did **not** restore the tag in testing — only `*/*` —
so keep it broad. (`edit --if-match auto` sidesteps this entirely by reusing the
source-read version, per the `--if-match auto` note above; the header still
matters for `update` and for the reported read version.)

## Testing

- **Unit** (`test/format_test.dart`, `test/config_test.dart`): format inference,
  ETag/If-Match parsing, the ASCII-header guard, the full config precedence
  matrix, config round-trip, key redaction.
- **Mock-HTTP** (`test/client_test.dart`): a capturing dio `HttpClientAdapter`
  asserts exact request *shape* — method, path, `Authorization`,
  `X-Content-SHA256` = `sha256(body)`, content-length, `X-Doc-*` three-state,
  `If-Match`, the discovery query params (`GET /d` + `GET /d/search`), the
  `resolveDocId` id-passthrough / ambiguous-probe / slug-lookup branches, and
  error-envelope → `CliException`/exit-code mapping — with no network.
- **Path guard** (`test/paths_test.dart`): the pure containment check (the
  `/a/bc`-vs-`/a/b` prefix trap, trailing-separator root, case-insensitive
  mode), root resolution (`SLOPCAFE_PATH_ROOT` canonicalized + must-exist; a
  pin that the disabled `SLOPCAFE_UNSAFE_PATHS` off-switch is *ignored*), the
  pure `pathRootRejection` matrix (fs-root / unrelated-subtree / contains-home
  rejections, ancestor widening, Windows drive-root case-insensitivity), and
  real-filesystem escapes against temp dirs — `../` traversal, symlinks
  pointing out of the root (input, existing output, and
  new-output-under-a-symlinked-parent), and the reserved null-root passthrough.
- **Edit logic** (`test/edit_test.dart`): the pure `applyEdits` find/replace
  (unique-or-`--replace-all`, missing/empty/non-unique rejection, literal
  replacement), the `--find`/`--replace` parser (comma-bearing values stay a
  single verbatim value — `addMultiOption` is `splitCommas: false`, otherwise a
  comma in a replacement over-splits into a phantom pair and the counts mismatch),
  and `looksLikePublicId` shape detection (`looksLikeSlug` + the
  `isAmbiguousDocIdentifier` 22-char-overlap cases live in
  `test/format_test.dart`).
- **Live**: validated end-to-end against a local `wrangler dev` (publish →
  read → `--if-match auto` update → source/links), including a byte-exact
  `source_sha256` match and the UTF-8-body / non-ASCII-header behaviors.

## Not bundled, not mirrored

This note is repo-only (it presumes repo access), like `cloudflare-setup.md` —
**not** mirrored on Slopcafe. The CLI is a *consumer* of the HTTP API and adds no
API surface, so it triggers none of the wire/spec sync obligations; `cli/`'s own
README is the user-facing doc and travels with the future repo split.

## Deferred

- Extract a shared `slopcafe_api` package if a single model source across the app
  and CLI becomes worthwhile.
- A custom dio adapter for raw (UTF-8) header bytes, if non-ASCII metadata over
  the CLI ever matters more than the H1-derive workaround.
- Operator-token mode (would unlock list/search/delete) — only if the CLI's
  single-principal scope proves too narrow.
