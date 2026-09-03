// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

// GENERATED FILE — DO NOT EDIT. Regenerate with `npm run build:docs`
// (scripts/build-docs.mjs), which `predeploy` runs. Edits here are overwritten
// and will fail the freshness gate in test/docs-bundle.test.mjs.
//
// The bundled platform-documentation corpus: for each mapped repo doc, its
// link-rewritten Markdown source and the sanitized HTML render, both produced
// at build time by the same WASM sanitizer the Worker runs at write time.
// Serving these from `/docs/…` is what makes an instance's documentation match
// its own deployed build by construction (GitHub issue #4).

/** Sanitizer version the bundled HTML was rendered with, for diagnostics. */
export const DOCS_SANITIZER_VERSION = "ammonia-v1.7";

export type PlatformDoc = {
  /** Route segment: `/docs/<name>`. Unique across the corpus. */
  name: string;
  /** Source path in the repo — the thing this doc is generated FROM. */
  path: string;
  /** Derived from the doc's first H1, as the platform derives document titles. */
  title: string;
  description: string | null;
  tags: string[];
  /** Whether this doc is also seeded into the corpus as a Document. */
  seed: boolean;
  markdownBytes: number;
  htmlBytes: number;
  /** sha256 of `markdown` — the bytes the seeder publishes. */
  sourceSha256: string;
  /** Link-rewritten Markdown source (S). */
  markdown: string;
  /** Sanitized render (H). */
  html: string;
};

import md_action_plan_v1 from "./docs/action-plan-v1.md";
import html_action_plan_v1 from "./docs/action-plan-v1.html";
import md_api_contract_design from "./docs/api-contract-design.md";
import html_api_contract_design from "./docs/api-contract-design.html";
import md_api_contract_phase2_routes from "./docs/api-contract-phase2-routes.md";
import html_api_contract_phase2_routes from "./docs/api-contract-phase2-routes.html";
import md_backlinks_design from "./docs/backlinks-design.md";
import html_backlinks_design from "./docs/backlinks-design.html";
import md_byte_exact_publish_design from "./docs/byte-exact-publish-design.md";
import html_byte_exact_publish_design from "./docs/byte-exact-publish-design.html";
import md_content_domain_design from "./docs/content-domain-design.md";
import html_content_domain_design from "./docs/content-domain-design.html";
import md_context_packs_design from "./docs/context-packs-design.md";
import html_context_packs_design from "./docs/context-packs-design.html";
import md_dcr_design from "./docs/dcr-design.md";
import html_dcr_design from "./docs/dcr-design.html";
import md_feature_roadmap from "./docs/feature-roadmap.md";
import html_feature_roadmap from "./docs/feature-roadmap.html";
import md_font_support_design from "./docs/font-support-design.md";
import html_font_support_design from "./docs/font-support-design.html";
import md_for_agents from "./docs/for-agents.md";
import html_for_agents from "./docs/for-agents.html";
import md_http_api from "./docs/http-api.md";
import html_http_api from "./docs/http-api.html";
import md_http_api_quickstart from "./docs/http-api-quickstart.md";
import html_http_api_quickstart from "./docs/http-api-quickstart.html";
import md_librarian_design from "./docs/librarian-design.md";
import html_librarian_design from "./docs/librarian-design.html";
import md_mcp_apps_design from "./docs/mcp-apps-design.md";
import html_mcp_apps_design from "./docs/mcp-apps-design.html";
import md_publishing_guide from "./docs/publishing-guide.md";
import html_publishing_guide from "./docs/publishing-guide.html";
import md_security_model from "./docs/security-model.md";
import html_security_model from "./docs/security-model.html";
import md_source_retention_design from "./docs/source-retention-design.md";
import html_source_retention_design from "./docs/source-retention-design.html";
import md_spec_platform from "./docs/spec-platform.md";
import html_spec_platform from "./docs/spec-platform.html";
import md_spec_solo from "./docs/spec-solo.md";
import html_spec_solo from "./docs/spec-solo.html";
import md_style_support_design from "./docs/style-support-design.md";
import html_style_support_design from "./docs/style-support-design.html";
import md_vector_search_design from "./docs/vector-search-design.md";
import html_vector_search_design from "./docs/vector-search-design.html";

/** Every bundled doc, ordered by `name`. */
export const PLATFORM_DOCS: readonly PlatformDoc[] = [
  {
    name: "action-plan-v1",
    path: "docs/design/action-plan-v1.md",
    title: "Agent Content Host — Action Plan (v1)",
    description: null,
    tags: [],
    seed: false,
    markdownBytes: 9093,
    htmlBytes: 10441,
    sourceSha256: "ec10f395dd22554fdffe4809d0b7d47d1491ff8f75246be3b7fc5c2755d16e5b",
    markdown: md_action_plan_v1,
    html: html_action_plan_v1,
  },
  {
    name: "api-contract-design",
    path: "docs/design/api-contract-design.md",
    title: "Formalizing the API contract (code-first OpenAPI + codegen) — design note",
    description: null,
    tags: [],
    seed: false,
    markdownBytes: 37095,
    htmlBytes: 44734,
    sourceSha256: "8da067f2bb8d5ced76e9c7ed4611f81ff46ef688afe01835a02dcef7a9b57850",
    markdown: md_api_contract_design,
    html: html_api_contract_design,
  },
  {
    name: "api-contract-phase2-routes",
    path: "docs/design/api-contract-phase2-routes.md",
    title: "Phase 2 route table (the OpenAPI `paths` source)",
    description: null,
    tags: [],
    seed: false,
    markdownBytes: 27256,
    htmlBytes: 33207,
    sourceSha256: "24194cc05d72e2465f39999c231c3caad04e749af240a2194d20ee404d31faed",
    markdown: md_api_contract_phase2_routes,
    html: html_api_contract_phase2_routes,
  },
  {
    name: "backlinks-design",
    path: "docs/design/backlinks-design.md",
    title: "Wiki-style backlinks: the document link graph",
    description: null,
    tags: [],
    seed: false,
    markdownBytes: 11392,
    htmlBytes: 13172,
    sourceSha256: "943b590a23af98a97e68a9c12d6dd2ee33ad246b14e8002961d256fb1e36ba24",
    markdown: md_backlinks_design,
    html: html_backlinks_design,
  },
  {
    name: "byte-exact-publish-design",
    path: "docs/design/byte-exact-publish-design.md",
    title: "Byte-exact publishing — design note",
    description: null,
    tags: [],
    seed: false,
    markdownBytes: 14052,
    htmlBytes: 16106,
    sourceSha256: "f93dcc1b3eb3fb280e6564093e0424ddef30cbbc489a5ee49421e77a54048bc4",
    markdown: md_byte_exact_publish_design,
    html: html_byte_exact_publish_design,
  },
  {
    name: "content-domain-design",
    path: "docs/design/content-domain-design.md",
    title: "Separate content domain (+ scripted documents) — design note",
    description: null,
    tags: [],
    seed: false,
    markdownBytes: 21363,
    htmlBytes: 25231,
    sourceSha256: "bd7c93d1dbb24642480be12178332f4d829e4742eda762003e70622364c59569",
    markdown: md_content_domain_design,
    html: html_content_domain_design,
  },
  {
    name: "context-packs-design",
    path: "docs/design/context-packs-design.md",
    title: "Context Packs — design note",
    description: null,
    tags: [],
    seed: false,
    markdownBytes: 27025,
    htmlBytes: 32404,
    sourceSha256: "34ca42b48a84b18be7809c6b9a2b80ae071dc43b25962d7ed98afb8bcb5cf0c4",
    markdown: md_context_packs_design,
    html: html_context_packs_design,
  },
  {
    name: "dcr-design",
    path: "docs/design/dcr-design.md",
    title: "Dynamic Client Registration (DCR) — design note",
    description: null,
    tags: [],
    seed: false,
    markdownBytes: 14246,
    htmlBytes: 17573,
    sourceSha256: "7511bf767556cc551f935e35cc4943c26b897926c6fa250f781384f196c2c563",
    markdown: md_dcr_design,
    html: html_dcr_design,
  },
  {
    name: "feature-roadmap",
    path: "docs/feature-roadmap.md",
    title: "Slopcafe — Feature Roadmap",
    description: null,
    tags: [],
    seed: false,
    markdownBytes: 14327,
    htmlBytes: 17817,
    sourceSha256: "6777c783d4baf949888d7a5ba7febbac8cfb9fad18c330737b5dbdadc07a4afe",
    markdown: md_feature_roadmap,
    html: html_feature_roadmap,
  },
  {
    name: "font-support-design",
    path: "docs/design/font-support-design.md",
    title: "Supporting a curated font library — design note",
    description: null,
    tags: [],
    seed: false,
    markdownBytes: 20161,
    htmlBytes: 24419,
    sourceSha256: "ce39def6c411fe7c8a989d54d486238bbad4fb80f1fbc7390e2272fdd83a0143",
    markdown: md_font_support_design,
    html: html_font_support_design,
  },
  {
    name: "for-agents",
    path: "docs/for-agents.md",
    title: "Slopcafe for agents",
    description: null,
    tags: [],
    seed: false,
    markdownBytes: 15749,
    htmlBytes: 19856,
    sourceSha256: "236f4ba17908d4d85f6094d4628506597d44134456a35653c623af9fb7f2ffb3",
    markdown: md_for_agents,
    html: html_for_agents,
  },
  {
    name: "http-api",
    path: "docs/http-api.md",
    title: "Slopcafe HTTP API reference",
    description: null,
    tags: [],
    seed: false,
    markdownBytes: 192386,
    htmlBytes: 256140,
    sourceSha256: "832faa9cc95dce8bce916eb5050e52ba5e2bb1ee37dc005206c8f8fa1837225d",
    markdown: md_http_api,
    html: html_http_api,
  },
  {
    name: "http-api-quickstart",
    path: "docs/http-api-quickstart.md",
    title: "Slopcafe HTTP API quickstart",
    description: "The five-minute HTTP on-ramp: base URL, the auth header, and the four routes a script needs to publish, update, read and list documents without the MCP tools. Companion to the byte-exact curl path.",
    tags: ["slopcafe", "guide", "http", "api"],
    seed: true,
    markdownBytes: 12976,
    htmlBytes: 16387,
    sourceSha256: "e361683d565ceb7266f133d33aa13a1b146962aa129d6e466a32c9ecbada0ef8",
    markdown: md_http_api_quickstart,
    html: html_http_api_quickstart,
  },
  {
    name: "librarian-design",
    path: "docs/design/librarian-design.md",
    title: "Librarian — design note",
    description: null,
    tags: [],
    seed: false,
    markdownBytes: 21018,
    htmlBytes: 24071,
    sourceSha256: "a98211eb37970017716515490480c08f78b172dcea083914954a0e68a3fb1cbd",
    markdown: md_librarian_design,
    html: html_librarian_design,
  },
  {
    name: "mcp-apps-design",
    path: "docs/design/mcp-apps-design.md",
    title: "MCP Apps (SEP-1865) — design note",
    description: null,
    tags: [],
    seed: false,
    markdownBytes: 16728,
    htmlBytes: 19312,
    sourceSha256: "c4cc859678be40c8c691f27ca8e82143f468e4a93b21256ca23ec6936c84d8fc",
    markdown: md_mcp_apps_design,
    html: html_mcp_apps_design,
  },
  {
    name: "publishing-guide",
    path: "skills/publishing.md",
    title: "Publishing HTML to Slopcafe",
    description: "The Slopcafe document authoring contract: what HTML/CSS/SVG survives sanitization (static-only, inline styles, inline SVG, the allowed tag/attribute list, the URL-scheme allowlist, and the table of what is silently stripped), plus the Markdown input path. Read before publishing anything with layout or visuals.",
    tags: ["slopcafe", "guide", "security", "publishing"],
    seed: true,
    markdownBytes: 96111,
    htmlBytes: 121716,
    sourceSha256: "fb7017862bebbe697f4bbc2ed1de972a8014628897bc287e9e9ec73b74b0d5d6",
    markdown: md_publishing_guide,
    html: html_publishing_guide,
  },
  {
    name: "security-model",
    path: "docs/security-model.md",
    title: "Slopcafe security model — sanitize and sandbox",
    description: null,
    tags: [],
    seed: false,
    markdownBytes: 43028,
    htmlBytes: 52717,
    sourceSha256: "2cddbc3995115c378d3ae06b6181417aa3d73b07ca4cea9d853deedba10a77ac",
    markdown: md_security_model,
    html: html_security_model,
  },
  {
    name: "source-retention-design",
    path: "docs/design/source-retention-design.md",
    title: "Source retention — design note",
    description: null,
    tags: [],
    seed: false,
    markdownBytes: 28997,
    htmlBytes: 34445,
    sourceSha256: "00264703096d0648cb96e8634880813944b77248102062fd94a374e470f1b77f",
    markdown: md_source_retention_design,
    html: html_source_retention_design,
  },
  {
    name: "spec-platform",
    path: "docs/design/agent-knowledge-host-spec-PLATFORM-v2.md",
    title: "Agent Knowledge Host — v1 Technical Specification",
    description: null,
    tags: [],
    seed: false,
    markdownBytes: 244368,
    htmlBytes: 275417,
    sourceSha256: "66235e3acc87dc965789fe6b321658693c9aae002106534d315925dc883c8321",
    markdown: md_spec_platform,
    html: html_spec_platform,
  },
  {
    name: "spec-solo",
    path: "docs/design/agent-knowledge-host-spec-SOLO-v1.md",
    title: "Agent Knowledge Host — Single-Operator Fork (SOLO v1)",
    description: null,
    tags: [],
    seed: false,
    markdownBytes: 107861,
    htmlBytes: 123216,
    sourceSha256: "d78b84e19d62b96a947e7437ea4712cc1e207c98f26ee566daf198dadf5157ee",
    markdown: md_spec_solo,
    html: html_spec_solo,
  },
  {
    name: "style-support-design",
    path: "docs/design/style-support-design.md",
    title: "Supporting `<style>` blocks — design note",
    description: null,
    tags: [],
    seed: false,
    markdownBytes: 24435,
    htmlBytes: 31581,
    sourceSha256: "be4130d5bbe5152cb1f80acfce303a3f7bfb0e2d809f1c544fea83263d61364a",
    markdown: md_style_support_design,
    html: html_style_support_design,
  },
  {
    name: "vector-search-design",
    path: "docs/design/vector-search-design.md",
    title: "Semantic (vector) search — design note",
    description: null,
    tags: [],
    seed: false,
    markdownBytes: 41025,
    htmlBytes: 47720,
    sourceSha256: "bc89bf63c69b48ff6afcf1861cf6345319f29b37b46411c9d7a082823e685182",
    markdown: md_vector_search_design,
    html: html_vector_search_design,
  },
];

/** Lookup by route segment. */
export const PLATFORM_DOCS_BY_NAME: ReadonlyMap<string, PlatformDoc> = new Map(
  PLATFORM_DOCS.map((d) => [d.name, d]),
);
