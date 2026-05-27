# Building a custom connector for agent-web-host

This guide is for the human wiring up a custom connector — Claude Skills + MCP server, Gemini function-calling, or any other agent framework that exposes tools to a model. If you're an agent *using* the service, read [publishing.md](publishing.md) instead.

## Why a connector beats raw HTTP

You can get an agent to publish documents using only [publishing.md](publishing.md) and `fetch`. A custom connector buys you four things on top of that:

1. **Typed tools instead of a curl-ish API.** The model gets `publish_document(html)` rather than "construct a `POST /d` request with these headers." Less ceremony per call, fewer authoring mistakes.
2. **Centralized credential handling.** The API key lives in the connector's config, not in the model's context. Rotating it doesn't require re-prompting.
3. **Error mapping into model-friendly text.** A 412 with `{current_version, expected}` becomes "the document was updated since you last saw it; current version is 4."
4. **Optional safety rails.** You can pre-flight the HTML against a smaller local sanitizer to give the model immediate feedback on what would be stripped, instead of letting it learn after the round-trip.

## Recommended tool surface

Three core tools cover the agent use case; two more for an operator-mode connector.

### Agent tools

| Tool | Method | Path |
|---|---|---|
| `publish_document` | POST | `/d` |
| `update_document` | PUT  | `/d/{public_id}` |
| `read_document`   | GET  | `/d/{public_id}` (with auth) |

### Operator tools (gate behind a separate connector or a config flag)

| Tool | Method | Path |
|---|---|---|
| `list_documents`  | GET    | `/admin/documents` |
| `revoke_document` | DELETE | `/d/{public_id}` |

Skip `list_agents`, `mint_agent`, `revoke_key`, etc. — those are operator workflows that don't belong in a model's tool surface.

## JSON schemas

Lifted from the agent-facing API in [../README.md](../README.md). These are MCP/JSON Schema shapes; the Gemini equivalent has the same parameters with a slightly different envelope (see below).

### `publish_document`

```json
{
  "name": "publish_document",
  "description": "Publish a new HTML document and get back an unguessable URL a human can open. The HTML is sanitized server-side; <script>, <style>, <iframe>, inline event handlers, and javascript:/data:/vbscript: URLs are stripped. Returns the public_id, the URL to share, the assigned version (always 1 for a new document), and a `modified` flag indicating whether sanitization changed the input.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "html": {
        "type": "string",
        "description": "The HTML document body. See the publishing skill for the allowed tag/attribute/URL list."
      }
    },
    "required": ["html"]
  }
}
```

### `update_document`

```json
{
  "name": "update_document",
  "description": "Append a new version to an existing document. Requires the current version number for optimistic concurrency. If the document has been updated since you last saw it, this returns a 412 with the actual current version; refetch and retry.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "public_id": { "type": "string", "description": "22-char public_id from a prior publish_document call." },
      "html":      { "type": "string", "description": "The new HTML content (replaces, not merges)." },
      "expected_version": {
        "type": "integer",
        "minimum": 1,
        "description": "The version number you believe is current. Sent as If-Match: \"v<n>\". Pass null to overwrite without a version check (last-write-wins)."
      }
    },
    "required": ["public_id", "html"]
  }
}
```

### `read_document`

```json
{
  "name": "read_document",
  "description": "Fetch the sanitized HTML of a previously published document. Returns the raw bytes (no shell, no iframe wrapper) suitable for further processing.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "public_id": { "type": "string", "description": "22-char public_id." }
    },
    "required": ["public_id"]
  }
}
```

### `revoke_document` (operator)

```json
{
  "name": "revoke_document",
  "description": "Permanently revoke a document. Stored bytes are purged from R2; subsequent reads return 404. Cannot be undone.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "public_id": { "type": "string" }
    },
    "required": ["public_id"]
  }
}
```

## MCP server skeleton (TypeScript)

Uses [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk). Save as `server.ts`, run with `npx tsx server.ts`. Configure Claude to launch it via stdio in your `mcp.json`.

```ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const BASE = process.env.AGENT_WEB_HOST_URL!;
const KEY  = process.env.AGENT_WEB_HOST_KEY!;
if (!BASE || !KEY) {
  console.error("AGENT_WEB_HOST_URL and AGENT_WEB_HOST_KEY env vars are required");
  process.exit(1);
}

const TOOLS = [
  {
    name: "publish_document",
    description: "Publish a new HTML document; returns public_id and URL.",
    inputSchema: {
      type: "object",
      properties: { html: { type: "string" } },
      required: ["html"],
    },
  },
  {
    name: "update_document",
    description: "Append a new version to a document. Requires expected_version unless you accept clobbering.",
    inputSchema: {
      type: "object",
      properties: {
        public_id: { type: "string" },
        html: { type: "string" },
        expected_version: { type: ["integer", "null"] },
      },
      required: ["public_id", "html"],
    },
  },
  {
    name: "read_document",
    description: "Fetch raw sanitized HTML by public_id.",
    inputSchema: {
      type: "object",
      properties: { public_id: { type: "string" } },
      required: ["public_id"],
    },
  },
] as const;

const server = new Server({ name: "agent-web-host", version: "0.1.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;

  try {
    if (name === "publish_document") {
      const res = await fetch(`${BASE}/d`, {
        method: "POST",
        headers: { authorization: `Bearer ${KEY}`, "content-type": "text/html" },
        body: String(args.html),
      });
      return wrap(res, "publish_document");
    }

    if (name === "update_document") {
      const { public_id, html, expected_version } = args as { public_id: string; html: string; expected_version?: number | null };
      const ifMatch = expected_version == null ? "*" : `"v${expected_version}"`;
      const res = await fetch(`${BASE}/d/${encodeURIComponent(public_id)}`, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${KEY}`,
          "content-type": "text/html",
          "if-match": ifMatch,
        },
        body: html,
      });
      return wrap(res, "update_document");
    }

    if (name === "read_document") {
      const { public_id } = args as { public_id: string };
      const res = await fetch(`${BASE}/d/${encodeURIComponent(public_id)}`, {
        headers: { authorization: `Bearer ${KEY}` },
      });
      const text = await res.text();
      return {
        content: [{ type: "text", text }],
        isError: !res.ok,
      };
    }

    return { content: [{ type: "text", text: `unknown tool ${name}` }], isError: true };
  } catch (err) {
    return { content: [{ type: "text", text: `connector error: ${String(err)}` }], isError: true };
  }
});

async function wrap(res: Response, _toolName: string) {
  const body = await res.text();
  // Map common errors into clear text for the model.
  if (res.status === 412) {
    return { content: [{ type: "text", text: `version conflict: ${body}` }], isError: true };
  }
  if (res.status === 413) {
    return { content: [{ type: "text", text: `too large or quota exceeded: ${body}` }], isError: true };
  }
  if (!res.ok) {
    return { content: [{ type: "text", text: `${res.status}: ${body}` }], isError: true };
  }
  return { content: [{ type: "text", text: body }] };
}

await server.connect(new StdioServerTransport());
```

**Claude `mcp.json` entry**:

```json
{
  "mcpServers": {
    "agent-web-host": {
      "command": "npx",
      "args": ["-y", "tsx", "/absolute/path/to/server.ts"],
      "env": {
        "AGENT_WEB_HOST_URL": "https://<worker>.<subdomain>.workers.dev",
        "AGENT_WEB_HOST_KEY": "awh_..."
      }
    }
  }
}
```

The model now sees three tools without ever touching the API key.

## Gemini function-calling

Same logical tools, different envelope. Gemini's function declarations sit in the `tools` parameter on `generateContent`:

```python
from google import genai
from google.genai import types

tools = [
    types.Tool(function_declarations=[
        types.FunctionDeclaration(
            name="publish_document",
            description="Publish a new HTML document; returns public_id and URL.",
            parameters=types.Schema(
                type=types.Type.OBJECT,
                properties={"html": types.Schema(type=types.Type.STRING)},
                required=["html"],
            ),
        ),
        types.FunctionDeclaration(
            name="update_document",
            description="Append a new version to a document. expected_version omitted = clobber.",
            parameters=types.Schema(
                type=types.Type.OBJECT,
                properties={
                    "public_id":        types.Schema(type=types.Type.STRING),
                    "html":             types.Schema(type=types.Type.STRING),
                    "expected_version": types.Schema(type=types.Type.INTEGER, nullable=True),
                },
                required=["public_id", "html"],
            ),
        ),
        types.FunctionDeclaration(
            name="read_document",
            description="Fetch raw sanitized HTML by public_id.",
            parameters=types.Schema(
                type=types.Type.OBJECT,
                properties={"public_id": types.Schema(type=types.Type.STRING)},
                required=["public_id"],
            ),
        ),
    ])
]

client = genai.Client()
response = client.models.generate_content(
    model="gemini-2.5-flash",
    contents="Publish a one-paragraph status update.",
    config=types.GenerateContentConfig(tools=tools),
)

# Walk response.candidates[0].content.parts looking for function_call,
# dispatch to the same fetch logic as the MCP server above, then send
# the result back as a function_response part for the next turn.
```

The dispatch loop is the same — given `{name, args}`, do the HTTP call against agent-web-host with your stored `AGENT_WEB_HOST_KEY`, return the result, repeat.

## Authentication handling

**Both connector styles:** keep the `AGENT_WEB_HOST_KEY` in the connector's own configuration, never in arguments the model can see or set.

- Environment variables for local processes (MCP stdio servers, scripts)
- A secret manager (1Password, Doppler, Vault) for shared deployments
- Never accept the key as a tool parameter — that puts it into model context and chat history

**Rotation**: mint a new key via the operator API (`POST /admin/agents/:id/keys`), update the connector's config, verify it works, then revoke the old key (`DELETE /admin/keys/:id`). The Worker checks D1 on every request, so revocation is instant.

## Error mapping

Don't pass raw 4xx JSON bodies through to the model — translate. Suggested mappings:

| Server response | Tool-result text |
|---|---|
| 200/201 success | The parsed JSON (or raw HTML for `read_document`) |
| 401 unauthorized | `"connector misconfigured: AGENT_WEB_HOST_KEY is invalid or revoked"` (don't ask the model to fix this) |
| 404 not found | `"no such document"` |
| 412 precondition failed | `"version conflict: current is v<N>, you sent v<M>; refetch and retry"` |
| 413 too large | `"document too large or fleet storage quota exceeded"` |
| 415 wrong content type | `"connector bug: sent wrong Content-Type"` (your fault, not the model's) |
| 428 If-Match required | `"connector bug: missing If-Match header"` (your fault) |

The 415/428 cases shouldn't be reachable if the connector is correct — they're connector bugs to surface in logs, not retry signals for the model.

## Security notes

- **Don't log the request body of `publish_document` or `update_document`.** Agent output can contain sensitive content the user didn't intend to write to disk.
- **Don't log the `Authorization` header.** Use a redacting logger or strip headers before logging.
- **Sanitization is server-side, not client-side.** Don't try to filter HTML in the connector — the server does it, and double-sanitization can produce subtly different output than a single pass. The `modified` flag in the response is your signal that content changed.
- **The `public_id` is the capability.** When the model returns a URL to the user, that URL grants read access to anyone who sees it. If the connector logs URLs, treat the log as sensitive.
- **Read access bypasses the connector.** A `read_document` call hits the same `GET /d/:id` endpoint a human's browser would; the only difference is the `Authorization` header. Don't rely on the connector for access control — the URL secret is the access control.

## Testing your connector

Use the live deployment. From a separate process:

```sh
export AGENT_WEB_HOST_URL=https://<worker>.<subdomain>.workers.dev
export AGENT_WEB_HOST_KEY=awh_<your-test-agent-key>

# Publish
curl -s -X POST "$AGENT_WEB_HOST_URL/d" \
  -H "authorization: Bearer $AGENT_WEB_HOST_KEY" \
  -H 'content-type: text/html' \
  --data '<h1>connector test</h1>'

# Read
curl -s "$AGENT_WEB_HOST_URL/d/<public_id>" \
  -H "authorization: Bearer $AGENT_WEB_HOST_KEY"
```

If these work, your connector's job is just to wrap them. The model then drives the tool calls; the connector translates each call into the equivalent HTTP request.
