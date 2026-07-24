# Slopcafe CLI

A small command-line client for the [Slopcafe](https://slopcafe.com) agent web
host. It covers the **agent-key-reachable** HTTP surface — publish, list, search,
read, update, and edit documents, plus one-call **context packs** — with
first-class **byte-exact publishing**. It
is the headless counterpart to the MCP connector: the right tool for `claude` in
headless mode, shell scripts, CI, and any device where a single binary is easier
than wiring an MCP server.

> Scope: agent keys only. The document commands (publish/list/search/pack/read/
> update/edit/links) cover the same ground as the MCP tools, including the
> agent-reachable `GET /d` listing + `GET /d/search` + `GET /d/pack` (so you can
> browse, search, load context packs, and resolve a slug to its `public_id`
> without the operator token).
> Operator-only surfaces (`/admin/*` management, `DELETE`) are intentionally
> **not** here — those stay operator-gated. See
> [`../docs/http-api.md`](../docs/http-api.md) for the full contract.

## Install

Requires the Dart SDK (≥ 3.8).

```sh
cd cli
dart pub get

# Run from source:
dart run bin/slopcafe.dart --help

# Or compile a single self-contained binary and drop it on your PATH:
dart compile exe bin/slopcafe.dart -o slopcafe
./slopcafe --help

# Or install it on your PATH via pub:
dart pub global activate --source path .
slopcafe --help
```

## Configure

Settings resolve by precedence, highest first:

1. flags — `--base`, `--key`, `--profile`
2. env — `SLOPCAFE_BASE` / `SLOPCAFE_KEY` / `SLOPCAFE_PROFILE`
3. env (compat with the repo's scripts) — `AWH_BASE` / `AWH_KEY`
4. the selected profile in the config file
5. built-in default base `https://slopcafe.com` (the key has no default)

Get an agent key from the operator (`POST /admin/agents/:id/keys`, or the web
console), or — if you're on an MCP session — mint a short-lived one with the
`create_publish_credential` tool.

```sh
# Headless / 12-factor: just export env.
export SLOPCAFE_KEY=awh_xxxxx
export SLOPCAFE_BASE=https://slopcafe.com

# Or persist a profile (config file is written 0600 — it holds a secret):
slopcafe config set base https://slopcafe.com
slopcafe config set key  awh_xxxxx
slopcafe config list            # key is redacted
slopcafe config path            # where the file lives

# Multiple environments:
slopcafe config set base http://localhost:8787 --profile dev
slopcafe --profile dev whoami
```

The base must be an absolute `http(s)` URL — a schemeless value
(`slopcafe.com`) is rejected up front with a usage error rather than failing as
an opaque connection error later. `whoami` goes further: it confirms the base
actually *is* a Slopcafe instance (via the public `GET /healthz` envelope)
**before** sending your key, and names the base URL it checked — so a typo'd or
proxied origin is reported instead of reading as success.

## Commands

Every document command accepts a **`public_id` or a slug** in the same position
— the identifier is auto-detected (a 22-char base64url string is a `public_id`,
anything else a slug) and a slug is resolved to its `public_id` via `GET /d?slug=`.
A 22-char *lowercase* name parses as both, so it is resolved **live-slug-first**:
the CLI probes `GET /d?slug=` and falls back to the `public_id` reading when no
live document claims the slug.

| Command | HTTP | What |
|---|---|---|
| `publish <file\|-> ` | `POST /d` | Publish a new document (byte-exact by default). |
| `list [--slug\|--tag\|--status\|--limit\|--cursor]` | `GET /d` | List documents (newest first); `--slug` resolves a slug. |
| `search <query…> [--mode\|--tag\|--limit\|--include-bodies]` | `GET /d/search` | Hybrid keyword + semantic search; `--include-bodies` returns a **context pack** of the top hits. |
| `pack <slug-or-id> [--budget\|--max-docs]` | `GET /d/pack` | Load a context pack: the root doc's prose + the full bodies of the docs it references, in one call. |
| `find <slug>` | `GET /d?slug=` | Print a slug's `public_id` (`--json` prints the row). |
| `read <id-or-slug> [--as text\|html\|source]` | `GET /d/:id/text\|raw\|source` | Read a body. `--slug` forces slug; `source` resolves a slug to its id. |
| `update <id-or-slug> <file\|->` | `PUT /d/:id` | Append a new version (replaces the body). |
| `edit <id-or-slug> --find OLD --replace NEW` | `GET /…/source` + `PUT /d/:id` | Client-side find/replace over the source, then republish. Takes the same metadata flags as `update`. |
| `get <slug>` | `GET /s/:slug` | Fetch the rendered HTML by slug (alias for `read --slug … --as html`). |
| `links <id-or-slug>` | `GET /d/:id/links` | Show backlinks + outbound link health. |
| `whoami` | `GET /healthz` + auth probe | Verify the base URL is a Slopcafe instance **and** the key is accepted there. |
| `health` | `GET /healthz` | Service health. |
| `spec` | `GET /openapi.json` | Fetch the live OpenAPI spec. |
| `config …` | — | Manage base URL / key / profiles. |

Global flags: `--json` (machine-readable output for headless callers — results
*and* errors), `--quiet`, `--verbose`, `--no-color`, `--timeout <seconds>`,
`--version`. File arguments are path-confined — see below.

`publish`, `update`, and `edit` all take the same optional metadata flags —
`--title`, `--description`, `--tags a,b`, `--slug` — mirroring the backend's
`X-Doc-*` headers. **Omitting a flag inherits** the current value (on `publish`,
leaves it unset); passing `""` **clears** it (and for `--title`, re-derives from
the content's first `# heading`).

### `--json` means the same thing everywhere

Every command answers `--json` with **one JSON object on stdout** — including
`read` and `get`, whose default output is the raw body. Errors answer with the
[error envelope](#output-streams-and-the-json-error-envelope) on stderr. So a
headless caller can predict the output shape from the flag alone, without
knowing which command (or which `--as` value) it happens to be running.

Where a command also has `-o <file>`, `--json` writes the object **to that
file** rather than to stdout — the flag is never silently ignored.

### Timeouts

Every request carries a budget, so a stalled origin (a Cloudflare/D1 flap that
accepts the connection and never answers) can't wedge a headless run forever:

| Phase | Default | Note |
|---|---|---|
| connect | 15s | TCP+TLS handshake. `--timeout` can lower this, never raise it. |
| send | 300s | **Total** upload time — dio bounds the whole request body, not the idle gap, so a slow link fails at the deadline even while bytes are still moving. Sized for a 5 MiB byte-exact publish at ~17 KB/s; it is deliberately *not* the receive budget. |
| receive | 60s | Inactivity: time to first byte, then the gap between chunks — a 256 KB context pack is fine however long it takes. |

`--timeout <seconds>` can only ever **lower** a budget, never raise one: it sets
receive, and caps connect and send if it is below their defaults. A timeout
exits **75** and reports `"retryable": true`.

Not every transport failure is worth retrying. A refused or reset connection
exits **75** with `"retryable": true`, but a **failed DNS lookup exits 1 with
`"retryable": false`** and the code `cli_bad_base_url` — an unresolvable host is
a typo in `--base`, not a flap, and a retry loop on it would never terminate.

### Path confinement (sandboxed agents)

File arguments — the `<file>` you publish/update and the `-o <file>` you write —
are **confined to the working directory**: the path must resolve (after
symlinks) to somewhere under the CWD, or the command fails with a usage error
before anything is read or sent. This keeps a sandboxed agent driving the CLI
from uploading `~/.ssh/id_rsa` — or overwriting a file elsewhere — just because
the *process* can reach it. stdin/stdout (`-`, no `-o`) are always allowed.

The only widening knob is an explicit root, and it is itself constrained so it
can't be spelled into an off-switch: the root must be an existing **ancestor or
descendant of the working directory**, may not be the filesystem root, and may
not contain your home directory — so `~/Repos` is grantable while `~` itself
(with `~/.ssh` in it) is not:

```sh
# CWD is /workspace/project; widen to the whole workspace:
SLOPCAFE_PATH_ROOT=/workspace slopcafe publish /workspace/shared/doc.md
```

There is deliberately **no off-switch**: an `--unsafe-paths` flag (and its
`SLOPCAFE_UNSAFE_PATHS` env twin) would hand any agent that controls its own
argv a free escape hatch, so neither is registered — the plumbing is kept
commented in the source for the day a real need appears. A widened root still
shows up verbatim in the invocation a harness permission prompt or audit log
sees, so escaping the sandbox is always an explicit, reviewable act rather
than the silent default.

### Byte-exact publishing

`publish`/`update` send `X-Content-SHA256` over the **raw body** by default, so a
truncated upload is rejected (`422`) rather than stored. The response's
`source_sha256` equals `sha256sum` of the file you sent (for well-formed UTF-8
published as-is) — cache it to confirm a local copy is still current.

```sh
# Format is inferred from the extension (.md → markdown, .html → html):
slopcafe publish report.md --title "Q3 Report" --tags finance,q3 --slug q3-report

# Update with automatic optimistic concurrency (preflights the current version):
slopcafe update 0EtsEq6cnCeuOhBKO6ICzA report.md
# …or pin it explicitly / force last-write-wins:
slopcafe update <id> report.md --if-match v4
slopcafe update <id> report.md --force

# From a pipe (stdin needs an explicit --format):
generate_doc | slopcafe publish - --format markdown --slug generated

# Disable the integrity hash if you must:
slopcafe publish report.html --no-integrity
```

### Reading

```sh
slopcafe read <id-or-slug>             # markdown (default) — ingest-as-context view
slopcafe read <id-or-slug> --as html -o page.html
slopcafe read my-doc --as source       # source (a slug is resolved to its id)
slopcafe read --slug my-doc            # force slug interpretation
slopcafe get my-doc > page.html        # rendered HTML by slug
```

Without `--json` stdout is the **raw body**, so `> out.md` and `-o out.md`
capture exactly the bytes. With `--json` it is the **read envelope** — the body
plus the metadata that response carried — for every `--as` value:

```sh
slopcafe read q3-report --json | jq -r .content     # body
slopcafe read q3-report --json | jq -r .version     # …and what version it is
```

```jsonc
{
  "slug": "q3-report",          // or "public_id", whichever addressed the doc
  "representation": "rendered", // "source" with --as source
  "content": "# Q3 …",
  "format": "markdown",         // "html" on --as html / get; the authored
                                //   language on --as source
  "version": 3,                 // from the ETag
  "sanitizer_v": "ammonia-v1.5",
  "converter_v": "awh-md-v1",   // null when no converter ran (html / source)
  "content_type": "text/markdown; charset=utf-8"
}
```

Field names mirror the MCP `read_document` envelope, so an agent that knows one
recognises the other. **A key appears only when its value is genuinely known**
— `--as text|html` fetch a *body*, and the per-document metadata (title, tags,
status, …) simply isn't on that response, so those keys are absent rather than
faked as `null`, and the CLI does not spend a second round trip to fill them
in. `--as source` hits a JSON endpoint that returns the lot, so its envelope
carries `title`/`description`/`tags`/`status`/`superseded_by`/`stripped`/
`will_not_render`/`source_sha256` plus `unsanitized: true`. For metadata
alongside a rendered read, ask the listing: `slopcafe find <slug> --json` or
`slopcafe list --slug <slug> --json`.

### Discovering (list / search / find)

```sh
slopcafe list                          # newest first
slopcafe list --tag finance --status active --limit 20
slopcafe list --slug q3-report         # 0-or-1 row (resolve a slug)
slopcafe search "quarterly revenue"    # hybrid keyword + semantic
slopcafe search budget --mode keyword --json | jq '.documents[].public_id'
slopcafe find q3-report                # prints the public_id (for scripting)
slopcafe update "$(slopcafe find q3-report)" q3.md   # compose find → update
```

### Context packs (one-call boot)

A **context pack** is a budgeted bulk read: whole document bodies, assembled
server-side in one call. Two roots, same envelope:

| Root | Command | Use it when |
|---|---|---|
| a document / manifest | `slopcafe pack <slug-or-id>` (`GET /d/pack`) | you know where to start |
| a query | `slopcafe search <q> --include-bodies` (`GET /d/search?include_bodies=true`) | you don't — "brief me on TOPIC" |

`pack` takes the root's own prose plus the **full markdown bodies** of the
documents it references — a fenced ` ```pack ` manifest block when the root has
one, else its outbound `/d/` + `/s/` links. `search --include-bodies` walks the
ranked hits best-first instead. Either way stdout is clean markdown (members
under `---` separators); the budget accounting and the omitted-members menu
print to stderr, so a boot prompt can ingest the stream directly.

```sh
slopcafe pack pack-onboarding                    # default budget: 64 KB / 8 docs
slopcafe pack pack-onboarding --budget 131072 --max-docs 12 -o context.md
slopcafe pack pack-onboarding --follow           # swap deprecated members for their replacements
slopcafe pack pack-onboarding --json | jq '.omitted[].ref'

slopcafe search onboarding --include-bodies                      # query-rooted pack
slopcafe search onboarding --include-bodies --budget 131072 --max-docs 12
slopcafe search onboarding --include-bodies --json | jq '.pack.used_bytes'
slopcafe search onboarding --include-bodies -o ctx.md            # same -o as `pack`
```

Both roots share the `--budget` (`budget_bytes`, default 65536, min 1024, max
262144) and `--max-docs` (`max_documents`, default 8, max 25) knobs, plus
`--include-deprecated`. The server **clamps** them rather than rejecting, so an
out-of-range value is a quieter budget, not an error.

Bodies are included **whole or omitted-and-reported** — never truncated; fetch
an omitted member with `slopcafe read <id>` or raise `--budget`/`--max-docs`.
The stderr menu lists the first 10 omissions and then says how many it held
back (a query pack can omit every hit past the knobs); `--json` always carries
the complete `omitted[]`.

### Editing (client-side find/replace)

```sh
# Reads the retained source, applies the edits, then republishes in the
# document's own format (Markdown stays Markdown) — the headless edit_document.
slopcafe edit q3-report --find "Q2" --replace "Q3"
slopcafe edit <id> -f "old name" -r "new name" -f "v1" -r "v2"   # multiple pairs
slopcafe edit <id> --find "TODO" --replace "done" --replace-all  # every occurrence
slopcafe edit <id> -f "a,b" -r "one, two, three"                 # commas are literal, not delimiters

# Metadata rides along, so renaming a term AND fixing the title is one call:
slopcafe edit q3-report -f "Widget" -r "Gadget" --title "Gadget report"
slopcafe edit <id> -f "a" -r "b" --tags ""                       # clear the tags
```

Each `--find`/`--replace` value is taken **verbatim** — commas inside a value are
literal, not separators. To supply several pairs, repeat the flags (as above), one
`--find`/`--replace` per pair.

`edit` accepts the same `--title`/`--description`/`--tags`/`--slug` flags as
`publish`/`update` (MCP `edit_document` has all four), with the same
inherit-on-omit / clear-on-`""` semantics — so a metadata change no longer
costs a second full-body `update` and an extra version.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | success |
| `1` | a failure with no code of its own (a 4xx the CLI can't classify further, an I/O error, an unexpected exception) |
| `64` | usage error — **argv problems only** (bad flag/argument, a non-ASCII header value, a path outside the confinement root) |
| `66` | the named document/slug does not exist (`404 not_found`, `410 gone`, or a slug matching no live document) |
| `75` | transient — worth retrying (timeout, connection error, `408`/`429`/`5xx`) |
| `77` | authentication failed (missing or rejected key) |

Deliberately coarse: the exit code says *what class* of thing went wrong, and
the `error` code in the JSON envelope below says *exactly which*. So
`slug_taken` (409) and `precondition_failed` (412) share exit `1` — read the
envelope to tell them apart. Note `66` is used for **both** the slug path and
the `public_id` path, so `slopcafe find x || create_it` can distinguish
"missing" from "network down"; and `75` is advisory — for a non-idempotent
write, confirm the current state before retrying.

### Output streams and the JSON error envelope

The document body / JSON result always goes to **stdout** (or to `-o <file>`
when the command has that flag — in `--json` mode too), notes and errors to
**stderr** — so `slopcafe read … > out.md` captures only content.

Without `--json`, errors print a one-line `✗ …` to stderr (the machine code is
in brackets). **With `--json`, errors print a machine-readable envelope to
stderr instead**, so a headless caller never has to parse prose:

```jsonc
{
  "ok": false,
  "error": "slug_taken",   // contract ErrorCode, or a cli_* code for CLI-side failures
  "message": "slug already in use",
  "status": 409,           // omitted when the failure never reached HTTP
  "exit_code": 1,
  "retryable": false,
  "slug": "q3-report"      // …then the server's own context fields, verbatim
}
```

`ok`, `error`, `message`, `exit_code`, and `retryable` are always present;
`status` is present iff a response was received; every other key comes straight
from the server's error body (`slug`, `expected`/`actual` on
`integrity_mismatch`, `hint`, `redirect_to`, …) exactly as `docs/http-api.md`
documents it. A `cli_`-prefixed `error` (`cli_timeout`, `cli_not_found`,
`cli_usage`, `cli_bad_base_url`, …) means the CLI stopped before or around the
request — no backend code uses that prefix, so the two can never be confused.
Usage errors get the envelope too, with the usage block under `usage`.

```sh
slopcafe update q3-report notes.md --json 2>err.json || \
  case "$(jq -r .error err.json)" in
    precondition_failed) ;;   # someone else wrote first — re-read and retry
    slug_taken)          ;;   # pick another slug
    *) exit 1 ;;
  esac
```

## Caveats

- **Non-ASCII metadata can't be sent in headers.** Dart's HTTP stack rejects any
  byte ≥ 0x80 in a header value, so a non-ASCII `--title`/`--description` is
  refused with a usage error. For a non-ASCII **title**, put it in the document
  as the first-level heading (`# Heading`) and omit `--title` — the server
  derives it. The document **body** may be any UTF-8 (it's a byte stream, not a
  header). `--tags`/`--slug` are ASCII-only by the backend's own charset rules.
- **No historical-version reads.** `GET /d/:id/v/:n` is operator-only over HTTP;
  agents read old versions over MCP. The CLI reads the current version only.
- **No delete / management.** Revoke, visibility, slug-redirect, and the rest of
  `/admin/*` stay operator-gated and are not in the CLI (see the scope note above).
  Listing and search **are** here now (`list`/`search`/`find`) via the
  agent-reachable `GET /d` + `GET /d/search`.
- **Identifier auto-detection edge case.** A slug that is *also* exactly 22
  base64url chars (`zenyatta-shared-memory` is one) is ambiguous by shape. Since
  0.2.3 the CLI resolves it **live-slug-first**: it probes `GET /d?slug=` and
  falls back to the `public_id` reading on a miss — the same order the server
  uses for `GET /d/pack?from=`. Keyless invocations can't probe (it's a
  credentialed GET) and keep the old assume-id guess — force the reading with
  `read --slug <slug>` when it matters.

## Development

The typed model layer under `lib/api/` is **generated** from the backend's
`openapi.json` by `tool/generate_api.dart` (a vendored copy of the Flutter app's
generator). Regenerate after re-pinning the spec:

```sh
cp ../openapi.json tool/openapi.json          # re-pin (update tool/CONTRACT_VERSION)
dart run tool/generate_api.dart
dart run build_runner build
dart analyze
dart test
```

See [`../docs/design/cli-design.md`](../docs/design/cli-design.md) for the
design rationale.
