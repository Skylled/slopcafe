/**
 * MCP transport mount for /mcp.
 *
 * Streamable HTTP via the Cloudflare Agents SDK's `createMcpHandler`,
 * with a per-request `McpServer` (MCP SDK ≥1.26 forbids reuse — cross-
 * request state would leak otherwise). Eleven agent-scoped tools mirror
 * the HTTP verbs:
 *   publish_document            publish_document_markdown
 *   update_document             update_document_markdown
 *   edit_document               read_document
 *   read_document_text          list_documents
 *   find_document_by_slug       search_documents
 *   create_publish_credential
 * Provenance is stamped from the resolved `agentId` closure-captured at
 * registration time. (`create_publish_credential` is the one tool that
 * doesn't touch a document — it mints a short-lived `awh_` key for the
 * byte-exact curl publish path; see mintEphemeralKey in src/admin.ts.)
 * `edit_document` is the server-side find/replace surface — a small-diff
 * alternative to update_document that has NO HTTP equivalent (MCP-only).
 *
 * The four WRITE tools accept optional metadata (title / description /
 * tags / slug) with publish-vs-update inheritance semantics — see the shared
 * TITLE_FIELD / DESCRIPTION_FIELD / TAGS_FIELD / SLUG_FIELD constants below
 * the `handleMcp` function for the contract; src/metadata.ts implements it.
 * `slug` differs from the other three: it lives on the document (not the
 * version) and uniqueness is enforced — see SLUG_FIELD for the contract.
 *
 * Auth (Door A OAuth or Door B static bearer) is resolved upstream in
 * src/mcp-auth.ts and passed in as `props`. Tools see the agent identity
 * via that closure — they never re-validate.
 *
 * Logging discipline: console.error tool-name + error-code only. Never
 * args (may contain user HTML), never the Request headers (may contain
 * the bearer), never the OAuth token.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHandler } from "agents/mcp";
import { z } from "zod";

import {
  EPHEMERAL_KEY_DEFAULT_TTL_SECONDS,
  EPHEMERAL_KEY_MAX_TTL_SECONDS,
  EPHEMERAL_KEY_MIN_TTL_SECONDS,
  mintEphemeralKey,
} from "./admin.js";
import {
  type DocumentMetadataInput,
  editDocumentCore,
  findDocumentBySlugCore,
  listDocumentsCore,
  publishDocumentCore,
  readDocumentCore,
  readDocumentTextCore,
  searchDocumentsCore,
  updateDocumentCore,
} from "./core.js";
import type { Env } from "./env.js";
import type { AwhProps } from "./mcp-auth.js";
import { validateSlugInput } from "./metadata.js";
import { MAX_LIMIT, parseMcpListArgs } from "./pagination.js";
import { buildFtsMatchQuery } from "./search.js";
// Bundled via wrangler's `type = "Text"` rule (see wrangler.toml). Imported
// here so the awh://publishing-guide resource serves the same bytes the
// repo maintains for human readers — no second copy to drift.
import publishingGuideMd from "../skills/publishing.md";

/**
 * Build the MCP server and dispatch a single request. Called from the
 * worker's main fetch handler once auth has resolved.
 */
export async function handleMcp(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  props: AwhProps,
): Promise<Response> {
  const origin = new URL(request.url).origin;

  // PER-REQUEST. Do not hoist. The MCP SDK ≥1.26 throws on reused server
  // instances; sharing across requests would also bleed state (e.g. an
  // in-flight tool's args/results) between concurrent isolates.
  const server = new McpServer(
    { name: "agent-web-host", version: "0.4.0" },
    { capabilities: { tools: {}, resources: {} } },
  );

  // awh://publishing-guide — the full authoring contract (allowlist, SVG
  // subset, URL schemes, stripped table). The tool descriptions carry the
  // non-negotiables; this resource carries the long detail an agent only
  // needs on demand (e.g. when modified: true is unexpected, or when
  // authoring a non-trivial SVG). Sourced from skills/publishing.md so the
  // bytes can't drift from the doc the repo maintains for human readers.
  //
  // Resource-surfacing varies by client. If a given client doesn't expose
  // resources to the model automatically, the tool descriptions still
  // stand alone — that's why Level 1 of the addendum came first.
  server.registerResource(
    "publishing-guide",
    "awh://publishing-guide",
    {
      title: "agent-web-host publishing guide",
      description:
        "The full HTML/CSS/SVG authoring contract for agent-web-host: allowed " +
        "tag list, SVG drawing-primitive subset, URL-scheme allowlist, and the " +
        "table of constructs that get silently stripped or CSP-blocked at " +
        "render. Read this when a publish_document/update_document response " +
        "has modified: true and you need to know which categories of content " +
        "to avoid, or when authoring non-trivial inline SVG. The HTTP/Bearer " +
        "sections at the top describe the direct-HTTP API (not the MCP path " +
        "you're already on) — skip them; the allowlist sections are the " +
        "authoritative part for MCP callers too.",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.toString(),
          mimeType: "text/markdown",
          text: publishingGuideMd,
        },
      ],
    }),
  );

  server.registerTool(
    "publish_document",
    {
      // The positive contract — what to MAKE, not just what gets stripped.
      // Ordered by priority so a length-trimmed render still carries the
      // two non-negotiables (static/no-JS, SVG-not-images). See the addendum
      // "Level 1" rationale: a cold agent never reads the publishing skill,
      // so this description is the only contract it sees at call time.
      description:
        "Publish a new HTML document and get back an unguessable URL a human can open. " +
        "STATIC HTML SURFACE — no JavaScript runs (<script>, on*= handlers, and " +
        "javascript:/data:/vbscript: URLs are stripped). For any visual (chart, " +
        "diagram, icon) use INLINE SVG — <img> does not work in v1 (external src is " +
        "CSP-blocked at render; data: src is sanitizer-stripped). All styling must be " +
        "INLINE style=\"...\" attributes — <style> blocks and <link rel=stylesheet> are " +
        "dropped. NO EXTERNAL RESOURCES — images, fonts, and stylesheets must be " +
        "inline or absent. Allowed: standard text/structure/list/table tags, inline " +
        "SVG drawing primitives, role/aria-*, and inline styles. Links work normally: " +
        "external http(s) links auto-open in a new tab, in-page #anchors stay in-frame " +
        "(you don't set target). For the full allowlist " +
        "(every allowed tag/attribute, the SVG subset, URL-scheme list, and the " +
        "stripped table), read the awh://publishing-guide MCP resource. " +
        "OPTIONAL METADATA: `title` (omit to derive from the first <h1> or the doc's " +
        "first ~80 chars of text; ≤300 chars; surfaces in the browser tab as " +
        "`{title} | Slopcafe` with anti-phishing normalization). `description` (≤500 " +
        "chars; visible to humans via <meta name=description> and to agents in " +
        "read_document_text/list_documents). `tags` (array of short strings; charset " +
        "restricted to [A-Za-z0-9_-] with invalid chars silently stripped; max 10 tags " +
        "× 32 chars; deduped). `slug` (optional unique handle; lowercase URL-safe; " +
        "/^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/; rejected on invalid charset and on " +
        "collision with another doc's slug — released when the doc is revoked). All " +
        "four are echoed back in the response. " +
        "Returns public_id, the shareable url, version (1 for new), size_bytes, " +
        "sanitizer_v, a `modified` flag (true = the sanitizer changed your input), " +
        "`stripped[]` summarizing what was removed (best-effort), `will_not_render[]` " +
        "for elements that survived the sanitizer but the iframe CSP will block — most " +
        "importantly external <img src>, which would otherwise render as a broken " +
        "image with no other signal — and the resolved `title`/`description`/`tags`/`slug`. " +
        "ERRORS: `invalid_slug` (charset/length rejected — message describes which rule), " +
        "`slug_taken` (another live doc already has that slug). " +
        "LARGE EXISTING FILES: if the document already exists as a file on disk and you " +
        "have a shell, prefer the byte-exact HTTP path (POST /d with `curl --data-binary " +
        "@file`, plus an optional `X-Content-SHA256` integrity check) over passing it as " +
        "this `html` argument — a tool argument is regenerated token-by-token, which is " +
        "slow and truncation-prone for large bodies. Get a short-lived bearer for that " +
        "curl call from the `create_publish_credential` tool. That HTTP integrity check " +
        "has no MCP equivalent (the hash must come from the shell, not the model); see " +
        "awh://publishing-guide.",
      inputSchema: {
        html: z
          .string()
          .describe(
            "The HTML document body. Static HTML only (no JS), inline styles, " +
            "inline SVG for visuals (no <img>), no external resources.",
          ),
        title: TITLE_FIELD,
        description: DESCRIPTION_FIELD,
        tags: TAGS_FIELD,
        slug: SLUG_FIELD,
      },
    },
    async ({ html, title, description, tags, slug }) => {
      try {
        const result = await publishDocumentCore(
          env,
          html,
          props.agentId,
          origin,
          "html",
          metadataInputFromArgs(title, description, tags, slug),
        );
        if (!result.ok) {
          return textError(translatePublishError(result));
        }
        return textOk(JSON.stringify(writeOkResponse(result)));
      } catch (err) {
        console.error("mcp.publish_document.threw", String(err));
        return textError("internal error publishing document");
      }
    },
  );

  server.registerTool(
    "publish_document_markdown",
    {
      // Sibling to publish_document for agents that find it easier to author
      // in Markdown than HTML. Lead with what's different from the HTML tool
      // (the parser + the GFM features); leave the long allowlist talk in the
      // publishing-guide resource. The note about inline HTML being sanitized
      // is the most important line — it answers "what if I include raw HTML?"
      // before the agent has to ask.
      description:
        "Publish a new document authored in Markdown and get back an unguessable URL " +
        "a human can open. The Markdown is parsed (CommonMark + GFM: tables, " +
        "strikethrough, task lists, footnotes) into HTML, then run through the same " +
        "sanitizer as publish_document — so the rules about NO JavaScript, NO " +
        "external resources, and NO <style> blocks still apply to any inline HTML " +
        "you include in the Markdown. Pure-Markdown content (headings, lists, " +
        "tables, code, links, emphasis) passes through cleanly; raw <script> or " +
        "<style> blocks in your Markdown source get stripped exactly as they would " +
        "from a publish_document call. GFM task list checkboxes (`- [ ]`) emit " +
        "<input type=checkbox>, which the sanitizer strips (form controls aren't " +
        "in the allowlist) — the surrounding text survives, but the checkbox is " +
        "gone; use a plain bullet or unicode ☐/☑ if you need the visual marker. " +
        "Stored as sanitized HTML (the Markdown source is not retained — read_document " +
        "returns HTML; read_document_text re-derives Markdown from it, which may not " +
        "match your input exactly). " +
        "OPTIONAL METADATA: same `title`/`description`/`tags`/`slug` fields as " +
        "publish_document (omit title to derive from the first # heading; tags charset " +
        "restricted to [A-Za-z0-9_-]; slug is a lowercase URL-safe unique handle; see " +
        "publish_document for full rules). Returns the same shape: public_id, url, " +
        "version (1 for new), size_bytes, sanitizer_v, `modified` (true = the sanitizer " +
        "changed something the parser produced), `stripped[]`, `will_not_render[]`, and " +
        "the resolved `title`/`description`/`tags`/`slug`. Same `invalid_slug` / " +
        "`slug_taken` error path as publish_document.",
      inputSchema: {
        markdown: z
          .string()
          .describe(
            "The Markdown document. CommonMark + GFM features (tables, strikethrough, " +
            "task lists, footnotes). Inline HTML is allowed but gets sanitized — same " +
            "rules as publish_document. No frontmatter is parsed; YAML front-matter " +
            "would appear as a literal paragraph at the top.",
          ),
        title: TITLE_FIELD,
        description: DESCRIPTION_FIELD,
        tags: TAGS_FIELD,
        slug: SLUG_FIELD,
      },
    },
    async ({ markdown, title, description, tags, slug }) => {
      try {
        const result = await publishDocumentCore(
          env,
          markdown,
          props.agentId,
          origin,
          "markdown",
          metadataInputFromArgs(title, description, tags, slug),
        );
        if (!result.ok) {
          return textError(translatePublishError(result));
        }
        return textOk(JSON.stringify(writeOkResponse(result)));
      } catch (err) {
        console.error("mcp.publish_document_markdown.threw", String(err));
        return textError("internal error publishing document");
      }
    },
  );

  server.registerTool(
    "update_document",
    {
      // Same HTML rules as publish_document, restated for cold agents that
      // call update_ before publish_ in the same session and never see the
      // publish description. The replace-not-merge point is also restated
      // because patch/merge is the natural assumption from other CRUD APIs.
      description:
        "Append a new version to an existing document. Requires the current version " +
        "number for optimistic concurrency. If the document has been updated since " +
        "you last saw it, this returns a version conflict with the actual current " +
        "version; refetch and retry. Omit expected_version (or pass null) to clobber " +
        "without a version check (last-write-wins). Same HTML rules as " +
        "publish_document: STATIC ONLY (no JavaScript), INLINE STYLES (no <style> " +
        "blocks), INLINE SVG for visuals (no <img>), no external resources. The body " +
        "REPLACES the prior version — it does not merge or patch. For the full " +
        "allowlist (tags, SVG subset, URL schemes, stripped table), read the " +
        "awh://publishing-guide MCP resource. " +
        "OPTIONAL METADATA (`title`, `description`, `tags`, `slug`) follows " +
        "INHERIT-ON-OMIT semantics: an omitted field carries over from the prior " +
        "version unchanged (typical when you're only updating content), an empty " +
        "value clears it (description → null; tags → []; slug → null/released) — and " +
        "for title, an empty string re-derives from the new content. Constraints " +
        "match publish_document (cap 300/500 chars; tags charset restricted to " +
        "[A-Za-z0-9_-], max 10 × 32 chars; slug must match /^[a-z0-9](?:[a-z0-9_-]{0,62}" +
        "[a-z0-9])?$/ and not collide with another live doc's slug). Setting a slug " +
        "that differs from the current value ATOMICALLY releases the old and claims " +
        "the new. The resolved values come back in the response. " +
        "Returns the same shape as publish_document, including `modified`, " +
        "`stripped[]` (what the sanitizer removed, best-effort), `will_not_render[]` " +
        "(constructs that survived sanitize but the iframe CSP will block — notably " +
        "external <img src>), and the resolved `title`/`description`/`tags`/`slug`. " +
        "ERRORS: `invalid_slug` and `slug_taken` mirror publish_document. " +
        "LARGE EXISTING FILES: for a sizable file you already have on disk, prefer the " +
        "byte-exact HTTP path (PUT /d/:id with `curl --data-binary @file`, `If-Match`, and " +
        "an optional `X-Content-SHA256` integrity check) over regenerating it as this " +
        "`html` argument — get a short-lived bearer for that curl call from the " +
        "`create_publish_credential` tool; the integrity check is HTTP-only by design; " +
        "see awh://publishing-guide.",
      inputSchema: {
        public_id: z.string().describe("22-char public_id from a prior publish_document call."),
        html: z
          .string()
          .describe(
            "The new HTML content. REPLACES the prior version (no merge/patch). " +
            "Static HTML only, inline styles, inline SVG for visuals, no external resources.",
          ),
        expected_version: z
          .number()
          .int()
          .min(1)
          .nullable()
          .optional()
          .describe(
            "The version number you believe is current. Omit or pass null to overwrite without a version check.",
          ),
        title: TITLE_FIELD_UPDATE,
        description: DESCRIPTION_FIELD_UPDATE,
        tags: TAGS_FIELD_UPDATE,
        slug: SLUG_FIELD_UPDATE,
      },
    },
    async ({ public_id, html, expected_version, title, description, tags, slug }) => {
      try {
        const result = await updateDocumentCore(
          env,
          public_id,
          html,
          expected_version ?? null,
          props.agentId,
          origin,
          "html",
          metadataInputFromArgs(title, description, tags, slug),
        );
        if (!result.ok) {
          return textError(translateUpdateError(result));
        }
        return textOk(JSON.stringify(writeOkResponse(result)));
      } catch (err) {
        console.error("mcp.update_document.threw", String(err));
        return textError("internal error updating document");
      }
    },
  );

  server.registerTool(
    "update_document_markdown",
    {
      // Markdown sibling to update_document. Same conventions as
      // publish_document_markdown above (GFM features, inline HTML gets
      // sanitized) plus the same If-Match-style optimistic-concurrency
      // contract as update_document. Cross-format updates are allowed —
      // a document published as HTML can be updated with Markdown and
      // vice versa; versions.source_format records which path each
      // version took.
      description:
        "Append a new Markdown-authored version to an existing document. Same " +
        "optimistic-concurrency contract as update_document — pass the current " +
        "version number for expected_version (returns version_conflict if the " +
        "document has been updated since), or omit/null to clobber. The Markdown " +
        "(CommonMark + GFM) is parsed to HTML, then run through the same sanitizer " +
        "as update_document — NO JavaScript, NO external resources, NO <style> " +
        "blocks, even for inline HTML embedded in the Markdown source. Cross-format " +
        "updates work: a document originally published as HTML can be updated with " +
        "Markdown and vice versa. The body REPLACES the prior version (no merge or " +
        "patch). " +
        "OPTIONAL METADATA (`title`, `description`, `tags`, `slug`) follows the same " +
        "INHERIT-ON-OMIT semantics as update_document — omit to keep prior values, " +
        "empty string/array to clear (title's \"\" re-derives from new content; slug's " +
        "\"\" releases the slug). Returns the same shape as update_document: public_id, " +
        "url, version, size_bytes, sanitizer_v, `modified`, `stripped[]`, " +
        "`will_not_render[]`, and the resolved `title`/`description`/`tags`/`slug`. " +
        "Same `invalid_slug` / `slug_taken` error path as update_document.",
      inputSchema: {
        public_id: z.string().describe("22-char public_id from a prior publish call."),
        markdown: z
          .string()
          .describe(
            "The new Markdown content. REPLACES the prior version (no merge/patch). " +
            "CommonMark + GFM (tables, strikethrough, task lists, footnotes). Inline " +
            "HTML allowed but sanitized (same rules as update_document).",
          ),
        expected_version: z
          .number()
          .int()
          .min(1)
          .nullable()
          .optional()
          .describe(
            "The version number you believe is current. Omit or pass null to overwrite without a version check.",
          ),
        title: TITLE_FIELD_UPDATE,
        description: DESCRIPTION_FIELD_UPDATE,
        tags: TAGS_FIELD_UPDATE,
        slug: SLUG_FIELD_UPDATE,
      },
    },
    async ({ public_id, markdown, expected_version, title, description, tags, slug }) => {
      try {
        const result = await updateDocumentCore(
          env,
          public_id,
          markdown,
          expected_version ?? null,
          props.agentId,
          origin,
          "markdown",
          metadataInputFromArgs(title, description, tags, slug),
        );
        if (!result.ok) {
          return textError(translateUpdateError(result));
        }
        return textOk(JSON.stringify(writeOkResponse(result)));
      } catch (err) {
        console.error("mcp.update_document_markdown.threw", String(err));
        return textError("internal error updating document");
      }
    },
  );

  server.registerTool(
    "edit_document",
    {
      // The small-diff alternative to update_document. Lead with the use case
      // (don't re-send the whole body) and the one rule that makes edits
      // actually land: match against the STORED sanitized bytes, not your
      // original input. The uniqueness/replace_all contract and the
      // expected_version contract come next; metadata is tail-priority.
      description:
        "Change part of an existing document by find-and-replace, WITHOUT re-sending " +
        "the whole body. Send one or more { old_string, new_string } edits; the server " +
        "loads the current version, applies them, and appends a new version. Prefer this " +
        "over update_document when you're changing a small region of a larger doc — a " +
        "tool argument is regenerated token-by-token, so re-transmitting an unchanged " +
        "28 KB body to fix one line is slow and truncation-prone. " +
        "MATCH AGAINST THE STORED BYTES, NOT YOUR INPUT: matching runs against the " +
        "sanitized HTML actually stored (what `read_document` returns), which can differ " +
        "from what you originally published (the sanitizer may have normalized or " +
        "stripped things — `modified: true` on the original write). If unsure what the " +
        "stored bytes look like, call read_document first and copy `old_string` from " +
        "there verbatim. " +
        "UNIQUENESS: each `old_string` must match EXACTLY ONCE, or the edit is rejected " +
        "with `edit_not_unique` and the match count — add surrounding context to make it " +
        "unique, or set `replace_all: true` to replace every occurrence (applies to all " +
        "edits in the call). A zero-match `old_string` is rejected with `edit_no_match` " +
        "(NOT a silent no-op). Multiple edits apply sequentially: each runs against the " +
        "result of the previous, so a later edit can match text an earlier one produced. " +
        "CONCURRENCY: pass `expected_version` (the version number you last saw) for " +
        "optimistic concurrency — `version_conflict` if the doc changed since; omit or " +
        "pass null to clobber (last-write-wins), exactly like update_document. The edit " +
        "is matched against the version actually current at call time. " +
        "Same HTML rules as the other write tools apply to whatever your `new_string` " +
        "introduces (STATIC ONLY, INLINE STYLES, INLINE SVG, no external resources) — " +
        "new content is sanitized like any other write. " +
        "OPTIONAL METADATA (`title`, `description`, `tags`, `slug`) follows the same " +
        "INHERIT-ON-OMIT semantics as update_document (omit to keep prior; \"\"/[] to " +
        "clear; title \"\" re-derives — useful if your edit changed the <h1>). " +
        "RESPONSE: the same shape as update_document (public_id, url, version, " +
        "size_bytes, sanitizer_v, `modified`, `stripped[]`, `will_not_render[]`, resolved " +
        "title/description/tags/slug) PLUS `replacements` — the count of substitutions " +
        "made (≥1 on success). Use `replacements` to confirm your patch landed; " +
        "`modified` only means the sanitizer changed the post-edit HTML and can be true " +
        "from incidental normalization even when your edit was clean, so don't read it " +
        "alone as \"my edit changed something.\" " +
        "MCP-ONLY: there is no `PATCH /d/:id` HTTP equivalent — over HTTP, read the doc, " +
        "apply your edit locally, and PUT the full body with `If-Match`.",
      inputSchema: {
        public_id: z.string().describe("22-char public_id from a prior publish call."),
        edits: z
          .array(
            z.object({
              old_string: z
                .string()
                .describe(
                  "Exact text to find in the STORED sanitized HTML (what read_document " +
                  "returns), not your original input. Must match exactly once unless " +
                  "replace_all is set.",
                ),
              new_string: z
                .string()
                .describe(
                  "Replacement text, inserted verbatim. Must differ from old_string. " +
                  "Any HTML it introduces is sanitized like any other write.",
                ),
            }),
          )
          .min(1)
          .describe(
            "One or more find-and-replace operations, applied in order (each runs " +
            "against the result of the previous).",
          ),
        expected_version: z
          .number()
          .int()
          .min(1)
          .nullable()
          .optional()
          .describe(
            "The version number you believe is current. Omit or pass null to overwrite " +
            "without a version check (clobber).",
          ),
        replace_all: z
          .boolean()
          .optional()
          .describe(
            "When true, every occurrence of each `old_string` is replaced (and a " +
            "multi-match old_string is allowed). Default false: each old_string must " +
            "match exactly once.",
          ),
        title: TITLE_FIELD_UPDATE,
        description: DESCRIPTION_FIELD_UPDATE,
        tags: TAGS_FIELD_UPDATE,
        slug: SLUG_FIELD_UPDATE,
      },
    },
    async ({ public_id, edits, expected_version, replace_all, title, description, tags, slug }) => {
      try {
        const result = await editDocumentCore(
          env,
          public_id,
          edits,
          expected_version ?? null,
          props.agentId,
          origin,
          replace_all ?? false,
          metadataInputFromArgs(title, description, tags, slug),
        );
        if (!result.ok) {
          return textError(translateEditError(result));
        }
        return textOk(JSON.stringify({ ...writeOkResponse(result), replacements: result.replacements }));
      } catch (err) {
        console.error("mcp.edit_document.threw", String(err));
        return textError("internal error editing document");
      }
    },
  );

  server.registerTool(
    "read_document",
    {
      description:
        "Fetch the sanitized HTML of a previously published document. Returns the " +
        "raw bytes (no shell, no iframe wrapper) suitable for further processing. " +
        "For the doc's stored metadata (title / description / tags), use " +
        "read_document_text (Markdown form with metadata in a JSON wrapper) or " +
        "list_documents — read_document intentionally returns only the raw HTML " +
        "bytes so the simple 'give me the body' case stays a single decode.",
      inputSchema: {
        public_id: z.string().describe("22-char public_id."),
      },
    },
    async ({ public_id }) => {
      try {
        const result = await readDocumentCore(env, public_id);
        if (!result.ok) {
          return textError("no such document");
        }
        return textOk(new TextDecoder().decode(result.bytes));
      } catch (err) {
        console.error("mcp.read_document.threw", String(err));
        return textError("internal error reading document");
      }
    },
  );

  server.registerTool(
    "read_document_text",
    {
      // Sibling to read_document for the case where the agent is going to
      // INGEST a doc as context rather than RENDER it. Lead with that use
      // case in the description — the names are similar enough that a cold
      // agent could pick read_document by default. Calling out "no scripts/
      // styles/inline-SVG path data" is the concrete pitch: typical sanitized
      // HTML drops to 20–40% of its size in this form.
      description:
        "Fetch a previously published document as Markdown text — same content " +
        "as read_document, but with HTML structure converted to GFM Markdown and " +
        "all visual/styling overhead removed (inline styles, SVG path data, " +
        "container divs). USE THIS when you want to READ the document as context " +
        "for further reasoning, not when you need the raw HTML to render or " +
        "re-publish. Typical size is 20-40% of the HTML form. Inline SVGs collapse " +
        "to [Image: <alt>] placeholders using <title>/<desc>/aria-label when " +
        "present, so any visual content authored without alt text shows up as a " +
        "bare [Image] marker (consider adding <title> when publishing if the " +
        "image carries meaning). Returns the markdown text plus version, " +
        "sanitizer_v, and converter_v so you can detect when the conversion " +
        "policy has changed between reads, plus the document's stored `title`, " +
        "`description`, `tags`, and `slug` (null/[] if unset).",
      inputSchema: {
        public_id: z.string().describe("22-char public_id."),
      },
    },
    async ({ public_id }) => {
      try {
        const result = await readDocumentTextCore(env, public_id);
        if (!result.ok) {
          return textError("no such document");
        }
        return textOk(
          JSON.stringify({
            text: result.text,
            version: result.version_no,
            sanitizer_v: result.sanitizer_v,
            converter_v: result.converter_v,
            title: result.title,
            description: result.description,
            tags: result.tags,
            slug: result.slug,
          }),
        );
      } catch (err) {
        console.error("mcp.read_document_text.threw", String(err));
        return textError("internal error reading document");
      }
    },
  );

  server.registerTool(
    "list_documents",
    {
      description:
        "List every document this operator's fleet has published, newest first. " +
        "Each row includes public_id, current_ver, created_at/by, current_size, " +
        "revoked_at, plus the current version's `title`, `description`, and `tags` " +
        "(null/[] when unset) and the document's `slug` (null when unset or after " +
        "revocation — revoked docs release their slug for reuse). Includes revoked " +
        "documents (with revoked_at set). v1 is single-tenant — all agents under " +
        "one operator share visibility, matching the cross-agent update semantics. " +
        "For CONTENT discovery (\"find the doc that talks about X\") use " +
        "`search_documents` instead — list_documents is for browsing newest-first " +
        "or for narrow tag/slug filters. " +
        "FILTERS (optional, both apply if both given): `tags` is AND semantics — " +
        "pass `[\"foo\",\"bar\"]` to get only docs that carry BOTH \"foo\" AND " +
        "\"bar\". Tags are silently sanitized to the same [A-Za-z0-9_-] charset " +
        "as write time, so `[\"foo!\"]` filters by `[\"foo\"]`. `slug` is an " +
        "EXACT match against the document slug (returns 0 or 1 docs since slugs " +
        "are unique across live docs) — for the single-doc case prefer " +
        "find_document_by_slug, which returns the row directly without the " +
        "list/pagination envelope. CURSOR-PAGINATED: response includes " +
        "`next_cursor` (string or null). Pass it back unchanged on the next call " +
        "to fetch the next page; `null` means you've reached the end. Filters " +
        "compose with the cursor — a cursor walks the filtered subset in the " +
        "same created_at order. `limit` defaults to 50 and caps at 200.",
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_LIMIT)
          .optional()
          .describe(
            `Optional. Page size, 1..${MAX_LIMIT} (default 50). Smaller pages keep ` +
            "response context cheap when you only need the top of the list.",
          ),
        cursor: z
          .string()
          .optional()
          .describe(
            "Optional. Opaque pagination cursor from a prior response's " +
            "`next_cursor`. Omit on the first call; pass back verbatim to fetch " +
            "the next page. The token encodes the last row's position — do not " +
            "construct or modify it.",
          ),
        tags: z
          .array(z.string())
          .optional()
          .describe(
            "Optional. Tag filter, AND semantics — the response only contains " +
            "documents whose stored tags include EVERY tag in this array. Each " +
            "tag is silently sanitized to [A-Za-z0-9_-] (matching write-time " +
            "rules), so `[\"foo!\"]` becomes `[\"foo\"]`; a filter that " +
            "sanitizes to empty is treated as no filter (returns everything).",
          ),
        slug: z
          .string()
          .optional()
          .describe(
            "Optional. Exact-match filter on the document slug. Returns 0 or 1 " +
            "documents (slug is unique across live docs). Validated with the " +
            "same /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/ rule as the write " +
            "path; invalid input surfaces as a `bad_slug` error. For a clean " +
            "single-row lookup, prefer find_document_by_slug.",
          ),
      },
    },
    async ({ limit, cursor, tags, slug }) => {
      try {
        const parsed = parseMcpListArgs({ limit, cursor, tags, slug });
        if (!parsed.ok) {
          return textError(parsed.message);
        }
        const result = await listDocumentsCore(env, parsed);
        return textOk(JSON.stringify(result));
      } catch (err) {
        console.error("mcp.list_documents.threw", String(err));
        return textError("internal error listing documents");
      }
    },
  );

  server.registerTool(
    "find_document_by_slug",
    {
      // Slug lookup is "the doc, or not_found" — wrapping that in the
      // list_documents envelope (documents[0]?) is awkward enough that a
      // dedicated tool earns its keep. The trade is: agents now have two
      // ways to do roughly the same thing — the description leads with
      // when to pick which.
      description:
        "Look up a single document by its slug. Returns the document row directly " +
        "(NOT inside a `documents` list) — use this when you already have a slug " +
        "and want the matching doc as one object. For pattern/multiple-doc " +
        "discovery, use list_documents with its `slug` or `tags` filters instead. " +
        "Slugs are unique across live documents and are released when a document " +
        "is revoked, so a slug that resolved yesterday may not today (the prior " +
        "doc was revoked) or may resolve to a DIFFERENT document (a fresh publish " +
        "claimed the released slug). When you cache a slug→public_id mapping, " +
        "re-resolve before assuming it still points where you expect. Returns the " +
        "same row shape as list_documents entries: public_id, url-shaped " +
        "fields, current_ver, created_at/by, current_size, revoked_at (always " +
        "null here — revoked docs have no slug to find), title, description, " +
        "tags, slug. ERRORS: `not_found` if no live document carries that slug " +
        "(or the slug shape is invalid).",
      inputSchema: {
        slug: z
          .string()
          .describe(
            "The slug to look up. Same charset as write time: lowercase URL-safe, " +
            "1-64 chars, must start and end with a letter or digit " +
            "(/^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/). Invalid input returns " +
            "`not_found` rather than a validation error — for a lookup, bad input " +
            "and missing doc collapse to the same answer: nothing resolved.",
          ),
      },
    },
    async ({ slug }) => {
      try {
        // Validate at the tool boundary to short-circuit the DB read on
        // obvious junk. validateSlugInput also lowercases/trims, so we
        // pass the validated form down to core (matches what the slug
        // filter on list_documents does).
        const v = validateSlugInput(slug);
        if (!v.ok) return textError("no such document");
        const result = await findDocumentBySlugCore(env, v.slug);
        if (!result.ok) return textError("no such document");
        return textOk(JSON.stringify(result.document));
      } catch (err) {
        console.error("mcp.find_document_by_slug.threw", String(err));
        return textError("internal error looking up document");
      }
    },
  );

  server.registerTool(
    "search_documents",
    {
      // Lead with the use-case distinction from list_documents — the names
      // are similar enough that a cold agent could pick either by default.
      // The "what scoring means" line is right at the top because it's the
      // single most surprising response field for someone used to plain
      // list endpoints.
      description:
        "Find documents by content. Returns hits ranked by relevance " +
        "(BM25 over title, description, tags, and body — title weighted " +
        "highest). USE THIS when you know roughly WHAT a document says and " +
        "want to find it; use list_documents (with optional tag/slug " +
        "filters) for newest-first browsing. " +
        "Each hit is the same row shape as list_documents entries — " +
        "public_id, current_ver, created_at/by, current_size, revoked_at, " +
        "title, description, tags, slug — plus: `score` (positive float; " +
        "BIGGER = better match, since we negate FTS5's native lower-is-" +
        "better convention); `matched_field` (\"title\" | \"description\" | " +
        "\"tags\" | \"body\" — which column matched, useful for deciding " +
        "whether a hit is metadata-substantive vs only a body mention; on " +
        "multi-column matches the priority is title > description > tags > " +
        "body, mirroring BM25 weights); and `snippet` (a short excerpt of " +
        "the matched column with [bracketed] match terms). " +
        "QUERY SYNTAX: space-separated terms, all 2+ chars (one-letter " +
        "terms are dropped — they'd match almost everything). Implicit AND " +
        "across terms. Trailing `*` for prefix match (`publi*` matches " +
        "publish/publication). Diacritics are folded (naive matches naïve). " +
        "Stemming is light-English (publishing/published/publishes collapse). " +
        "PREFIX-VS-STEMMING GOTCHA: prefix matches run against the stemmed " +
        "form — `engin*` matches \"engineering\" but `enginee*` does not " +
        "(the stored stem is shorter than your prefix). Use SHORT prefixes; " +
        "for plurals/inflections, rely on stemming and search the bare word. " +
        "Phrase queries, OR/NOT/NEAR operators, and column:term filters are " +
        "NOT supported in v1 — quotes, parens, and operators are silently " +
        "stripped from the input. Lowercase your terms (or don't — the " +
        "tokenizer folds case either way). " +
        "FILTERS: `tags` (AND semantics, same shape as list_documents) and " +
        "`slug` (exact match) compose with the query — \"search for X " +
        "within tag Y\" is one call. Revoked documents are excluded from " +
        "search results entirely (they're removed from the search index at " +
        "revoke time, not just hidden). " +
        "PAGINATION: capped at `limit` (default 50, max 200). No " +
        "`next_cursor` — BM25 rank isn't a stable cursor key. If the top " +
        "200 results don't include what you want, refine the query. " +
        "ERRORS: `bad_query` if the input tokenizes to empty (e.g. only " +
        "punctuation, or only one-letter words). " +
        "RESPONSE: `{ documents: [...hits] }` — note no `next_cursor` " +
        "field, unlike list_documents.",
      inputSchema: {
        q: z
          .string()
          .describe(
            "The search query. Word-based: space-separated terms, 2+ chars " +
            "each, AND-joined. Trailing `*` for prefix match. Diacritics " +
            "and case are folded by the tokenizer. Phrase queries and " +
            "Boolean operators are not supported — they're silently dropped.",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_LIMIT)
          .optional()
          .describe(
            `Optional. Cap on result count, 1..${MAX_LIMIT} (default 50). ` +
            "There's no cursor for search — refine the query if you want " +
            "results beyond the top N.",
          ),
        tags: z
          .array(z.string())
          .optional()
          .describe(
            "Optional. AND-style tag filter, same semantics as list_documents. " +
            "Composes with the query: results must MATCH the query AND " +
            "carry every tag in this array.",
          ),
        slug: z
          .string()
          .optional()
          .describe(
            "Optional. Exact-slug filter. Composes with the query to " +
            "scope a search to a single document (mostly useful as a " +
            "sanity check that a specific doc would surface for the query).",
          ),
      },
    },
    async ({ q, limit, tags, slug }) => {
      try {
        // `cursor` is intentionally not in the input schema — search has
        // no cursor model. The filter parser still runs to validate
        // tags/slug/limit; we ignore its `cursor` field.
        const parsed = parseMcpListArgs({ limit, tags, slug });
        if (!parsed.ok) {
          return textError(parsed.message);
        }
        const match = buildFtsMatchQuery(q);
        if (!match) {
          return textError(
            "no usable search terms (queries need at least one 2+ character word; " +
            "operators and punctuation are dropped)",
          );
        }
        const result = await searchDocumentsCore(env, match, parsed);
        if (!result.ok) {
          // searchDocumentsCore only emits bad_query, which we already
          // ruled out via buildFtsMatchQuery — defensive branch.
          return textError("bad query");
        }
        return textOk(JSON.stringify({ documents: result.documents }));
      } catch (err) {
        console.error("mcp.search_documents.threw", String(err));
        return textError("internal error searching documents");
      }
    },
  );

  server.registerTool(
    "create_publish_credential",
    {
      // A credential-disclosure tool — deliberately narrow. Lead with WHEN to
      // reach for it so an agent doesn't grab a secret reflexively: it exists
      // ONLY for byte-exact publishing of a large file you already have on
      // disk, from an environment with a shell. Normal publishing (content
      // you're authoring fresh, or anything small) should use
      // publish_document / update_document directly — those need no credential.
      description:
        "Mint a SHORT-LIVED API key for the byte-exact HTTP publish path. Use this " +
        "ONLY when you already have the document as a file on disk AND you have a shell: " +
        "the returned key lets you run `curl --data-binary @file` against POST /d (or " +
        "PUT /d/:id) so the file streams from disk verbatim, instead of regenerating it " +
        "token-by-token as the `html` argument of publish_document (slow and " +
        "truncation-prone for large bodies). For content you're authoring fresh, or any " +
        "small document, just call publish_document / update_document directly — you do " +
        "NOT need this. " +
        "The key is a normal `awh_` bearer tied to your agent identity, valid for a " +
        "short window (default " + String(EPHEMERAL_KEY_DEFAULT_TTL_SECONDS) + "s, max " +
        String(EPHEMERAL_KEY_MAX_TTL_SECONDS) + "s) and then auto-rejected. It grants " +
        "nothing beyond what this MCP session already can do — it just makes those " +
        "powers usable from curl — but it IS a secret: use it only for the curl call, " +
        "never print it back to the user or store it, and mint a fresh one when it " +
        "expires. " +
        "Returns `{ key, key_id, expires_at, host, publish_endpoint, update_endpoint, " +
        "recipe }` — `recipe` is a ready-to-run curl command (fill in the filename) that " +
        "includes the optional `X-Content-SHA256` integrity check (server rejects a " +
        "truncated upload with 422 instead of storing partial bytes). See " +
        "awh://publishing-guide for the full byte-exact-publishing section.",
      inputSchema: {
        // No .min()/.max() here on purpose: mintEphemeralKey clamps to
        // [MIN, MAX], so the contract is "out-of-range is clamped, not
        // rejected" — enforcing bounds in zod too would turn a too-large ask
        // into a confusing validation error instead of a 60-min key.
        ttl_seconds: z
          .number()
          .int()
          .optional()
          .describe(
            `Optional. Requested lifetime in seconds, ${EPHEMERAL_KEY_MIN_TTL_SECONDS}..` +
            `${EPHEMERAL_KEY_MAX_TTL_SECONDS} (default ${EPHEMERAL_KEY_DEFAULT_TTL_SECONDS}). ` +
            "Pick enough to finish your uploads; the key auto-expires after. Out-of-range " +
            "values are clamped, not rejected.",
          ),
      },
    },
    async ({ ttl_seconds }) => {
      try {
        const result = await mintEphemeralKey(
          env,
          props.agentId,
          ttl_seconds ?? EPHEMERAL_KEY_DEFAULT_TTL_SECONDS,
        );
        if (!result.ok) {
          // Only failure mode is `misconfigured` (HMAC_PEPPER unset). No
          // secret to leak here; report generically per logging discipline.
          console.error("mcp.create_publish_credential.error", result.code);
          return textError("server is misconfigured and cannot mint credentials right now");
        }
        // The recipe interpolates the freshly-minted key. This whole response
        // is the deliberate disclosure surface — never log it (see the
        // logging-discipline note at the top of this file).
        const recipe =
          `curl -X POST ${origin}/d ` +
          `-H "Authorization: Bearer ${result.key}" ` +
          `-H "Content-Type: text/html" ` +
          `-H "X-Content-SHA256: $(sha256sum file.html | cut -d' ' -f1)" ` +
          `--data-binary @file.html`;
        return textOk(
          JSON.stringify({
            key: result.key,
            key_id: result.keyId,
            expires_at: result.expiresAt,
            host: origin,
            publish_endpoint: `${origin}/d`,
            update_endpoint: `${origin}/d/<public_id>`,
            recipe,
            note:
              "Short-lived secret for the byte-exact curl publish path. Use it as the " +
              "Bearer on POST /d (publish) or PUT /d/:id (update, also needs If-Match) " +
              "with `curl --data-binary @file`. Do NOT print it to the user or store it; " +
              "mint a fresh one when it expires. The operator can revoke it early via " +
              "DELETE /admin/keys/:id using the key_id above.",
          }),
        );
      } catch (err) {
        console.error("mcp.create_publish_credential.threw", String(err));
        return textError("internal error minting credential");
      }
    },
  );

  // Mount on /mcp. `authContext` carries `props` to anything in the SDK
  // that calls getMcpAuthContext() — our tool handlers don't need it
  // (closure-captured above), but we set it for consistency.
  const handler = createMcpHandler(server, {
    route: "/mcp",
    authContext: { props: props as unknown as Record<string, unknown> },
  });

  const response = await handler(request, env, ctx);

  // /mcp is JSON-RPC over HTTP; never cache responses.
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// -- helpers ------------------------------------------------------------------

type ToolText = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function textOk(text: string): ToolText {
  return { content: [{ type: "text", text }] };
}

function textError(text: string): ToolText {
  return { content: [{ type: "text", text }], isError: true };
}

// -- shared schema fields for optional metadata -------------------------------
// Defined once so all four write tools carry identical descriptions; keeping
// the publish/update wording subtly different (derive vs inherit semantics)
// is the only reason there are two variants.

const TITLE_FIELD = z
  .string()
  .optional()
  .describe(
    "Optional. Document title (≤300 chars). Omit to auto-derive from the first " +
    "<h1> (or the doc's first ~80 chars of text). Surfaces in the browser tab as " +
    "`{title} | Slopcafe` and powers social link previews with anti-phishing " +
    "normalization at render time.",
  );

const DESCRIPTION_FIELD = z
  .string()
  .optional()
  .describe(
    "Optional. Short description (≤500 chars) primarily for other agents that " +
    "read this doc as context. Renders as <meta name=description> and powers " +
    "social link previews with anti-phishing normalization at render time.",
  );

const TAGS_FIELD = z
  .array(z.string())
  .optional()
  .describe(
    "Optional. Array of short tag strings. Charset restricted to [A-Za-z0-9_-] — " +
    "any other characters are silently stripped. Max 10 tags; each ≤32 chars; " +
    "dedupe is case-sensitive.",
  );

const TITLE_FIELD_UPDATE = z
  .string()
  .optional()
  .describe(
    "Optional. INHERITS the prior version's title when omitted (most updates). " +
    "Pass an explicit string to override (≤300 chars), or an empty string \"\" to " +
    "re-derive from the new content's first <h1>. Surfaces in the browser tab and " +
    "powers social link previews.",
  );

const DESCRIPTION_FIELD_UPDATE = z
  .string()
  .optional()
  .describe(
    "Optional. INHERITS the prior version's description when omitted. Pass an " +
    "explicit string to override (≤500 chars), or an empty string \"\" to clear " +
    "(stored as null). Powers social link previews.",
  );

const TAGS_FIELD_UPDATE = z
  .array(z.string())
  .optional()
  .describe(
    "Optional. INHERITS the prior version's tags when omitted. Pass an explicit " +
    "array to override (same charset / size rules as publish_document), or an " +
    "empty array [] to clear.",
  );

const SLUG_FIELD = z
  .string()
  .optional()
  .describe(
    "Optional, and most documents should OMIT it. A unique, human/agent-typeable " +
    "handle. Lowercase URL-safe charset only (/^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/) " +
    "— 1-64 chars, must start + end with a letter or digit. Uniqueness is enforced " +
    "across live documents; a collision → `slug_taken` error. Released (available " +
    "again) when the document is revoked. UNLIKE `public_id` (the unguessable " +
    "capability URL), a slug is PUBLICLY RESOLVABLE: anyone can hit `GET /s/<slug>` " +
    "(302 → the document, no auth), so a guessable slug is a deliberate, WEAKER " +
    "capability. Opt into it only when the document is meant to be found by name or " +
    "LINKED TO from another document — for cross-referencing, author " +
    "`<a href=\"/s/<slug>\">` to the target's slug and it resolves at click/read time " +
    "(needs neither document's public_id, so two docs can link to each other in any " +
    "order). A document you only share by its public_id URL should have NO slug.",
  );

const SLUG_FIELD_UPDATE = z
  .string()
  .optional()
  .describe(
    "Optional. INHERITS the document's current slug when omitted (typical for " +
    "content-only updates). Pass an explicit string to atomically release the " +
    "old slug and claim a new one (same charset rules as publish_document), or " +
    "an empty string \"\" to release the slug (documents.slug becomes null and the " +
    "value is freed for reuse). A slug equal to the current one is a no-op.",
  );

/**
 * Build the DocumentMetadataInput core expects from the four optional tool
 * args. Distinguishes "field absent from the JSON-RPC args" (undefined =
 * inherit / default) from "field present with empty value" ("" / [] =
 * clear / re-derive), which the inheritance contract relies on.
 */
function metadataInputFromArgs(
  title: string | undefined,
  description: string | undefined,
  tags: string[] | undefined,
  slug: string | undefined,
): DocumentMetadataInput {
  const opts: DocumentMetadataInput = {};
  if (title !== undefined) opts.title = title;
  if (description !== undefined) opts.description = description;
  if (tags !== undefined) opts.tags = tags;
  if (slug !== undefined) opts.slug = slug;
  return opts;
}

/**
 * Serialize a successful WriteOk result for an MCP tool response. Same shape
 * as the HTTP wrapper in src/index.ts so an agent moving between transports
 * gets identical fields.
 */
function writeOkResponse(result: Awaited<ReturnType<typeof publishDocumentCore>>) {
  if (!result.ok) throw new Error("writeOkResponse requires an ok result");
  return {
    public_id: result.public_id,
    url: result.url,
    version: result.version,
    size_bytes: result.size_bytes,
    sanitizer_v: result.sanitizer_v,
    modified: result.modified,
    stripped: result.stripped,
    will_not_render: result.will_not_render,
    title: result.title,
    description: result.description,
    tags: result.tags,
    slug: result.slug,
  };
}

/**
 * Map a publishDocumentCore failure into model-readable text. See
 * skills/connector-guide.md "Error mapping" for the canonical translations.
 */
function translatePublishError(
  err: Extract<Awaited<ReturnType<typeof publishDocumentCore>>, { ok: false }>,
): string {
  switch (err.code) {
    case "empty_body":
      return "connector bug: empty html argument";
    case "too_large":
      return `document too large: ${err.size} bytes exceeds limit of ${err.limit}`;
    case "storage_cap_exceeded":
      return `fleet storage cap exceeded: ${err.used}/${err.cap} bytes used, this write would add ${err.this_write}`;
    case "invalid_slug":
      return `invalid slug: ${slugReasonText(err.reason)}`;
    case "slug_taken":
      return `slug "${err.slug}" is already in use by another live document; choose a different slug or wait until the other is revoked`;
  }
}

function translateUpdateError(
  err: Extract<Awaited<ReturnType<typeof updateDocumentCore>>, { ok: false }>,
): string {
  switch (err.code) {
    case "not_found":
      return "no such document";
    case "version_conflict":
      return `version conflict, current is v${err.current_version} (you sent v${err.expected}); refetch and retry`;
    case "empty_body":
      return "connector bug: empty html argument";
    case "too_large":
      return `document too large: ${err.size} bytes exceeds limit of ${err.limit}`;
    case "storage_cap_exceeded":
      return `fleet storage cap exceeded: ${err.used}/${err.cap} bytes used, this write would add ${err.this_write}`;
    case "invalid_slug":
      return `invalid slug: ${slugReasonText(err.reason)}`;
    case "slug_taken":
      return `slug "${err.slug}" is already in use by another live document; choose a different slug or wait until the other is revoked`;
  }
}

/**
 * Map an editDocumentCore failure into model-readable text. Covers the
 * find/replace-specific codes plus every update failure (the edit delegates
 * its write to updateDocumentCore). The edit-specific messages echo the
 * agent's own `old_string` back (truncated) to help it self-correct — that's
 * the agent's own input returned to it, not a logged secret.
 */
function translateEditError(
  err: Extract<Awaited<ReturnType<typeof editDocumentCore>>, { ok: false }>,
): string {
  switch (err.code) {
    case "no_edits":
      return "no edits provided: pass at least one { old_string, new_string }";
    case "empty_old_string":
      return `edit ${err.edit_index + 1}: old_string is empty — provide the exact text to find`;
    case "noop_edit":
      return `edit ${err.edit_index + 1}: old_string and new_string are identical — nothing to change`;
    case "edit_no_match":
      return (
        `edit ${err.edit_index + 1}: old_string not found in the stored document. ` +
        "Match against the CURRENT stored HTML (read_document), not your original " +
        "input — the sanitizer may have changed it. " +
        `Looking for: "${previewEditString(err.old_string)}"`
      );
    case "edit_not_unique":
      return (
        `edit ${err.edit_index + 1}: old_string matches ${err.count} times; make it ` +
        "unique by adding surrounding context, or pass replace_all: true to replace " +
        "every occurrence"
      );
    case "not_found":
      return "no such document";
    case "version_conflict":
      return `version conflict, current is v${err.current_version} (you sent v${err.expected}); refetch and retry`;
    case "empty_body":
      return "the edit would leave the document empty";
    case "too_large":
      return `document too large after edit: ${err.size} bytes exceeds limit of ${err.limit}`;
    case "storage_cap_exceeded":
      return `fleet storage cap exceeded: ${err.used}/${err.cap} bytes used, this write would add ${err.this_write}`;
    case "invalid_slug":
      return `invalid slug: ${slugReasonText(err.reason)}`;
    case "slug_taken":
      return `slug "${err.slug}" is already in use by another live document; choose a different slug or wait until the other is revoked`;
  }
}

/**
 * Collapse + truncate an `old_string` for an error message so a multi-line or
 * very long find target doesn't dominate the response. Whitespace is flattened
 * to single spaces for readability; the agent has the original.
 */
function previewEditString(s: string): string {
  const MAX = 80;
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= MAX ? flat : `${flat.slice(0, MAX)}…`;
}

/**
 * Map a SlugReject code to a one-line agent-readable message. Mirrors
 * formatSlugReject in src/index.ts so both transports surface the same
 * rule wording when the validator rejects an input.
 */
function slugReasonText(reason: import("./metadata.js").SlugReject): string {
  switch (reason) {
    case "empty":
      return "must be non-empty (pass \"\" to release an existing slug)";
    case "too_long":
      return "exceeds 64 characters";
    case "bad_charset":
      return "may only contain lowercase letters, digits, '-', '_'";
    case "must_start_alnum":
      return "must start with a lowercase letter or digit";
    case "must_end_alnum":
      return "must end with a lowercase letter or digit";
  }
}
