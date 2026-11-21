Title: QL-813: clear dependency advisories (ammonia, pulldown-cmark, undici, hono, zod, …)

Clears all 27 advisories that ground-control's audit (QL-813) found at main `b118f5b`, 8 of them high. The method is the same as QL-694: tighten version constraints, then regenerate both lockfiles. No lockfile entry was edited by hand. Afterwards **`npm audit`: 0 vulnerabilities** and **`cargo audit`: clean**.

## Sanitizer (`sanitizer/Cargo.toml` + `Cargo.lock`)
- **ammonia** `"4"` → `"~4.1.9"`: 4.1.2 → 4.1.9. It stays on the 4.1 line because 4.2 isn't needed for any of these fixes. Clears RUSTSEC-2021-0157, RUSTSEC-2021-0158, RUSTSEC-2026-0193, RUSTSEC-2026-0213, RUSTSEC-2026-0373 and RUSTSEC-2026-0533.
- **pulldown-cmark** `"0.13"` → `"0.13.6"`: 0.13.4 → 0.13.6. Clears RUSTSEC-2026-0414 and RUSTSEC-2026-0433 (both high).

## npm (`package.json` + `package-lock.json`)
- **zod** (direct dependency) `^4.4.3` → `^4.6.6`. Clears GHSA-mrhx-c7xc-m3w5 (high).
- **undici**: the miniflare-scoped override moves 7.30.0 → 7.30.1, the lowest patched release. Clears 8 GHSAs, 4 of them high. The override is still needed because miniflare pins undici to an exact version. **wrangler stays at 4.128.0**; newer wranglers pull in a miniflare 5.x beta.
- **@hono/node-server**: the override floor moves `^2.0.5` → `^2.1.6` and resolves to 2.1.11. Clears 3 GHSAs.
- **hono, body-parser, qs**: upgraded with `npm update` inside their existing ranges, with no override. They resolve to hono 4.13.19, body-parser 2.4.0 and qs 6.17.1. For hono and qs that is above the lowest patched release (4.13.16 and 6.16.1), because `npm update` picks the newest version the range allows. None of them crosses a major version.

## ⚠️ Sanitizer bump: `ammonia-v1.7` → `ammonia-v1.8`
ammonia 4.1.9 serializes through html5ever 0.39, which now escapes `<` and `>` inside attribute values. This is part of the SVG/MathML mutation-XSS fix (RUSTSEC-2026-0533). The output bytes change, so `sanitizer_version()` is bumped as the repo's rule requires: the no-op-collapse gate depends on it. **The allowlist itself is unchanged.**

One test, `anchor_lookalike_in_an_attribute_value_is_not_an_anchor`, expected the old escaping. It now expects the escaped form. A new check also confirms that the new-tab splice leaves attribute values untouched. The version string is updated in `skills/publishing.md`, `docs/security-model.md` and the docs bundle. Documents that are already stored keep their old renders until they are re-published or restored.

## OpenAPI contract 3.0.1 → 3.0.2 (PATCH)
zod 4.6 writes nullable and scalar-union fields as `type: [X, "null"]` instead of `anyOf: [{type: X}, {type: "null"}]`. That is why `openapi.json` shows +394/−864 lines. I normalized the old and new spec and compared them: the two forms accept exactly the same values, and the only remaining difference was the same rewrite on `AuditEvent.detail`. No route, field, status code or content type moved.

The bump is recorded in the `src/openapi.ts` ledger and `docs/http-api.md`. The version claims in README, the quickstart and api-contract-design are updated too, along with `package.json` and the MCP server version. Re-pinning the CLI is optional because the schemas are equivalent.

## Not done / left for Kyle
- **`wrangler deploy --dry-run` was not run.** The permission classifier blocked it in this session. Please run it before deploying.
- **The sanitizer now carries two html5ever versions.** ammonia 4.1.9 brings html5ever 0.39, while the sanitizer's own `html5ever` / `markup5ever_rcdom` dependencies stay on 0.35. Those are used by the markdown emitter and the bypass-corpus test. It builds and every test passes, but the WASM is larger. Aligning them on 0.39 is a breaking 0.x bump, so it is left for your call.
- **Not taken, not needed for these fixes:** ammonia 4.2.x, and wrangler ≥4.153 (which brings the miniflare 5.x beta).

## Validation
- `cargo build` and `cargo test` in `sanitizer/` pass: 142 + 2 tests.
- After a clean `npm ci`, these all pass: `npm run typecheck`, `build:wasm`, `build:openapi`, `build:docs`, and the full `npm test` suite, which includes the openapi and docs-bundle freshness gates.
- `npm audit`: 0 vulnerabilities. `cargo audit`: no vulnerabilities across 95 crates.

CHANGELOG has a Security entry. The CLAUDE.md dependency-overrides bullet lists the new pins.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_014iKvMCy5dvMMYXWQkYDREX
