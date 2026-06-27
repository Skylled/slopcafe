# CLI design note

**Status: BUILT (v0.1).** A Dart command-line client for the agent-key-reachable
HTTP surface, living in [`cli/`](../../cli/). The headless counterpart to the MCP
connector — for `claude` in headless mode, scripts, CI, and devices where a
single binary beats wiring an MCP server. Also makes **byte-exact publishing**
ergonomic wherever the CLI is installed.

## Scope

**Agent-key surface only**, deliberately:

- Writes: `POST /d` (publish), `PUT /d/:id` (update, with `If-Match` +
  `X-Content-SHA256`).
- Reads: `GET /d/:id/raw` (html), `/text` (markdown), `/source` (authored
  source), `/links` (link graph); `GET /s/:slug` and `/s/:slug/text`.
- Meta: `GET /healthz`, `GET /openapi.json`; a key-acceptance probe (`whoami`).

Out of scope (operator-only over HTTP, and reachable by agents over MCP): the
`/admin/*` surface, document listing/search, `DELETE`, and operator-only
historical-version reads (`/d/:id/v/:n`). This keeps the CLI a *single-principal*
tool — one agent key, one trust level — and avoids re-implementing the operator
console.

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
    commands/*.dart    # publish, update, read, get, links, health, whoami, spec, config
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

## Testing

- **Unit** (`test/format_test.dart`, `test/config_test.dart`): format inference,
  ETag/If-Match parsing, the ASCII-header guard, the full config precedence
  matrix, config round-trip, key redaction.
- **Mock-HTTP** (`test/client_test.dart`): a capturing dio `HttpClientAdapter`
  asserts exact request *shape* — method, path, `Authorization`,
  `X-Content-SHA256` = `sha256(body)`, content-length, `X-Doc-*` three-state,
  `If-Match`, and error-envelope → `CliException`/exit-code mapping — with no
  network.
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
