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
before hitting an id-only route (`PUT /d/:id`, `/source`, `/links`). This closed
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
    output.dart        # human vs --json; stdout=result, stderr=notes
    errors.dart        # CliException + sysexits-style exit codes
    command_base.dart  # shared base: globals, config, client, input reading
    runner.dart        # CommandRunner + global flags
    commands/*.dart    # publish, update, edit, read, get, list, search, pack, find, links, health, whoami, spec, config
                       #   doc_render.dart — shared listing/hit row formatters (list/search/find)
  bin/slopcafe.dart    # entrypoint: maps UsageException/CliException/DioException → exit codes
```

Design choices worth recording:

- **Config precedence is a single pure function** (`mergeConfig`) separated from
  I/O, so it's exhaustively unit-tested. Flag → `SLOPCAFE_*` env → `AWH_*` env
  (compat with `scripts/doc-web.mjs`) → config-file profile → default base.
- **The write body is sent as a `Stream`, never a `List<int>`.** dio's default
  transformer would `toString()` a byte list (corrupting it); a stream with an
  explicit `content-length` is passed through raw — load-bearing for byte-exact.
- **`--if-match auto`** (the default) preflights the current version via a
  bodyless `HEAD /d/:id/raw` and sends `"v<n>"`, so optimistic concurrency works
  without the caller tracking versions; `--force` sends `*`.
- **Errors map to exit codes** via the typed `ApiError`: auth (`401`/`403`) →
  `77`, usage → `64`, everything else → `1`. The contract `error` code rides the
  message in brackets so a script can still grep it.

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

## Testing

- **Unit** (`test/format_test.dart`, `test/config_test.dart`): format inference,
  ETag/If-Match parsing, the ASCII-header guard, the full config precedence
  matrix, config round-trip, key redaction.
- **Mock-HTTP** (`test/client_test.dart`): a capturing dio `HttpClientAdapter`
  asserts exact request *shape* — method, path, `Authorization`,
  `X-Content-SHA256` = `sha256(body)`, content-length, `X-Doc-*` three-state,
  `If-Match`, the discovery query params (`GET /d` + `GET /d/search`), the
  `resolveDocId` id-passthrough-vs-slug-lookup branch, and error-envelope →
  `CliException`/exit-code mapping — with no network.
- **Edit logic** (`test/edit_test.dart`): the pure `applyEdits` find/replace
  (unique-or-`--replace-all`, missing/empty/non-unique rejection, literal
  replacement), the `--find`/`--replace` parser (comma-bearing values stay a
  single verbatim value — `addMultiOption` is `splitCommas: false`, otherwise a
  comma in a replacement over-splits into a phantom pair and the counts mismatch),
  and `looksLikePublicId` shape detection.
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
