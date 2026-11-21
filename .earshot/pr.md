Title: QL-818: align sanitizer html5ever/markup5ever_rcdom to 0.39 (deduplicate WASM)

## Summary
- Align `sanitizer/`'s direct `html5ever` and `markup5ever_rcdom` dependencies from `0.35` to `0.39` (`html5ever 0.39.0`, `markup5ever_rcdom 0.39.0+unofficial`, `xml5ever 0.39.0`) to match `ammonia 4.1.9` introduced in PR 80.
- Eliminates the entire duplicate `html5ever 0.35` dependency subtree (`html5ever`, `markup5ever`, `tendril`, `web_atoms`, `string_cache`, `string_cache_codegen`, `phf*`, `match_token`, `futf`, `mac`, `rand*`, `utf-8`) from the WASM build. `cargo tree -d --target all` now reports zero duplicate crates.
- `sanitizer/src/markdown.rs` and `sanitizer/tests/bypass_corpus.rs` required no API changes; `sanitizer/src/lib.rs` (ammonia allowlist and sanitizing logic) is untouched.
- Update the stale note in `CLAUDE.md` that previously recorded the 0.35/0.39 coexistence as deferred.

## Size impact
Measured on `e87befe` (main) vs this branch via `npm run build:wasm` and `wrangler deploy --dry-run`:

| Artifact | Before (`main`) | After (`QL-818`) | Delta |
| --- | ---: | ---: | ---: |
| `sanitizer/pkg/sanitizer_bg.wasm` | 1,384,976 B (1352.52 KiB) | 1,098,080 B (1072.34 KiB) | -286,896 B (-280.17 KiB, -20.7%) |
| `sanitizer/pkg/sanitizer_bg.wasm` (gzip) | 468,569 B (457.59 KiB) | 379,773 B (370.87 KiB) | -88,796 B (-86.71 KiB, -19.0%) |
| Worker bundle (`Total Upload`) | 5855.18 KiB (1616.26 KiB gzip) | 5575.01 KiB (1529.49 KiB gzip) | -280.17 KiB (-86.77 KiB gzip) |

## Markdown output & converter version
- Diffed `html2md` output before and after across all 22 generated documentation HTML files (`src/generated/docs/*.html`, ~1.3 MB): **byte-for-byte identical** (0 differences).
- All 44 `markdown::tests` assertions pass without modification.
- Because emitted Markdown bytes did not change, `converter_version()` remains `awh-md-v2`.

## Validation
- `cd sanitizer && cargo tree -d --target all` — clean (no duplicate crates)
- `cd sanitizer && cargo build --all-targets && cargo test` — 142 unit tests + 2 bypass-corpus tests (173 vectors, 0 quarantined) passed
- `cd sanitizer && cargo audit` — 0 vulnerabilities (79 crate dependencies)
- `npm run build:wasm && npm run build:openapi && npm run build:docs` — clean; no drift in `openapi.json` or `src/generated/`
- `npm run typecheck && npm test` — all suites passed
- `wrangler deploy --dry-run` — passed
