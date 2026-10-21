# QL-438: MCP advisory assessment

Assessed 2026-10-21 from the origin-default-branch worktree. Reachability below
is based on the deployed Worker entry point (`src/index.ts`) and its imports,
not a probe of production. No deployment or remote D1 operation was performed.

## Verdict and request path

**Exposed to GHSA-46jr-4wx8-v453 (high), behind agent authentication.**
`src/index.ts` authenticates `/mcp` before `handleMcp` in `src/mcp.ts` builds a
fresh `McpServer` for each request. It registers Zod input schemas, including
unbounded tag arrays and the nested `edit_document.edits` array. The stateless
`agents/mcp/server` factory passes calls to the SDK's `tools/call` handler and
`validateToolInput`, before the document handlers run. The old server 2.0.0
had no element budget; malformed arrays could allocate validation errors before
Slopcafe's metadata normalization or document byte cap ran. Auth limits the
attack to a caller with a valid agent credential; it does not make such inputs
trusted. Slopcafe does not use `McpAgent` or the old SDK server path.

**Not exposed to GHSA-22jm-h49p-29qw (high).** No `taskStore`, task registration,
or experimental task API is configured in application source. The vulnerable
v1 SDK was installed only as an agents peer and is absent from the Worker bundle.

Workers do not have a persistent Node process with Node's heap configuration.
Cloudflare documents a **128 MB limit per isolate**, shared across concurrent
requests and including WASM memory. Exhaustion means availability failures
(`exceededMemory`/Error 1102) and isolate replacement; it is not necessarily a
clean, isolated kill of only the attacking request. Cloudflare normally allows
in-flight requests to complete and replaces the isolate for later requests;
under extreme load it may cancel incoming requests.

Sources: [memory advisory](https://github.com/advisories/GHSA-46jr-4wx8-v453),
[tasks advisory](https://github.com/advisories/GHSA-22jm-h49p-29qw),
[Workers memory limits](https://developers.cloudflare.com/workers/platform/limits/#memory).

## Minimal fix and limit

Upgrade `agents` 0.22.0 → 0.29.0, which updates its exact MCP peer requirements.
The preceding release 0.28.0 still pins the vulnerable server/client 2.0.0 and
SDK 1.30.0. Install server/client/core 2.3.1 and SDK 1.32.1 to satisfy 0.29.0;
no forced audit fix, peer override, or unrelated package version upgrade.
New capnweb/postal-mime dependencies and optional peer pruning come from agents.
The existing unrelated transitive versions and Wrangler pin are preserved.

Set `maxToolInputElements: 4_096` on the actual per-request server, with the
rationale in `src/mcp-limits.ts`. Counts include all object keys and array slots
recursively, not string bytes. Publish/update content is a single string, with
a separate 5 MiB cap in `src/document-write.ts`; normalized tags are at most ten.
Edit is the largest structured input: 1,000 two-key edits cost 3,000 elements,
plus top-level fields and tags, comfortably within 4,096. Previously there was
no finite edit-count maximum; this intentionally requires larger batches to be
split. Read/list/search/pack inputs are smaller scalar objects. The transport's
existing default 4 MiB whole-JSON request limit remains in force; JSON escaping
and the envelope count toward it. `maxRequestBodySize` stays at this default
because publish/update legitimately need multi-MiB content plus JSON overhead;
lowering it would reject supported document inputs. A document up to the core's 5 MiB cap may need
the HTTP write path. Increasing the byte cap is outside this security fix.

## Resolved versions and commands

Ran `npm ci`, `npm audit`, `npm audit --json`, and individual `npm explain`
commands for `@modelcontextprotocol/server`, `@modelcontextprotocol/sdk`, and
`agents` before changes; repeated installation/audit/explain after changes.
Initial sandboxed registry requests failed DNS resolution; reruns with approved
network access succeeded. `npm ci` also succeeded against the final lockfile.

| Package | Before | After | Why installed |
| --- | --- | --- | --- |
| @modelcontextprotocol/server | 2.0.0 | 2.3.1 | direct dependency and exact agents peer |
| @modelcontextprotocol/sdk | 1.30.0 | 1.32.1 | exact agents peer; absent from Worker |
| agents | 0.22.0 | 0.29.0 | direct dependency, stateless HTTP wrapper |
| @modelcontextprotocol/client | 2.0.0 | 2.3.1 | exact agents peer; absent from Worker |
| @modelcontextprotocol/core | 2.0.0 | 2.3.1 | exact MCP dependency |

`npm audit`/JSON before: **15 package findings: 3 low, 3 moderate, 8 high,
1 critical**. After: **8 package findings: 3 moderate, 4 high, 1 critical**
(audit exits 1, not a clean full dependency tree). Counts include meta findings
for packages depending on vulnerable packages; the table below lists every
unique underlying advisory and its own severity from audit JSON.

## Every advisory and Worker reachability

A local esbuild bundle of `src/index.ts`, with Worker resolution conditions,
text loaders for HTML/Markdown, and a binary WASM loader, retained npm sources
only from `@cloudflare/workers-oauth-provider`, `@modelcontextprotocol/core`,
`@modelcontextprotocol/server`, `agents`, and `zod`. Node/Cloudflare builtins were
external. This is a local import/reachability check, not a Wrangler deployment.
The integration regression separately bundles the actual `src/mcp.ts` and
runs requests through `agents/mcp/server` with no remote bindings.

| Advisory | Severity | Affected installed packages (before → after) | Reachable in Worker before fix? | Final audit |
| --- | --- | --- | --- | --- |
| [GHSA-866g-f22w-33x8](https://github.com/advisories/GHSA-866g-f22w-33x8) — @ai-sdk/provider-utils has an Uncontrolled Resource Consumption issue | low | `@ai-sdk/provider-utils` (4.0.27 → removed) | No: unused transitive/optional peer code, absent from Worker bundle. | Cleared |
| [GHSA-6qxp-vccf-f47h](https://github.com/advisories/GHSA-6qxp-vccf-f47h) — MCP TypeScript SDK: OAuth client could send credentials to an authorization server chosen by the MCP server | high | `@modelcontextprotocol/client` (2.0.0 → 2.3.1); `@modelcontextprotocol/sdk` (1.30.0 → 1.32.1) | No: no outbound MCP OAuth client; SDK/client peers absent from bundle. | Cleared |
| [GHSA-6prh-2h8m-c8cw](https://github.com/advisories/GHSA-6prh-2h8m-c8cw) — MCP TypeScript client SDK: HTTP client transports and OAuth requests followed cross-origin redirects and re-sent custom headers and request bodies | moderate | `@modelcontextprotocol/client` (2.0.0 → 2.3.1); `@modelcontextprotocol/sdk` (1.30.0 → 1.32.1) | No: no outbound MCP HTTP/OAuth client; SDK/client peers absent from bundle. | Cleared |
| [GHSA-22jm-h49p-29qw](https://github.com/advisories/GHSA-22jm-h49p-29qw) — MCP TypeScript SDK: Experimental tasks were not tied to the session that created them | high | `@modelcontextprotocol/sdk` (1.30.0 → 1.32.1) | No: no taskStore; SDK v1 is absent from bundle. | Cleared |
| [GHSA-46jr-4wx8-v453](https://github.com/advisories/GHSA-46jr-4wx8-v453) — MCP TypeScript SDK: One HTTP request within the default size limit could exhaust server memory during validation | high | `@modelcontextprotocol/sdk` (1.30.0 → 1.32.1); `@modelcontextprotocol/server` (2.0.0 → 2.3.1) | Yes: authenticated calls reach McpServer tool-input validation. | Cleared |
| [GHSA-rvq5-wwqv-78pq](https://github.com/advisories/GHSA-rvq5-wwqv-78pq) — MCP TypeScript SDK: Server bearer authentication accepted tokens issued for another service | moderate | `@modelcontextprotocol/sdk` (1.30.0 → 1.32.1); `@modelcontextprotocol/server` (2.0.0 → 2.3.1) | No: SDK bearer middleware is not used; workers-oauth-provider and Slopcafe authenticate upstream. | Cleared |
| [GHSA-jm63-cq47-j5jp](https://github.com/advisories/GHSA-jm63-cq47-j5jp) — MCP  TypeScript server SDK: Shared transport or server instances delivered one HTTP client's messages to another | high | `@modelcontextprotocol/server` (2.0.0 → 2.3.1) | No: a fresh server/transport per request; no shared instance. | Cleared |
| [GHSA-hrr3-gc8f-f4qj](https://github.com/advisories/GHSA-hrr3-gc8f-f4qj) — fast-uri vulnerable to inconsistent host case normalization via percent-encoded octets | moderate | `fast-uri` (3.1.7 → 3.1.7) | No: unused transitive/optional peer code, absent from Worker bundle. | Remains; not deployed |
| [GHSA-hxh3-vqpv-xpqv](https://github.com/advisories/GHSA-hxh3-vqpv-xpqv) — hono/jsx renders plain strings unescaped in boundary components, leading to XSS | moderate | `hono` (4.13.5 → 4.13.5) | No: unused transitive/optional peer code, absent from Worker bundle. | Remains; not deployed |
| [GHSA-5r4p-p66f-jhc7](https://github.com/advisories/GHSA-5r4p-p66f-jhc7) — Hono: `serveStatic` decodes the request path a second time, leading to bypass of middleware on static paths | moderate | `hono` (4.13.5 → 4.13.5) | No: unused transitive/optional peer code, absent from Worker bundle. | Remains; not deployed |
| [GHSA-rpw4-54j3-4h4q](https://github.com/advisories/GHSA-rpw4-54j3-4h4q) — ip-address: Address6.isLinkLocal() recognizes fe80::/64 rather than fe80::/10, allowing SSRF and trust-boundary bypass to on-link hosts | moderate | `ip-address` (10.3.1 → 10.3.1) | No: unused transitive/optional peer code, absent from Worker bundle. | Remains; not deployed |
| [GHSA-2vr4-cq9g-pvrc](https://github.com/advisories/GHSA-2vr4-cq9g-pvrc) — ip-address: no classifier recognizes the NAT64 local-use range 64:ff9b:1::/48, allowing SSRF and trust-boundary bypass | moderate | `ip-address` (10.3.1 → 10.3.1) | No: unused transitive/optional peer code, absent from Worker bundle. | Remains; not deployed |
| [GHSA-j6r3-76f7-8jcv](https://github.com/advisories/GHSA-j6r3-76f7-8jcv) — ip-address: isInSubnet() and isHostInSubnet() compare addresses of different families as if they shared an address space, allowing an allowlist check to admit an address outside its range | moderate | `ip-address` (10.3.1 → 10.3.1) | No: unused transitive/optional peer code, absent from Worker bundle. | Remains; not deployed |
| [GHSA-h3mg-xc3c-68pw](https://github.com/advisories/GHSA-h3mg-xc3c-68pw) — ip-address: Address6 builds a parse diagnostic proportional to the input with no length bound, allowing a single long string to stall or crash the process | moderate | `ip-address` (10.3.1 → 10.3.1) | No: unused transitive/optional peer code, absent from Worker bundle. | Remains; not deployed |
| [GHSA-jqcg-44mw-7w3h](https://github.com/advisories/GHSA-jqcg-44mw-7w3h) — proxy-addr vulnerable to IP spoofing via IPv4-mapped IPv6 trust subnet | critical | `proxy-addr` (2.0.7 → 2.0.7) | No: unused transitive/optional peer code, absent from Worker bundle. | Remains; not deployed |
| [GHSA-rgj7-g3m4-5g8c](https://github.com/advisories/GHSA-rgj7-g3m4-5g8c) — sharp: Vulnerabilities in libheif: GHSA-g89c-p67h-r497 and GHSA-2jg2-4ch7-h545 | high | `sharp` (0.35.2 → 0.35.2) | No: Wrangler/Miniflare development dependencies, absent from Worker bundle. | Remains; not deployed |
| [GHSA-wq5f-xc86-pv6w](https://github.com/advisories/GHSA-wq5f-xc86-pv6w) — sharp : Vulnerability in librsvg dependency CVE-2026-96889 | high | `sharp` (0.35.2 → 0.35.2) | No: Wrangler/Miniflare development dependencies, absent from Worker bundle. | Remains; not deployed |
| [GHSA-3wwx-pv8p-q78v](https://github.com/advisories/GHSA-3wwx-pv8p-q78v) — undici vulnerable to Denial of Service via unhandled error in WebSocket permessage-deflate decompression | moderate | `undici` (7.29.0 → 7.29.0) | No: Wrangler/Miniflare development dependencies, absent from Worker bundle. | Remains; not deployed |
| [GHSA-pmjh-fq2x-6v4x](https://github.com/advisories/GHSA-pmjh-fq2x-6v4x) — undici vulnerable to Denial of Service via orphaned RetryHandler response body | moderate | `undici` (7.29.0 → 7.29.0) | No: Wrangler/Miniflare development dependencies, absent from Worker bundle. | Remains; not deployed |
| [GHSA-r53p-7pc4-xj5r](https://github.com/advisories/GHSA-r53p-7pc4-xj5r) — undici vulnerable to downstream response splitting via retry interceptor | low | `undici` (7.29.0 → 7.29.0) | No: Wrangler/Miniflare development dependencies, absent from Worker bundle. | Remains; not deployed |
| [GHSA-rfgv-xxqx-mfg5](https://github.com/advisories/GHSA-rfgv-xxqx-mfg5) — undici vulnerable to Denial of Service via unrequested WebSocket subprotocol | high | `undici` (7.29.0 → 7.29.0) | No: Wrangler/Miniflare development dependencies, absent from Worker bundle. | Remains; not deployed |
| [GHSA-3xpg-4rpp-hhhm](https://github.com/advisories/GHSA-3xpg-4rpp-hhhm) — undici vulnerable to Denial of Service via unbounded decompression of compressed responses | moderate | `undici` (7.29.0 → 7.29.0) | No: Wrangler/Miniflare development dependencies, absent from Worker bundle. | Remains; not deployed |
| [GHSA-2jfj-6hjv-fm6j](https://github.com/advisories/GHSA-2jfj-6hjv-fm6j) — undici vulnerable to cross-user cookie disclosure via Set-Cookie caching in shared caches | moderate | `undici` (7.29.0 → 7.29.0) | No: Wrangler/Miniflare development dependencies, absent from Worker bundle. | Remains; not deployed |
| [GHSA-2gqq-gqf2-x968](https://github.com/advisories/GHSA-2gqq-gqf2-x968) — undici vulnerable to response truncation via oversized chunked responses in the dump interceptor | low | `undici` (7.29.0 → 7.29.0) | No: Wrangler/Miniflare development dependencies, absent from Worker bundle. | Remains; not deployed |
| [GHSA-w293-vg96-wgc3](https://github.com/advisories/GHSA-w293-vg96-wgc3) — undici vulnerable to TLS certificate validation bypass via dropped connect options in BalancedPool | high | `undici` (7.29.0 → 7.29.0) | No: Wrangler/Miniflare development dependencies, absent from Worker bundle. | Remains; not deployed |
| [GHSA-8436-99hf-9mmv](https://github.com/advisories/GHSA-8436-99hf-9mmv) — undici vulnerable to caching and replay of unsafe HTTP method responses | low | `undici` (7.29.0 → 7.29.0) | No: Wrangler/Miniflare development dependencies, absent from Worker bundle. | Remains; not deployed |
| [GHSA-rx4f-c7p8-82vq](https://github.com/advisories/GHSA-rx4f-c7p8-82vq) — undici vulnerable to Denial of Service via WebSocketStream unclean close | moderate | `undici` (7.29.0 → 7.29.0) | No: Wrangler/Miniflare development dependencies, absent from Worker bundle. | Remains; not deployed |

Meta findings before: `@ai-sdk/gateway` and `ai` (low via provider-utils),
`agents` (high via MCP packages), and `miniflare`/`wrangler` (high via sharp and
undici). After, only the `miniflare`/`wrangler` meta findings remain. All other
remaining advisories above are outside the deployed Worker import graph;
Of the eight remaining package findings, four are dev-only (`wrangler`,
`miniflare`, `sharp`, `undici`); four are in the unused v1 SDK peer tree
(`fast-uri`, `hono`, `ip-address`, `proxy-addr`). Both groups are outside the
Worker bundle, but only the first group is dev/build-only. Remediation is
separate work.

## Validation

- `npm run typecheck`: passed after the review fix, from a clean install and
  an isolated temporary copy. The initial claim was masked by an ancestor
  dependency; see the review correction below.
- `npm test`: passed in full, including the sanitizer's **142 unit tests +
  2 bypass-corpus integration tests**, docs freshness, and every JS suite.
- `npm run build:wasm`: passed with approved local build/cache access, enabling
  docs tests; no need to skip cargo tests. `npm run build:docs`: passed.
- New `test:mcp-input-limits.test.mjs`: actual production MCP server and tool
  registrations reject over-budget invalid arrays, object-key floods, and
  nested edits before service access, in **2026-07-28 and legacy 2025-11-25**
  protocol lanes. A 1,000-edit batch with metadata and ten tags passes SDK
  validation and reaches the handler's identity check. A 3 MiB content string
  also reaches that check, proving strings do not spend the structural budget.
  An exactly-at-limit input (1,364 two-key edits + two tags + two top-level
  keys = 4,096 elements) reaches the handler in both protocol lanes.
- Local Worker bundle: passed; neither v1 SDK/client nor any remaining flagged
  package is included. No `wrangler deploy` (including dry-run) was invoked.
- Final npm audit: both requested advisories and all MCP advisories cleared;
  remaining eight package findings documented above. No `npm audit fix` used.

## Review correction (PR 76)

Muse found that the agents peer pruning removed the only hoisted installation
of `@standard-schema/spec`, imported as a type by `src/mcp-lean-schema.ts:29`.
Declare it directly as an exact devDependency, **1.1.0**, and lock it explicitly.
This restores a declared build dependency; it adds no Worker runtime code.

The earlier typecheck did exit successfully in this worktree, but that was
insufficient evidence for a clean checkout. A TypeScript resolution trace
showed it finding version 1.1.0 at
`/Users/kyle/Repos/slopcafe/node_modules/@standard-schema/spec/dist/index.d.ts`,
in the primary checkout above this nested worktree. This was an ancestor
`node_modules` fallback, not a stale copy inside the worktree. That masked the
missing lockfile dependency even after `npm ci`; the initial PR's typecheck
claim did not establish reproducibility. In an isolated temporary copy without
that ancestor, removing the spec package reproduces Muse's sole TS2307 error;
restoring the declared package makes typecheck pass.

Review validation: removed the worktree's `node_modules` entirely, ran `npm ci`,
and ran `npm run typecheck` successfully. A new resolution trace points to the
worktree's own spec package. An independent `/private/tmp` copy installed from
the same package/lock files also passed typecheck, with no primary checkout in
its module search path. The full `npm test` suite, including all MCP suites,
input-limit boundary cases, and 144 Rust tests, passed again. Clean-install
audit still reports the same eight non-bundled package findings described above.
