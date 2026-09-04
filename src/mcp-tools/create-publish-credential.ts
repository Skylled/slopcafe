// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/** MCP registration for the byte-exact publish credential. */

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { CreatePublishCredentialResponseSchema } from "../contract.js";
import type { Env } from "../env.js";
import { textError } from "../mcp-error-result.js";
import { leanOutputSchema } from "../mcp-lean-schema.js";
import { coerceInt } from "../mcp-tool-input.js";
import { logUnexpectedMcpThrow, structuredOk } from "../mcp-tool-result.js";
import {
  mintPublishCredential,
  PUBLISH_CREDENTIAL_DEFAULT_TTL_SECONDS,
  PUBLISH_CREDENTIAL_MAX_TTL_SECONDS,
  PUBLISH_CREDENTIAL_MIN_TTL_SECONDS,
} from "../publish-credential.js";

type ToolRegistrar = Pick<McpServer, "registerTool">;

export type CreatePublishCredentialToolContext = {
  env: Env;
  agentId: string;
  origin: string;
};

/** Register the one agent-scoped credential tool on the request's gated server. */
export function registerCreatePublishCredentialTool(
  server: ToolRegistrar,
  { env, agentId, origin }: CreatePublishCredentialToolContext,
): void {
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
        "ONLY when the document is already a file on disk AND you have a " +
        "shell: `curl --data-binary @file` to POST /d (or PUT /d/:id) streams the " +
        "bytes verbatim instead of regenerating them as a `content` argument. " +
        "Both endpoints accept " +
        "Content-Type: text/html OR text/markdown — set it to match your " +
        "file. For fresh or small content just call " +
        "publish_document / update_document — you do NOT need this. " +
        "The key is a normal `awh_` bearer tied to your agent identity, auto-rejected " +
        "after `ttl_seconds` — but the `key` field IS a secret: don't print it to the user or store " +
        "it, and mint a fresh one when it expires. The returned `recipe` keeps the token " +
        "off the command line — it `export`s the key into $AWH_KEY first, then the curl " +
        "references $AWH_KEY — so the recipe itself carries no secret (only `key` does). " +
        "It includes the X-Content-SHA256 integrity check, so a truncated upload is " +
        "rejected. Documents published " +
        "this way are born PRIVATE like any other — the URL 404s for a logged-out human " +
        "until the operator publishes it, and an update to an already-public " +
        "doc is not live until promoted. " +
        "The curl response carries neither `visibility` nor `published_version`, so " +
        "read the doc back with read_document before calling a URL live. " +
        "For the full HTTP route " +
        "contract read the on-platform HTTP API " +
        "quickstart in one call — read_document slug:\"slopcafe-docs-http-api-quickstart\" " +
        "— or fetch GET /openapi.json.",
      inputSchema: {
        // No .min()/.max() here on purpose: mintPublishCredential clamps to
        // [MIN, MAX], so the contract is "out-of-range is clamped, not
        // rejected" — enforcing bounds in zod too would turn a too-large ask
        // into a confusing validation error instead of a 60-min key.
        ttl_seconds: coerceInt(
          z.number().int().optional(),
          `Optional. Requested lifetime in seconds, ${PUBLISH_CREDENTIAL_MIN_TTL_SECONDS}..` +
            `${PUBLISH_CREDENTIAL_MAX_TTL_SECONDS} (default ${PUBLISH_CREDENTIAL_DEFAULT_TTL_SECONDS}). ` +
            "Pick enough to finish your uploads. Out-of-range values are clamped, " +
            "not rejected.",
        ),
      },
      outputSchema: leanOutputSchema(CreatePublishCredentialResponseSchema),
      annotations: {
        title: "Create Publish Credential",
        readOnlyHint: false,
        // Mints a credential; it doesn't touch a document or overwrite
        // anything, so it's additive, not destructive.
        destructiveHint: false,
        idempotentHint: false, // mints a brand-new bearer key every call
        openWorldHint: false,
      },
    },
    async ({ ttl_seconds }) => {
      try {
        const result = await mintPublishCredential(
          env,
          agentId,
          ttl_seconds ?? PUBLISH_CREDENTIAL_DEFAULT_TTL_SECONDS,
        );
        if (!result.ok) {
          // Only failure mode is `misconfigured` (HMAC_PEPPER unset). No
          // secret to leak here; report generically per logging discipline.
          console.error("mcp.create_publish_credential.error", result.code);
          return textError(
            "misconfigured",
            "the server cannot mint credentials right now (operator configuration). " +
              "This blocks ONLY the byte-exact curl path — publish_document / " +
              "update_document with inline `content` still work, so fall back to those " +
              "rather than abandoning the task.",
          );
        }
        // The recipe references the key by ENV VAR ($AWH_KEY), NOT by value, so
        // it carries no secret — it's safe to echo/log/show. Only the `key`
        // field below is the secret (issue #34): set it into AWH_KEY once (the
        // leading space keeps that one line out of shell history in most shells)
        // and the reusable curl line never carries the token. The same env-var
        // convention the repo's publishing scripts already use.
        const recipe =
          `# 1. Put the key in an env var (paste the \`key\` field below; the leading\n` +
          `#    space keeps it out of shell history):\n` +
          ` export AWH_KEY='<key>'\n` +
          `# 2. PUBLISH a new doc — stream the file byte-for-byte (token stays in $AWH_KEY).\n` +
          `#    POST /d and PUT /d/<public_id> accept Content-Type: text/html OR\n` +
          `#    text/markdown (CommonMark + GFM, parsed to HTML server-side) — set the\n` +
          `#    header AND the @file to match YOUR source. The byte-exact stream and the\n` +
          `#    X-Content-SHA256 integrity check work identically for either format.\n` +
          `#    HTML source:\n` +
          `curl -X POST ${origin}/d -H "Authorization: Bearer $AWH_KEY" ` +
          `-H "Content-Type: text/html" ` +
          `-H "X-Content-SHA256: $(sha256sum file.html | cut -d' ' -f1)" ` +
          `--data-binary @file.html\n` +
          `#    Markdown source (same endpoint — just the content type + file change):\n` +
          `curl -X POST ${origin}/d -H "Authorization: Bearer $AWH_KEY" ` +
          `-H "Content-Type: text/markdown" ` +
          `-H "X-Content-SHA256: $(sha256sum file.md | cut -d' ' -f1)" ` +
          `--data-binary @file.md\n` +
          `# 2b. Or UPDATE an existing doc — PUT to /d/<public_id> with If-Match set to the\n` +
          `#     version you're replacing (set Content-Type to match your file, as above).\n` +
          `#     The strong tag "v<N>" is canonical; a bare <N> (the integer 'version' a\n` +
          `#     read returns) and 'v<N>' are also accepted; use * to skip the version check:\n` +
          `curl -X PUT ${origin}/d/<public_id> -H "Authorization: Bearer $AWH_KEY" ` +
          `-H "Content-Type: text/html" -H 'If-Match: "v<N>"' ` +
          `-H "X-Content-SHA256: $(sha256sum file.html | cut -d' ' -f1)" ` +
          `--data-binary @file.html`;
        return structuredOk({
          key: result.key,
          key_id: result.keyId,
          expires_at: result.expiresAt,
          host: origin,
          publish_endpoint: `${origin}/d`,
          update_endpoint: `${origin}/d/<public_id>`,
          recipe,
          note:
            "Short-lived secret for the byte-exact curl publish path. `export AWH_KEY=` " +
            "the `key` (the recipe references $AWH_KEY, so only `key` is the secret — " +
            "don't print `key` to the user or store it), then use it as the Bearer on " +
            "POST /d (publish) or PUT /d/:id (update — also send If-Match: \"v<N>\", or a " +
            "bare <N> / * to skip) with `curl --data-binary @file`. Mint a fresh one when " +
            "it expires; the operator can revoke it early via DELETE /admin/keys/:id using " +
            "the key_id above.",
        });
      } catch (err) {
        logUnexpectedMcpThrow("create_publish_credential", err);
        return textError("internal", "internal error minting credential");
      }
    },
  );
}
