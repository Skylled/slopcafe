Title: QL-438: clear remaining npm advisories with targeted transitive fixes

# QL-438 follow-up: clear the eight remaining npm findings

Assessed 2026-10-21 from fresh `origin/main` commit `9ff52b7` (PR 76 merged),
in `/private/tmp/slopcafe-ql438-audit-followup`, branch
`feat/ql-438/audit-followup`. This worktree has no ancestor checkout or
`node_modules` fallback. No production deployment or remote D1 operation ran.

## Outcome and scope

**All eight package findings are cleared: npm audit reports zero vulnerabilities.**
The baseline was 3 moderate, 4 high, and 1 critical. Those are eight affected
packages, not eight unique advisories: six packages have **20 underlying
advisories**, while `miniflare` and `wrangler` are high-severity meta findings
inherited from their dependencies.

None of the flagged packages reaches the deployed Worker bundle. Four are in
the unused v1 SDK peer tree, not devDependencies: `fast-uri`, `hono`,
`ip-address`, and `proxy-addr`. They are installed because `agents` declares an
exact `@modelcontextprotocol/sdk@1.32.1` peer; Slopcafe imports the stateless
`agents/mcp/server` entry and v2 server instead. Four are dev-only:
`wrangler`, `miniflare`, `sharp`, and `undici`, used for build/development and
local test tooling. Their non-deployment did not eliminate the need to fix
them for developers and future dependency use.

## Changes

| Package | Before | After | Fix |
| --- | --- | --- | --- |
| fast-uri | 3.1.7 | 3.1.9 | targeted lockfile update within ajv's ^3.0.1 range |
| hono | 4.13.5 | 4.13.13 | targeted lockfile update within SDK's ^4.11.4 and node-server's ^4 peer |
| ip-address | 10.3.1 | 10.7.4 | targeted lockfile update within express-rate-limit's ^10.2.0 range |
| proxy-addr | 2.0.7 | 2.0.8 | targeted lockfile update within Express's ^2.0.7 range |
| sharp | 0.35.2 | 0.35.5 | scoped miniflare override; same minor, patch update |
| undici | 7.29.0 | 7.30.0 | scoped miniflare override; same major |
| miniflare | 5.20260831.0-alpha | unchanged | inherited high finding cleared by the two overrides |
| wrangler | 4.128.0 | unchanged | inherited high finding cleared by the two overrides |

Ran `npm update fast-uri hono ip-address proxy-addr`; no general audit fix.
Miniflare pins `sharp: 0.35.2` and `undici: 7.29.0` exactly, so a normal
lockfile update cannot fix those two without changing the parent. Add only:

```json
"miniflare": {
  "sharp": "0.35.5",
  "undici": "7.30.0"
}
```

These overrides are scoped to Miniflare. Preserve the existing
`@hono/node-server` override. Sharp's platform binaries and libvips packages
move with it (libvips package 1.3.1 → 1.3.4); they are necessary companions,
not unrelated upgrades. Retain their existing Miniflare-nested lockfile layout
to avoid npm's unrelated hoisting churn. Clean `npm ci` and `npm ls --all`
accept the resulting tree.

All direct dependency versions, the v1/v2 MCP peers, Wrangler, Miniflare,
workerd, esbuild, and the compatibility date stay unchanged. No breaking major
upgrade is needed or deferred. npm audit suggested Wrangler 4.151.3 (a same-major
upgrade outside our exact pin), but the scoped overrides fix the same root
causes with a much narrower change. If the overrides are later removed, first
upgrade Miniflare/Wrangler to versions that natively require sharp >=0.35.5 and
undici >=7.30.0, then repeat the clean install, audit, local runtime checks,
and dry-run. Do not remove the overrides while retaining today's exact parent
pins.

## Every advisory: dependency path, exposure, final status

Paths begin at Slopcafe. All SDK peer paths start with direct `agents@0.29.0`
and exact peer `@modelcontextprotocol/sdk@1.32.1`. Tooling paths start with dev
`wrangler@4.128.0` and exact `miniflare@5.20260831.0-alpha`.
Severity is each advisory's own npm audit JSON severity, not the maximum for
its containing package. Each linked advisory is cleared by the versions above.

| Advisory | Package | Severity | Dependency path | Worker / tooling reachability | Status |
| --- | --- | --- | --- | --- | --- |
| [GHSA-hrr3-gc8f-f4qj](https://github.com/advisories/GHSA-hrr3-gc8f-f4qj) — fast-uri vulnerable to inconsistent host case normalization via percent-encoded octets | fast-uri | moderate | agents → @modelcontextprotocol/sdk → ajv (also via ajv-formats) → fast-uri | Absent from Worker; unused v1 SDK peer transport/validation code (not dev-only). | Fixed |
| [GHSA-hxh3-vqpv-xpqv](https://github.com/advisories/GHSA-hxh3-vqpv-xpqv) — hono/jsx renders plain strings unescaped in boundary components, leading to XSS | hono | moderate | agents → @modelcontextprotocol/sdk → hono (also via @hono/node-server peer) | Absent from Worker; unused v1 SDK peer transport/validation code (not dev-only). | Fixed |
| [GHSA-5r4p-p66f-jhc7](https://github.com/advisories/GHSA-5r4p-p66f-jhc7) — Hono: `serveStatic` decodes the request path a second time, leading to bypass of middleware on static paths | hono | moderate | agents → @modelcontextprotocol/sdk → hono (also via @hono/node-server peer) | Absent from Worker; unused v1 SDK peer transport/validation code (not dev-only). | Fixed |
| [GHSA-rpw4-54j3-4h4q](https://github.com/advisories/GHSA-rpw4-54j3-4h4q) — ip-address: Address6.isLinkLocal() recognizes fe80::/64 rather than fe80::/10, allowing SSRF and trust-boundary bypass to on-link hosts | ip-address | moderate | agents → @modelcontextprotocol/sdk → express-rate-limit → ip-address | Absent from Worker; unused v1 SDK peer transport/validation code (not dev-only). | Fixed |
| [GHSA-2vr4-cq9g-pvrc](https://github.com/advisories/GHSA-2vr4-cq9g-pvrc) — ip-address: no classifier recognizes the NAT64 local-use range 64:ff9b:1::/48, allowing SSRF and trust-boundary bypass | ip-address | moderate | agents → @modelcontextprotocol/sdk → express-rate-limit → ip-address | Absent from Worker; unused v1 SDK peer transport/validation code (not dev-only). | Fixed |
| [GHSA-j6r3-76f7-8jcv](https://github.com/advisories/GHSA-j6r3-76f7-8jcv) — ip-address: isInSubnet() and isHostInSubnet() compare addresses of different families as if they shared an address space, allowing an allowlist check to admit an address outside its range | ip-address | moderate | agents → @modelcontextprotocol/sdk → express-rate-limit → ip-address | Absent from Worker; unused v1 SDK peer transport/validation code (not dev-only). | Fixed |
| [GHSA-h3mg-xc3c-68pw](https://github.com/advisories/GHSA-h3mg-xc3c-68pw) — ip-address: Address6 builds a parse diagnostic proportional to the input with no length bound, allowing a single long string to stall or crash the process | ip-address | moderate | agents → @modelcontextprotocol/sdk → express-rate-limit → ip-address | Absent from Worker; unused v1 SDK peer transport/validation code (not dev-only). | Fixed |
| [GHSA-jqcg-44mw-7w3h](https://github.com/advisories/GHSA-jqcg-44mw-7w3h) — proxy-addr vulnerable to IP spoofing via IPv4-mapped IPv6 trust subnet | proxy-addr | critical | agents → @modelcontextprotocol/sdk → express → proxy-addr | Absent from Worker; unused v1 SDK peer transport/validation code (not dev-only). | Fixed |
| [GHSA-rgj7-g3m4-5g8c](https://github.com/advisories/GHSA-rgj7-g3m4-5g8c) — sharp: Vulnerabilities in libheif: GHSA-g89c-p67h-r497 and GHSA-2jg2-4ch7-h545 | sharp | high | wrangler → miniflare → sharp | Absent from Worker; dev-only Miniflare image processing / local HTTP client. | Fixed |
| [GHSA-wq5f-xc86-pv6w](https://github.com/advisories/GHSA-wq5f-xc86-pv6w) — sharp : Vulnerability in librsvg dependency CVE-2026-96889 | sharp | high | wrangler → miniflare → sharp | Absent from Worker; dev-only Miniflare image processing / local HTTP client. | Fixed |
| [GHSA-3wwx-pv8p-q78v](https://github.com/advisories/GHSA-3wwx-pv8p-q78v) — undici vulnerable to Denial of Service via unhandled error in WebSocket permessage-deflate decompression | undici | moderate | wrangler → miniflare → undici | Absent from Worker; dev-only Miniflare image processing / local HTTP client. | Fixed |
| [GHSA-pmjh-fq2x-6v4x](https://github.com/advisories/GHSA-pmjh-fq2x-6v4x) — undici vulnerable to Denial of Service via orphaned RetryHandler response body | undici | moderate | wrangler → miniflare → undici | Absent from Worker; dev-only Miniflare image processing / local HTTP client. | Fixed |
| [GHSA-r53p-7pc4-xj5r](https://github.com/advisories/GHSA-r53p-7pc4-xj5r) — undici vulnerable to downstream response splitting via retry interceptor | undici | low | wrangler → miniflare → undici | Absent from Worker; dev-only Miniflare image processing / local HTTP client. | Fixed |
| [GHSA-rfgv-xxqx-mfg5](https://github.com/advisories/GHSA-rfgv-xxqx-mfg5) — undici vulnerable to Denial of Service via unrequested WebSocket subprotocol | undici | high | wrangler → miniflare → undici | Absent from Worker; dev-only Miniflare image processing / local HTTP client. | Fixed |
| [GHSA-3xpg-4rpp-hhhm](https://github.com/advisories/GHSA-3xpg-4rpp-hhhm) — undici vulnerable to Denial of Service via unbounded decompression of compressed responses | undici | moderate | wrangler → miniflare → undici | Absent from Worker; dev-only Miniflare image processing / local HTTP client. | Fixed |
| [GHSA-2jfj-6hjv-fm6j](https://github.com/advisories/GHSA-2jfj-6hjv-fm6j) — undici vulnerable to cross-user cookie disclosure via Set-Cookie caching in shared caches | undici | moderate | wrangler → miniflare → undici | Absent from Worker; dev-only Miniflare image processing / local HTTP client. | Fixed |
| [GHSA-2gqq-gqf2-x968](https://github.com/advisories/GHSA-2gqq-gqf2-x968) — undici vulnerable to response truncation via oversized chunked responses in the dump interceptor | undici | low | wrangler → miniflare → undici | Absent from Worker; dev-only Miniflare image processing / local HTTP client. | Fixed |
| [GHSA-w293-vg96-wgc3](https://github.com/advisories/GHSA-w293-vg96-wgc3) — undici vulnerable to TLS certificate validation bypass via dropped connect options in BalancedPool | undici | high | wrangler → miniflare → undici | Absent from Worker; dev-only Miniflare image processing / local HTTP client. | Fixed |
| [GHSA-8436-99hf-9mmv](https://github.com/advisories/GHSA-8436-99hf-9mmv) — undici vulnerable to caching and replay of unsafe HTTP method responses | undici | low | wrangler → miniflare → undici | Absent from Worker; dev-only Miniflare image processing / local HTTP client. | Fixed |
| [GHSA-rx4f-c7p8-82vq](https://github.com/advisories/GHSA-rx4f-c7p8-82vq) — undici vulnerable to Denial of Service via WebSocketStream unclean close | undici | moderate | wrangler → miniflare → undici | Absent from Worker; dev-only Miniflare image processing / local HTTP client. | Fixed |

`miniflare` and `wrangler` have no independent advisory in the report; their
meta findings were inherited from `sharp`/`undici`, and are now cleared too.
The two sharp advisories cover libheif (including upstream
GHSA-g89c-p67h-r497 and GHSA-2jg2-4ch7-h545) and librsvg CVE-2026-96889.
The installed patched native build reports sharp 0.35.5, librsvg 2.63.2,
libheif 1.23.5, and libvips 8.18.7 on this Darwin host. Other platforms use the
lockfile's corresponding patched optional binaries; they were not run here.

## Worker bundle evidence

Before and after changes, ran **the installed Wrangler 4.128.0**:

```sh
env -i PATH="$PATH" HOME=/tmp/ql438-followup-cf-home TMPDIR=/tmp \
  WRANGLER_SEND_METRICS=false node_modules/.bin/wrangler deploy --dry-run \
  --config /tmp/ql438-followup-wrangler.json \
  --outdir /tmp/ql438-followup-bundle-after
```

The scratch HOME is empty of Cloudflare credentials; `env -i` removes all
Cloudflare/account/secret environment variables. The explicit scratch config
contains only name, absolute `src/index.ts` path, compatibility date 2026-05-26,
`nodejs_compat`, and the template's CompiledWasm + HTML/Markdown Text rules.
It contains no account, resources, routes, remote bindings, or secrets; no
`.dev.vars` was copied. Both runs printed `No bindings found` and
`--dry-run: exiting now`, exit 0.

Parsed `index.js.map.sources` from both real Wrangler bundles. Their npm source
package sets are identical:

- @cfworker/json-schema
- @cloudflare/workers-oauth-provider
- @modelcontextprotocol/core
- @modelcontextprotocol/core-internal
- @modelcontextprotocol/server
- agents
- content-type
- zod

None of the eight flagged packages appears. The generated Worker `index.js`
is **byte-for-byte identical** before and after, SHA-256:
`481fb61251aae5b1054c889bdcd8031b43b09cac6ad36b0e35bbd592b38ee985`.
This proves import/bundle reachability for the checked source/config; it is
not a live production probe.

## Validation

- Baseline: fresh `npm ci`, `npm audit`, `npm audit --json`, and `npm explain`
  for fast-uri, hono, ip-address, proxy-addr, sharp, and undici.
- After fixes: deleted the entire worktree `node_modules`, then **`npm ci`
  passed and reported zero vulnerabilities**. No ancestor checkout is in
  module resolution. `npm ls --all` passed with both overrides recognized.
- `npm run typecheck`: passed, exit 0.
- `npm test`: full suite passed, exit 0, including **142 Rust unit tests +
  2 sanitizer bypass-corpus integration tests**, every MCP/input-limit suite,
  and docs bundle freshness. `npm run build:wasm` built the fresh WASM first.
- Both credential-free `wrangler deploy --dry-run` runs: passed, exit 0;
  unchanged Worker JS and identical source-package sets as above.
- Patched sharp smoke check: decoded local SVG, resized 10×10 → 5×5, encoded
  PNG and decoded metadata; both dimensions verified. Native dependency
  versions confirmed. No network or user images used.
- Patched undici/Miniflare smoke check: started a loopback-only local workerd
  via the installed Miniflare v5 `convertV4MiniflareOptions` adapter,
  `dispatchFetch` returned HTTP 200 and the expected body, then disposed it.
  Cloudflare env was cleared; no remote services or persistent bindings.
- Final `npm audit` and `npm audit --json`: **zero vulnerabilities**, exit 0.
- No real deployment, remote D1, forced audit fix, or direct dependency
  version upgrade.
