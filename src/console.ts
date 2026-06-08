// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/**
 * The operator console — a server-rendered (NO client JavaScript) admin UI under
 * `/admin/console/*`, behind the operator browser session (cookie + CSRF). It is
 * a thin HTML skin over the SAME `*Core` functions the JSON admin handlers call,
 * so the console never re-derives SQL or duplicates a kill cascade: every list
 * reads through `listAgentsCore`/`listAgentKeysCore`/`listDocumentsCore`/etc, and
 * every mutation runs through `mintAgentCore`/`revokeAgentCore`/… The console is
 * the "operator at a keyboard" door; the JSON handlers stay the programmatic one,
 * and both converge on core (the same "route through core" rule the write path
 * follows).
 *
 * AUTH per surface:
 *  - GET pages require a *cookie* session specifically (not a pasted Bearer): a
 *    browser navigating the console has a cookie, and demanding it before any DB
 *    hit means a logged-out visitor gets a sign-in card that discloses nothing
 *    (no existence oracle — the card is rendered without touching D1).
 *  - POST forms go through `authorizeOperatorForm` (the form-field CSRF ladder):
 *    a pasted `operator_token` authorizes outright (synthetic Bearer, CSRF-exempt
 *    — the token IS the inline credential), otherwise a valid session cookie plus
 *    a matching `csrf_token` field. We deliberately do NOT use `requireOperator`
 *    here: that guard reads an `X-CSRF-Token` *header* a no-JS form can't send.
 *
 * SECRET DISCIPLINE: minted keys / client secrets are shown EXACTLY ONCE via
 * `renderSecretCard`, always under `cache-control: no-store` (set by
 * `consoleResponse`), and are NEVER logged. Same discipline as the OAuth token
 * and the operator token elsewhere.
 *
 * ANTI-XSS: this module renders untrusted, user-controlled values (agent names,
 * document titles, the reflected `?q=` search box). EVERY dynamic value passes
 * through `escapeHtml`. Ids interpolated into hrefs/paths are regex-shaped first
 * (`PUBLIC_ID_RE` for documents, `UUID_RE` for agents/keys) and still escaped on
 * render.
 *
 * Routing lives in index.ts (a later phase) — this module only EXPORTS the
 * handlers. `buildNextHref` is exported for unit testing of the cursor-carry.
 */

import {
  createOAuthClientCore,
  createUnboundOAuthClientCore,
  deleteOAuthClientCore,
  listBoundClientsCore,
} from "./admin-oauth.js";
import {
  type AgentKeyListRow,
  type AgentListRow,
  listAgentKeysCore,
  listAgentsCore,
  mintAgentCore,
  mintAgentKeyCore,
  revokeAgentCore,
  revokeKeyCore,
} from "./admin.js";
import {
  type BackfillMode,
  backfillVectorsCore,
  currentStorageUsedBytes,
  type DocumentListing,
  listDocumentsCore,
  type SearchHit,
  searchDocumentsCore,
} from "./core.js";
import type { Env } from "./env.js";
import { escapeHtml, formatCreatedAt } from "./html.js";
import { UUID_RE } from "./ids.js";
import { normalizeTitleForDisplay, SITE_BRAND } from "./metadata.js";
import { parseHttpListParams } from "./pagination.js";
// PUBLIC_ID_RE is defined in serve.ts (the render surface that owns the document
// URL shape). serve.ts does not import console.ts, so this one-const import is
// cycle-free; we reuse the single source of truth rather than re-derive it.
import { PUBLIC_ID_RE } from "./serve.js";
import {
  authenticateOperatorRequest,
  authorizeOperatorForm,
  type FormAuthz,
} from "./session.js";

// ============================================================================
// Chrome — CSP, response wrapper, page shell, shared cards
// ============================================================================

/**
 * The console CSP. Same posture as the login/manage pages: no JS, inline styles
 * only (the `<style>` block in the shell), forms post same-origin, no framing.
 */
const CONSOLE_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

/**
 * Every console response: HTML, the tight CSP, and `no-store` so a secret card
 * (or any operator-only listing) never lands in a shared cache or the browser's
 * back-forward cache. `Vary: Cookie` because the body depends on the session
 * cookie (a signed-in page vs a sign-in card for the same URL).
 */
function consoleResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": CONSOLE_CSP,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex",
      vary: "Cookie",
    },
  });
}

type Nav = "dashboard" | "agents" | "documents" | "maintenance";

/**
 * The full console page shell: doctype/head/<style> + a topbar with the brand
 * and the four nav sections (the active one marked) and a Sign-out link. The
 * visual language matches login.ts / the manage page (system-ui, the same card +
 * notice palette). `bodyHtml` is the page-specific content; the caller has
 * already escaped every dynamic value inside it.
 */
function consolePage(active: Nav, title: string, bodyHtml: string): string {
  const link = (key: Nav, href: string, label: string) =>
    `<a class="nav${key === active ? " active" : ""}" href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)} | ${SITE_BRAND}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{font:14px/1.5 system-ui,sans-serif;margin:0;color:#222;background:#fafafa}
.top{display:flex;align-items:center;gap:4px;flex-wrap:wrap;padding:12px 24px;background:#fff;border-bottom:1px solid #e5e5e5}
.top .brand{font-weight:600;font-size:15px;color:#222;text-decoration:none;margin-right:16px}
.top .nav{font-size:13px;color:#555;text-decoration:none;padding:6px 10px;border-radius:4px}
.top .nav:hover{background:#f2f2f2}
.top .nav.active{color:#222;font-weight:600;background:#eee}
.top .spacer{flex:1}
.top .signout{font-size:13px;color:#a00;text-decoration:none;padding:6px 10px}
.wrap{max-width:920px;margin:0 auto;padding:28px 24px}
.card{background:#fff;border:1px solid #e5e5e5;border-radius:8px;padding:24px;margin:0 0 20px}
h1{font-size:18px;margin:0 0 4px;font-weight:600}
h2{font-size:14px;margin:0 0 10px;font-weight:600}
.sub{font-size:13px;color:#777;margin:0 0 16px;word-break:break-word}
p{margin:0 0 14px;color:#555}
section{padding:20px 0;border-top:1px solid #eee}
section:first-of-type{border-top:0;padding-top:0}
section.danger h2{color:#a00}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:7px 9px;border-bottom:1px solid #eee;vertical-align:middle}
th{color:#888;font-weight:600;font-size:12px}
tr:last-child td{border-bottom:0}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all}
a.mono,td a{color:#1a5fb4;text-decoration:none}
a.mono:hover,td a:hover{text-decoration:underline}
.muted{color:#999}
.badge{display:inline-block;padding:1px 8px;border-radius:10px;font-size:11px;font-weight:600;line-height:1.6}
.badge.public{background:#eef7ee;color:#256029}
.badge.private{background:#f2eefb;color:#5b3b9e}
.badge.revoked{background:#fdecec;color:#a02020}
.badge.active{background:#eef7ee;color:#256029}
.badge.expired{background:#fff4e5;color:#9a5b00}
.badge.dead{background:#f3f3f3;color:#888}
label{display:block;margin:0 0 6px;font-size:13px;color:#555}
input[type=text],select{box-sizing:border-box;padding:8px 10px;font:13px/1.4 system-ui,sans-serif;border:1px solid #ccc;border-radius:4px}
input[type=text]{width:100%}
.filters{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;margin:0 0 16px}
.filters .f{flex:1;min-width:140px}
.filters button{flex:0 0 auto}
.inline{display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap}
.inline .f{flex:1;min-width:160px}
button{padding:8px 14px;font:13px/1.4 system-ui,sans-serif;border-radius:4px;border:1px solid #222;background:#222;color:#fff;cursor:pointer}
button.danger-btn{background:#a00;border-color:#a00}
button.link-btn{padding:4px 10px;font-size:12px;background:#fff;color:#a00;border-color:#d99}
a.btn{display:inline-block;padding:9px 16px;font:13px/1.4 system-ui,sans-serif;border-radius:4px;border:1px solid #222;background:#222;color:#fff;text-decoration:none}
form{margin:0}
.hint{font-size:12px;color:#888;margin:6px 0 14px}
.hint code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.notice{padding:9px 12px;border-radius:4px;font-size:13px;margin:0 0 16px}
.notice.ok{background:#eef7ee;border:1px solid #cfe6cf;color:#256029}
.notice.err{background:#fdecec;border:1px solid #f3c2c2;color:#a02020}
.note{font-size:12px;color:#888;margin-top:18px}
.note a{color:#555}
.bar{height:10px;border-radius:6px;background:#eee;overflow:hidden;margin:6px 0 4px}
.bar>span{display:block;height:100%;background:#1a5fb4}
.warn{padding:11px 13px;border-radius:4px;font-size:13px;margin:0 0 16px;background:#fff8e6;border:1px solid #f0dca0;color:#7a5a00}
pre{margin:0;padding:11px 12px;background:#1d1f21;color:#e6e6e6;border-radius:4px;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;word-break:break-all}
.stat{display:inline-block;margin-right:32px}
.stat .n{font-size:24px;font-weight:600;color:#222}
.stat .l{font-size:12px;color:#888}
.next{display:inline-block;margin-top:14px;font-size:13px}
</style>
</head>
<body>
<div class="top">
<a class="brand" href="/admin/console">${SITE_BRAND}</a>
${link("dashboard", "/admin/console", "Dashboard")}
${link("agents", "/admin/console/agents", "Agents")}
${link("documents", "/admin/console/documents", "Documents")}
${link("maintenance", "/admin/console/maintenance", "Maintenance")}
<span class="spacer"></span>
<a class="signout" href="/logout">Sign out</a>
</div>
<div class="wrap">
${bodyHtml}
</div>
</body>
</html>
`;
}

/**
 * The sign-in card shown by every GET page when the caller has no cookie session.
 * Rendered with NO DB hit so a logged-out visitor learns nothing about whether a
 * given resource exists. Links to /login carrying the requested path as `next`.
 */
function renderConsoleSignin(nextPath: string): string {
  const loginHref = escapeHtml(`/login?next=${encodeURIComponent(nextPath)}`);
  const body = `<div class="card">
<h1>Operator sign in</h1>
<p>The console needs an operator browser session.</p>
<p><a class="btn" href="${loginHref}">Sign in</a></p>
</div>`;
  // No nav highlight — a signed-out shell. Keep the topbar so the brand link is
  // present, but mark no section active.
  return consolePage("dashboard", "Sign in", body);
}

/**
 * The one-time secret card: a terminal page that shows minted secrets (an agent
 * key, an OAuth client secret) with a loud "shown once" warning, each value in a
 * copy-friendly <pre>, the caller's note, and a back link. Always served via
 * `consoleResponse` (no-store). The VALUES here are secrets — they are rendered
 * but NEVER logged.
 */
function renderSecretCard(
  title: string,
  rows: Array<{ label: string; value: string }>,
  note: string,
  backHref: string,
  backLabel: string,
): string {
  const rowsHtml = rows
    .map(
      (r) =>
        `<label>${escapeHtml(r.label)}</label><pre>${escapeHtml(r.value)}</pre><div style="height:12px"></div>`,
    )
    .join("");
  const body = `<div class="card">
<h1>${escapeHtml(title)}</h1>
<p class="warn"><b>Store this now</b> — it is shown once and never again. Closing or reloading this page loses it.</p>
${rowsHtml}
<p class="hint">${escapeHtml(note)}</p>
<p class="note"><a href="${escapeHtml(backHref)}">← ${escapeHtml(backLabel)}</a></p>
</div>`;
  return consolePage("agents", title, body);
}

/** A standalone notice card (used for POST results on the pasted-token path, and
 *  for opaque errors). `kind` selects the ok/err palette. */
function renderNoticeCard(
  active: Nav,
  title: string,
  kind: "ok" | "err",
  message: string,
  backHref: string,
  backLabel: string,
): string {
  const body = `<div class="card">
<h1>${escapeHtml(title)}</h1>
<p class="notice ${kind}">${escapeHtml(message)}</p>
<p class="note"><a href="${escapeHtml(backHref)}">← ${escapeHtml(backLabel)}</a></p>
</div>`;
  return consolePage(active, title, body);
}

type Notice = { kind: "ok" | "err"; message: string } | null;

function noticeHtml(notice: Notice): string {
  if (!notice) return "";
  return `<p class="notice ${notice.kind}">${escapeHtml(notice.message)}</p>`;
}

/**
 * Build the "Next →" href for a paginated GET page: clone the current URL's
 * search params, set `cursor=<next_cursor>`, and keep every other filter param
 * (q/tag/slug/limit) so the next page narrows identically. Pure (takes the URL +
 * cursor, returns a path+search string) so it's unit-testable; the cursor is an
 * opaque value we only ever echo, never construct.
 *
 * `basePath` overrides the link's pathname for the case where a POST handler
 * re-renders a list page (e.g. revoke-key → agent detail): there `currentUrl`
 * is the POST endpoint, so the link must point at the page's own GET path, not
 * the action URL. GET callers omit it (their pathname is already canonical).
 */
export function buildNextHref(currentUrl: URL, cursor: string, basePath?: string): string {
  const params = new URLSearchParams(currentUrl.search);
  params.set("cursor", cursor);
  return `${basePath ?? currentUrl.pathname}?${params.toString()}`;
}

// ============================================================================
// Small shared render bits
// ============================================================================

/** A live document's Public/Private (or Revoked) badge. */
function visibilityBadge(d: DocumentListing): string {
  if (d.revoked_at) return `<span class="badge revoked">revoked</span>`;
  return d.visibility === "private"
    ? `<span class="badge private">private</span>`
    : `<span class="badge public">public</span>`;
}

/** Format a byte count as a compact KB/MB string. */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

// ============================================================================
// 1. Dashboard
// ============================================================================

/** GET /admin/console — counts + a storage-used bar. No forms, no secrets. */
export async function serveConsoleDashboard(req: Request, env: Env): Promise<Response> {
  const auth = await authenticateOperatorRequest(req, env);
  if (!auth.ok || auth.via !== "cookie") {
    return consoleResponse(renderConsoleSignin("/admin/console"));
  }

  // Counts: live documents + total agents. Storage used comes from
  // currentStorageUsedBytes — the SAME accounting checkStorageCap enforces, so
  // the dashboard's "used" can never drift from the cap check.
  const counts = await env.META.prepare(
    `select
       (select count(*) from documents where revoked_at is null) as docs,
       (select count(*) from agents) as agents`,
  ).first<{ docs: number; agents: number }>();

  const docs = Number(counts?.docs ?? 0);
  const agents = Number(counts?.agents ?? 0);
  const used = await currentStorageUsedBytes(env);
  const cap = Number(env.STORAGE_CAP_BYTES) || 0;
  const pct = cap > 0 ? Math.min(100, Math.round((used / cap) * 100)) : 0;

  const body = `<div class="card">
<h1>Dashboard</h1>
<p class="sub">Operator console for ${escapeHtml(SITE_BRAND)}.</p>
<section>
<div class="stat"><div class="n">${docs}</div><div class="l">live documents</div></div>
<div class="stat"><div class="n">${agents}</div><div class="l">agents</div></div>
</section>
<section>
<h2>Storage</h2>
<div class="bar"><span style="width:${pct}%"></span></div>
<p class="hint">${escapeHtml(formatBytes(used))} of ${escapeHtml(formatBytes(cap))} used (${pct}%). Counts both the sanitized render and the retained source across live documents.</p>
</section>
</div>`;
  return consoleResponse(consolePage("dashboard", "Dashboard", body));
}

// ============================================================================
// 2. Agents list + mint
// ============================================================================

/** GET /admin/console/agents — the agents table + a mint form. */
export async function serveConsoleAgents(
  req: Request,
  env: Env,
  notice: Notice = null,
): Promise<Response> {
  const auth = await authenticateOperatorRequest(req, env);
  if (!auth.ok || auth.via !== "cookie") {
    return consoleResponse(renderConsoleSignin("/admin/console/agents"));
  }
  const csrf = escapeHtml(auth.csrf);

  const url = new URL(req.url);
  const params = parseHttpListParams(url);
  if (!params.ok) {
    return consoleResponse(
      renderNoticeCard(
        "agents",
        "Agents",
        "err",
        params.message,
        "/admin/console/agents",
        "Back to agents",
      ),
      400,
    );
  }

  const { agents, next_cursor } = await listAgentsCore(env, params);
  const rows = agents.map((a) => renderAgentRow(a)).join("");
  // basePath: re-renders from a POST (revoke-agent) pass a POST `req`, so pin the
  // Next link to the canonical GET path rather than `url.pathname`.
  const next = next_cursor
    ? `<a class="next" href="${escapeHtml(buildNextHref(url, next_cursor, "/admin/console/agents"))}">Next →</a>`
    : "";
  const tableBody =
    rows.length > 0
      ? rows
      : `<tr><td colspan="5" class="muted">No agents yet — mint one below.</td></tr>`;

  const body = `<div class="card">
<h1>Agents</h1>
${noticeHtml(notice)}
<table>
<thead><tr><th>Name</th><th>Agent ID</th><th>Active / total keys</th><th>Live docs</th><th>Created</th></tr></thead>
<tbody>${tableBody}</tbody>
</table>
${next}
</div>
<div class="card">
<h2>Mint agent</h2>
<p>Creates an agent and its first API key. The plaintext key is shown once.</p>
<form method="POST" action="/admin/console/agents" class="inline">
<input type="hidden" name="csrf_token" value="${csrf}">
<div class="f"><label for="name">Agent name</label><input id="name" name="name" type="text" maxlength="200" required autocomplete="off" placeholder="e.g. research-bot"></div>
<button type="submit">Mint agent</button>
</form>
</div>`;
  return consoleResponse(consolePage("agents", "Agents", body));
}

function renderAgentRow(a: AgentListRow): string {
  // a.id is a UUID from D1; shape-check before the href, escape on render.
  const idOk = UUID_RE.test(a.id);
  const idCell = idOk
    ? `<a class="mono" href="/admin/console/agents/${a.id}">${escapeHtml(a.id)}</a>`
    : `<span class="mono">${escapeHtml(a.id)}</span>`;
  return `<tr>
<td>${escapeHtml(a.name)}</td>
<td>${idCell}</td>
<td>${a.active_keys} / ${a.total_keys}</td>
<td>${a.live_docs}</td>
<td>${escapeHtml(formatCreatedAt(a.created_at))}</td>
</tr>`;
}

/** POST /admin/console/agents — validate name → mintAgentCore → secret card. */
export async function handleConsoleMintAgent(req: Request, env: Env): Promise<Response> {
  const form = await req.formData();
  const authz = await authorizeOperatorForm(req, env, form);
  if (!authz.ok) return formAuthzCard("agents", "Mint agent", authz, "/admin/console/agents", "Back to agents");

  const name = String(form.get("name") ?? "").trim();
  if (name.length === 0 || name.length > 200) {
    return consoleResponse(
      renderNoticeCard(
        "agents",
        "Mint agent",
        "err",
        "Agent name must be 1–200 characters.",
        "/admin/console/agents",
        "Back to agents",
      ),
      400,
    );
  }

  const result = await mintAgentCore(env, name);
  if (!result.ok) {
    return consoleResponse(
      renderNoticeCard(
        "agents",
        "Mint agent",
        "err",
        "Server misconfigured (HMAC_PEPPER not set) — cannot mint.",
        "/admin/console/agents",
        "Back to agents",
      ),
      500,
    );
  }

  // The new agent's detail page is the natural place to land after minting.
  const backHref = UUID_RE.test(result.agentId)
    ? `/admin/console/agents/${result.agentId}`
    : "/admin/console/agents";
  return consoleResponse(
    renderSecretCard(
      "Agent minted",
      [
        { label: "Agent ID", value: result.agentId },
        { label: "Key ID", value: result.keyId },
        { label: "API key (store now)", value: result.key },
      ],
      "Give the API key to the agent as the Authorization: Bearer credential. The secret half is never returned again.",
      backHref,
      "Go to agent",
    ),
  );
}

// ============================================================================
// 4. Agent detail (keys, OAuth clients, danger zone)
// ============================================================================

/** GET /admin/console/agents/:id — keys + OAuth clients + danger zone. */
export async function serveConsoleAgentDetail(
  agentId: string,
  req: Request,
  env: Env,
  notice: Notice = null,
): Promise<Response> {
  const selfPath = `/admin/console/agents/${UUID_RE.test(agentId) ? agentId : ""}`;
  const auth = await authenticateOperatorRequest(req, env);
  if (!auth.ok || auth.via !== "cookie") {
    // Sign-in card BEFORE any DB hit (no existence oracle).
    return consoleResponse(renderConsoleSignin(selfPath));
  }
  const csrf = escapeHtml(auth.csrf);

  const url = new URL(req.url);
  const params = parseHttpListParams(url);
  if (!params.ok) {
    return consoleResponse(
      renderNoticeCard("agents", "Agent", "err", params.message, "/admin/console/agents", "Back to agents"),
      400,
    );
  }

  const keysResult = await listAgentKeysCore(env, agentId, params);
  if (!keysResult.ok) {
    // Opaque 404 (AFTER the sign-in gate). Malformed-or-unknown look identical.
    return consoleResponse(
      renderNoticeCard("agents", "Not found", "err", "No such agent.", "/admin/console/agents", "Back to agents"),
      404,
    );
  }
  // agentId is now known to exist and (via listAgentKeysCore's UUID_RE check)
  // be well-formed, so it's safe to interpolate into form actions / hrefs.
  const safeId = escapeHtml(agentId);
  const clients = await listBoundClientsCore(env, agentId);

  const keyRows = keysResult.keys.map((k) => renderKeyRow(k, csrf)).join("");
  // basePath: revoke-key / delete-client re-render this page from a POST `req`,
  // so pin the keys Next link to this agent's GET path, not the POST endpoint.
  const keysNext = keysResult.next_cursor
    ? `<a class="next" href="${escapeHtml(buildNextHref(url, keysResult.next_cursor, `/admin/console/agents/${agentId}`))}">Next →</a>`
    : "";
  const keysTableBody =
    keyRows.length > 0
      ? keyRows
      : `<tr><td colspan="4" class="muted">No keys.</td></tr>`;

  const clientRows = clients.map((c) => renderClientRow(c, agentId, csrf)).join("");
  const clientsTableBody =
    clientRows.length > 0
      ? clientRows
      : `<tr><td colspan="3" class="muted">No bound OAuth clients.</td></tr>`;

  const body = `<div class="card">
<h1>Agent <span class="mono">${safeId}</span></h1>
<p class="sub">${escapeHtml(keysResult.name)}</p>
${noticeHtml(notice)}
<section>
<h2>API keys</h2>
<table>
<thead><tr><th>Prefix</th><th>Status</th><th>Created</th><th></th></tr></thead>
<tbody>${keysTableBody}</tbody>
</table>
${keysNext}
<div style="height:16px"></div>
<form method="POST" action="/admin/console/agents/${agentId}/keys" class="inline">
<input type="hidden" name="csrf_token" value="${csrf}">
<button type="submit">Mint key</button>
</form>
</section>
<section>
<h2>OAuth clients (bound)</h2>
<p class="hint">One bound client per agent. Unbound clients are not per-agent listable (the agent is chosen at consent).</p>
<table>
<thead><tr><th>Client ID</th><th>Created</th><th></th></tr></thead>
<tbody>${clientsTableBody}</tbody>
</table>
<div style="height:16px"></div>
<form method="POST" action="/admin/console/agents/${agentId}/oauth-clients" class="inline">
<input type="hidden" name="csrf_token" value="${csrf}">
<button type="submit">Mint bound client</button>
</form>
<div style="height:10px"></div>
<form method="POST" action="/admin/console/oauth-clients" class="inline">
<input type="hidden" name="csrf_token" value="${csrf}">
<input type="hidden" name="agent_id" value="${safeId}">
<button type="submit">Mint unbound client</button>
</form>
</section>
<section class="danger">
<h2>Danger zone</h2>
<p>Revoking an agent revokes <b>EVERY key</b> AND deletes <b>EVERY OAuth client</b> for it. Both auth doors slam shut immediately. This cannot be undone.</p>
<form method="POST" action="/admin/console/agents/revoke">
<input type="hidden" name="csrf_token" value="${csrf}">
<input type="hidden" name="agent_id" value="${safeId}">
<button type="submit" class="danger-btn">Revoke agent</button>
</form>
</section>
<p class="note"><a href="/admin/console/agents">← Back to agents</a></p>
</div>`;
  return consoleResponse(consolePage("agents", "Agent", body));
}

function renderKeyRow(k: AgentKeyListRow, csrf: string): string {
  let status: string;
  let revokeForm = "";
  if (k.revoked_at) {
    status = `<span class="badge dead">revoked</span>`;
  } else if (k.expired) {
    status = `<span class="badge expired">expired</span>`;
  } else {
    status = `<span class="badge active">active</span>`;
    // Only an active key offers a revoke button (k.id is a UUID from D1).
    if (UUID_RE.test(k.id)) {
      revokeForm = `<form method="POST" action="/admin/console/keys/revoke"><input type="hidden" name="csrf_token" value="${csrf}"><input type="hidden" name="key_id" value="${escapeHtml(k.id)}"><button type="submit" class="link-btn">Revoke</button></form>`;
    }
  }
  return `<tr>
<td class="mono">${escapeHtml(k.key_prefix)}</td>
<td>${status}</td>
<td>${escapeHtml(formatCreatedAt(k.created_at))}</td>
<td>${revokeForm}</td>
</tr>`;
}

function renderClientRow(
  c: { client_id: string; created_at: string },
  agentId: string,
  csrf: string,
): string {
  // client_id comes from the OAuth provider; treat as untrusted on render
  // (escape) but it isn't interpolated into a path — it rides as a form field.
  return `<tr>
<td class="mono">${escapeHtml(c.client_id)}</td>
<td>${escapeHtml(formatCreatedAt(c.created_at))}</td>
<td><form method="POST" action="/admin/console/oauth-clients/delete"><input type="hidden" name="csrf_token" value="${csrf}"><input type="hidden" name="client_id" value="${escapeHtml(c.client_id)}"><input type="hidden" name="agent_id" value="${escapeHtml(agentId)}"><button type="submit" class="link-btn">Delete</button></form></td>
</tr>`;
}

/** POST /admin/console/agents/:id/keys — mintAgentKeyCore → secret card. */
export async function handleConsoleMintKey(
  agentId: string,
  req: Request,
  env: Env,
): Promise<Response> {
  const form = await req.formData();
  const authz = await authorizeOperatorForm(req, env, form);
  const backHref = UUID_RE.test(agentId) ? `/admin/console/agents/${agentId}` : "/admin/console/agents";
  if (!authz.ok) return formAuthzCard("agents", "Mint key", authz, backHref, "Back to agent");

  const result = await mintAgentKeyCore(env, agentId);
  if (!result.ok) {
    const message =
      result.code === "misconfigured"
        ? "Server misconfigured (HMAC_PEPPER not set) — cannot mint."
        : "No such agent.";
    const status = result.code === "misconfigured" ? 500 : 404;
    return consoleResponse(
      renderNoticeCard("agents", "Mint key", "err", message, backHref, "Back to agent"),
      status,
    );
  }

  return consoleResponse(
    renderSecretCard(
      "Key minted",
      [
        { label: "Key ID", value: result.keyId },
        { label: "API key (store now)", value: result.key },
      ],
      "Give the API key to the agent as the Authorization: Bearer credential. The secret half is never returned again.",
      backHref,
      "Back to agent",
    ),
  );
}

/** POST /admin/console/keys/revoke — revokeKeyCore → re-render agent detail. */
export async function handleConsoleRevokeKey(req: Request, env: Env): Promise<Response> {
  const form = await req.formData();
  const authz = await authorizeOperatorForm(req, env, form);
  if (!authz.ok) {
    return formAuthzCard("agents", "Revoke key", authz, "/admin/console/agents", "Back to agents");
  }

  const keyId = String(form.get("key_id") ?? "");
  const result = await revokeKeyCore(env, keyId);
  if (!result.ok) {
    // Already revoked / unknown — benign. There's no agent context to bounce to,
    // so land on the agents list with a notice.
    return consoleResponse(
      renderNoticeCard(
        "agents",
        "Revoke key",
        "ok",
        "Key already revoked or not found.",
        "/admin/console/agents",
        "Back to agents",
      ),
    );
  }

  const notice: Notice = { kind: "ok", message: `Key ${result.keyPrefix} revoked.` };
  // On the cookie path we can re-render the owning agent's detail page with the
  // session CSRF; on the pasted-token path there's no nonce to seed a form, so a
  // terminal notice card is the honest result.
  if (authz.via === "cookie") {
    return await serveConsoleAgentDetail(result.agentId, req, env, notice);
  }
  const backHref = UUID_RE.test(result.agentId)
    ? `/admin/console/agents/${result.agentId}`
    : "/admin/console/agents";
  return consoleResponse(renderNoticeCard("agents", "Revoke key", "ok", notice.message, backHref, "Back to agent"));
}

/** POST /admin/console/agents/revoke — revokeAgentCore → re-render agents list. */
export async function handleConsoleRevokeAgent(req: Request, env: Env): Promise<Response> {
  const form = await req.formData();
  const authz = await authorizeOperatorForm(req, env, form);
  if (!authz.ok) {
    return formAuthzCard("agents", "Revoke agent", authz, "/admin/console/agents", "Back to agents");
  }

  const agentId = String(form.get("agent_id") ?? "");
  if (!UUID_RE.test(agentId)) {
    return consoleResponse(
      renderNoticeCard("agents", "Revoke agent", "err", "No such agent.", "/admin/console/agents", "Back to agents"),
      404,
    );
  }

  const result = await revokeAgentCore(env, agentId);
  if (!result.ok) {
    if (result.code === "partial") {
      // The bearer door is shut (keys revoked) but an OAuth client deletion threw
      // mid-cascade. Surface the structured message so the operator knows to
      // re-run (the retry is idempotent). Re-render the list.
      const notice: Notice = { kind: "err", message: result.message };
      return await reRenderAgents(req, env, notice, 500);
    }
    return consoleResponse(
      renderNoticeCard("agents", "Revoke agent", "err", "No such agent.", "/admin/console/agents", "Back to agents"),
      404,
    );
  }

  const keyWord = result.keysRevoked === 1 ? "key" : "keys";
  const clientWord = result.oauthClientsDeleted === 1 ? "client" : "clients";
  const notice: Notice = {
    kind: "ok",
    message: `Agent killed: ${result.keysRevoked} ${keyWord} revoked, ${result.oauthClientsDeleted} OAuth ${clientWord} deleted.`,
  };
  return await reRenderAgents(req, env, notice);
}

/**
 * Re-render the agents list with a notice on the cookie path, or a terminal
 * notice card on the pasted-token path (where there's no session to drive
 * `serveConsoleAgents`'s cookie gate). `serveConsoleAgents` re-checks the cookie,
 * so this stays correct regardless.
 */
async function reRenderAgents(
  req: Request,
  env: Env,
  notice: Notice,
  status = 200,
): Promise<Response> {
  const auth = await authenticateOperatorRequest(req, env);
  if (auth.ok && auth.via === "cookie") {
    const resp = await serveConsoleAgents(req, env, notice);
    // serveConsoleAgents always 200s on a good cookie; override status if needed
    // (e.g. a partial revoke wants 500). Rebuild with the same body to set status.
    if (status !== 200) {
      return new Response(resp.body, { status, headers: resp.headers });
    }
    return resp;
  }
  return consoleResponse(
    renderNoticeCard(
      "agents",
      "Revoke agent",
      notice?.kind ?? "ok",
      notice?.message ?? "",
      "/admin/console/agents",
      "Back to agents",
    ),
    status,
  );
}

// ============================================================================
// OAuth client mint / delete
// ============================================================================

/** POST /admin/console/agents/:id/oauth-clients — bound client → secret card. */
export async function handleConsoleMintBoundClient(
  agentId: string,
  req: Request,
  env: Env,
): Promise<Response> {
  const form = await req.formData();
  const authz = await authorizeOperatorForm(req, env, form);
  const backHref = UUID_RE.test(agentId) ? `/admin/console/agents/${agentId}` : "/admin/console/agents";
  if (!authz.ok) return formAuthzCard("agents", "Mint OAuth client", authz, backHref, "Back to agent");

  const origin = new URL(req.url).origin;
  const result = await createOAuthClientCore(env, agentId, origin);
  if (!result.ok) {
    if (result.code === "client_exists") {
      return consoleResponse(
        renderNoticeCard(
          "agents",
          "Mint OAuth client",
          "err",
          `This agent already has a bound client (${result.client_id}). Delete it first to rotate.`,
          backHref,
          "Back to agent",
        ),
        409,
      );
    }
    return consoleResponse(
      renderNoticeCard("agents", "Mint OAuth client", "err", "No such agent.", backHref, "Back to agent"),
      404,
    );
  }

  return consoleResponse(
    renderSecretCard(
      "OAuth client minted (bound)",
      [
        { label: "Client ID", value: result.client_id },
        { label: "Client secret (store now)", value: result.client_secret },
        { label: "MCP URL", value: result.mcp_url },
      ],
      "Paste the client ID, secret, and MCP URL into the connector settings (Cowork / claude.ai). The secret is never returned again.",
      backHref,
      "Back to agent",
    ),
  );
}

/** POST /admin/console/oauth-clients — unbound client → secret card. */
export async function handleConsoleMintUnboundClient(req: Request, env: Env): Promise<Response> {
  const form = await req.formData();
  const authz = await authorizeOperatorForm(req, env, form);
  // The unbound mint isn't agent-scoped; bounce back to the agent detail if it
  // was minted from there, else the agents list.
  const agentId = String(form.get("agent_id") ?? "");
  const backHref = UUID_RE.test(agentId) ? `/admin/console/agents/${agentId}` : "/admin/console/agents";
  if (!authz.ok) return formAuthzCard("agents", "Mint OAuth client", authz, backHref, "Back to agent");

  const origin = new URL(req.url).origin;
  const result = await createUnboundOAuthClientCore(env, origin);
  return consoleResponse(
    renderSecretCard(
      "OAuth client minted (unbound)",
      [
        { label: "Client ID", value: result.client_id },
        { label: "Client secret (store now)", value: result.client_secret },
        { label: "MCP URL", value: result.mcp_url },
      ],
      "Unbound client — the agent is picked or minted at /authorize on first connect. Paste into the connector settings. The secret is never returned again.",
      backHref,
      "Back to agent",
    ),
  );
}

/** POST /admin/console/oauth-clients/delete — deleteOAuthClientCore → re-render. */
export async function handleConsoleDeleteClient(req: Request, env: Env): Promise<Response> {
  const form = await req.formData();
  const authz = await authorizeOperatorForm(req, env, form);
  const agentIdField = String(form.get("agent_id") ?? "");
  const backHref = UUID_RE.test(agentIdField)
    ? `/admin/console/agents/${agentIdField}`
    : "/admin/console/agents";
  if (!authz.ok) return formAuthzCard("agents", "Delete OAuth client", authz, backHref, "Back to agent");

  const clientId = String(form.get("client_id") ?? "");
  const result = await deleteOAuthClientCore(env, clientId);
  if (!result.ok) {
    const message =
      result.code === "provider_error"
        ? "OAuth client deletion failed — the mapping is intact; retry."
        : "No such OAuth client.";
    const status = result.code === "provider_error" ? 500 : 404;
    return consoleResponse(
      renderNoticeCard("agents", "Delete OAuth client", "err", message, backHref, "Back to agent"),
      status,
    );
  }

  const notice: Notice = { kind: "ok", message: "OAuth client deleted." };
  // Prefer the agent the delete returned (bound case); else the form field; else list.
  const ownerId = result.agent_id ?? (UUID_RE.test(agentIdField) ? agentIdField : null);
  if (authz.via === "cookie" && ownerId && UUID_RE.test(ownerId)) {
    return await serveConsoleAgentDetail(ownerId, req, env, notice);
  }
  return consoleResponse(renderNoticeCard("agents", "Delete OAuth client", "ok", notice.message, backHref, "Back to agent"));
}

// ============================================================================
// 11. Documents — list / search
// ============================================================================

/** GET /admin/console/documents — list (newest-first) or hybrid search via ?q=. */
export async function serveConsoleDocuments(req: Request, env: Env): Promise<Response> {
  const auth = await authenticateOperatorRequest(req, env);
  if (!auth.ok || auth.via !== "cookie") {
    return consoleResponse(renderConsoleSignin("/admin/console/documents"));
  }

  const url = new URL(req.url);
  const params = parseHttpListParams(url);
  if (!params.ok) {
    return consoleResponse(
      renderNoticeCard("documents", "Documents", "err", params.message, "/admin/console/documents", "Back to documents"),
      400,
    );
  }

  const q = (url.searchParams.get("q") ?? "").trim();
  // Prefill the FULL tag list (parseHttpListParams accepts repeated ?tag= AND
  // comma-separated and ANDs them), not just the first, so a multi-tag filter
  // round-trips through the form instead of silently dropping the rest.
  const tagFilter = url.searchParams
    .getAll("tag")
    .flatMap((v) => v.split(","))
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .join(", ");
  const slugFilter = url.searchParams.get("slug") ?? "";
  const filters = renderDocFilters(q, tagFilter, slugFilter);

  if (q !== "") {
    // Search mode: hybrid (keyword + semantic). No cursor pagination on search.
    const result = await searchDocumentsCore(env, q, params, "hybrid");
    if (!result.ok) {
      // bad_query (the query tokenized to nothing usable and no semantic leg could
      // carry it) — show the filter form + a notice, not a 500.
      const body = `<div class="card">
<h1>Documents</h1>
${filters}
<p class="notice err">No searchable terms in the query — try different keywords.</p>
</div>`;
      return consoleResponse(consolePage("documents", "Documents", body), 422);
    }
    const rows = result.documents.map((h) => renderSearchRow(h)).join("");
    const tableBody =
      rows.length > 0 ? rows : `<tr><td colspan="6" class="muted">No matches.</td></tr>`;
    const body = `<div class="card">
<h1>Documents</h1>
${filters}
<p class="hint">${result.documents.length} result(s) for <span class="mono">${escapeHtml(q)}</span> (hybrid search). Search results are relevance-ranked and not paginated.</p>
<table>
<thead><tr><th>ID</th><th>Title</th><th>Visibility</th><th>Match</th><th>Score</th><th>Snippet</th></tr></thead>
<tbody>${tableBody}</tbody>
</table>
</div>`;
    return consoleResponse(consolePage("documents", "Documents", body));
  }

  // List mode: newest-first, cursor-paginated.
  const { documents, next_cursor } = await listDocumentsCore(env, params);
  const rows = documents.map((d) => renderDocRow(d)).join("");
  const tableBody =
    rows.length > 0 ? rows : `<tr><td colspan="6" class="muted">No documents.</td></tr>`;
  const next = next_cursor
    ? `<a class="next" href="${escapeHtml(buildNextHref(url, next_cursor))}">Next →</a>`
    : "";
  const body = `<div class="card">
<h1>Documents</h1>
${filters}
<table>
<thead><tr><th>ID</th><th>Title</th><th>Visibility</th><th>Tags</th><th>Ver / size</th><th>Created</th></tr></thead>
<tbody>${tableBody}</tbody>
</table>
${next}
</div>`;
  return consoleResponse(consolePage("documents", "Documents", body));
}

/** The GET filter form. `q` is the classic reflected-XSS sink — escape it. */
function renderDocFilters(q: string, tag: string, slug: string): string {
  return `<form method="GET" action="/admin/console/documents" class="filters">
<div class="f"><label for="q">Search</label><input id="q" name="q" type="text" value="${escapeHtml(q)}" autocomplete="off" placeholder="keyword or concept"></div>
<div class="f"><label for="tag">Tag</label><input id="tag" name="tag" type="text" value="${escapeHtml(tag)}" autocomplete="off" placeholder="e.g. research"></div>
<div class="f"><label for="slug">Slug</label><input id="slug" name="slug" type="text" value="${escapeHtml(slug)}" autocomplete="off" placeholder="exact slug"></div>
<button type="submit">Filter</button>
</form>`;
}

/** A document title cell — display-normalized then escaped, falling back to (untitled). */
function docTitleCell(title: string | null): string {
  const t = title ? normalizeTitleForDisplay(title) : "";
  return escapeHtml(t.length > 0 ? t : "(untitled)");
}

/** public_id link cell — PUBLIC_ID_RE-shaped before the href, escaped on render. */
function docIdCell(publicId: string): string {
  if (PUBLIC_ID_RE.test(publicId)) {
    return `<a class="mono" href="/d/${publicId}/manage">${escapeHtml(publicId)}</a>`;
  }
  return `<span class="mono">${escapeHtml(publicId)}</span>`;
}

function renderDocRow(d: DocumentListing): string {
  const tags = d.tags.length > 0 ? escapeHtml(d.tags.join(", ")) : `<span class="muted">—</span>`;
  const ver = d.current_ver === null ? `<span class="muted">—</span>` : `v${d.current_ver}`;
  const size = d.current_size === null ? "" : ` · ${escapeHtml(formatBytes(d.current_size))}`;
  return `<tr>
<td>${docIdCell(d.public_id)}</td>
<td>${docTitleCell(d.title)}</td>
<td>${visibilityBadge(d)}</td>
<td>${tags}</td>
<td>${ver}${size}</td>
<td>${escapeHtml(formatCreatedAt(d.created_at))}</td>
</tr>`;
}

function renderSearchRow(h: SearchHit): string {
  return `<tr>
<td>${docIdCell(h.public_id)}</td>
<td>${docTitleCell(h.title)}</td>
<td>${visibilityBadge(h)}</td>
<td>${escapeHtml(h.matched_field)}</td>
<td>${escapeHtml(h.score.toFixed(3))}</td>
<td>${escapeHtml(h.snippet)}</td>
</tr>`;
}

// ============================================================================
// 12-13. Maintenance — Vectorize backfill
// ============================================================================

/** GET /admin/console/maintenance — the Vectorize backfill form. */
export async function serveConsoleMaintenance(
  req: Request,
  env: Env,
  notice: Notice = null,
  continueCursor: string | null = null,
  continueMode: BackfillMode = "missing",
): Promise<Response> {
  const auth = await authenticateOperatorRequest(req, env);
  if (!auth.ok || auth.via !== "cookie") {
    return consoleResponse(renderConsoleSignin("/admin/console/maintenance"));
  }
  const csrf = escapeHtml(auth.csrf);

  // If a previous backfill page returned a cursor, offer a Continue form that
  // carries it (and the same mode) so the operator can drain the remaining pages.
  const continueForm = continueCursor
    ? `<div style="height:12px"></div>
<form method="POST" action="/admin/console/vectors/backfill" class="inline">
<input type="hidden" name="csrf_token" value="${csrf}">
<input type="hidden" name="mode" value="${escapeHtml(continueMode)}">
<input type="hidden" name="cursor" value="${escapeHtml(continueCursor)}">
<button type="submit">Continue →</button>
</form>`
    : "";

  const body = `<div class="card">
<h1>Maintenance</h1>
${noticeHtml(notice)}
<section>
<h2>Vectorize backfill</h2>
<p><b>Missing</b> embeds only documents not yet in the index (incremental heal of dropped publish-time syncs). <b>Rebuild</b> re-embeds every live document (use after a model/chunk change or to repair staleness). Runs synchronously and may take several pages on a large fleet.</p>
<form method="POST" action="/admin/console/vectors/backfill" class="inline">
<input type="hidden" name="csrf_token" value="${csrf}">
<div class="f"><label for="mode">Mode</label><select id="mode" name="mode"><option value="missing">missing (incremental)</option><option value="rebuild">rebuild (all)</option></select></div>
<button type="submit">Run backfill</button>
</form>
${continueForm}
</section>
</div>`;
  return consoleResponse(consolePage("maintenance", "Maintenance", body));
}

/**
 * POST /admin/console/vectors/backfill — run one backfill page → notice + a
 * Continue form when the core returns a next_cursor. `backfillVectorsCore` runs
 * synchronously (it embeds inline and returns counts), so this handler needs no
 * `ExecutionContext` / `waitUntil`.
 */
export async function handleConsoleBackfill(req: Request, env: Env): Promise<Response> {
  const form = await req.formData();
  const authz = await authorizeOperatorForm(req, env, form);
  if (!authz.ok) {
    return formAuthzCard("maintenance", "Backfill", authz, "/admin/console/maintenance", "Back to maintenance");
  }

  const modeRaw = String(form.get("mode") ?? "missing");
  if (modeRaw !== "missing" && modeRaw !== "rebuild") {
    return consoleResponse(
      renderNoticeCard(
        "maintenance",
        "Backfill",
        "err",
        `Mode must be "missing" or "rebuild".`,
        "/admin/console/maintenance",
        "Back to maintenance",
      ),
      400,
    );
  }
  const mode: BackfillMode = modeRaw;

  // limit/cursor reuse the standard list params. A continue form carries the
  // cursor as a form field; surface it on the URL the parser reads by cloning.
  const url = new URL(req.url);
  const cursorField = String(form.get("cursor") ?? "");
  if (cursorField) url.searchParams.set("cursor", cursorField);
  const params = parseHttpListParams(url);
  if (!params.ok) {
    return consoleResponse(
      renderNoticeCard("maintenance", "Backfill", "err", params.message, "/admin/console/maintenance", "Back to maintenance"),
      400,
    );
  }

  const r = await backfillVectorsCore(env, mode, params);
  const message =
    `Backfill (${r.mode}): scanned ${r.scanned}, embedded ${r.embedded}, ` +
    `${r.vectors} vector(s) upserted, ${r.skipped} skipped.` +
    (r.vectors < r.embedded ? " Some syncs failed — re-run to finish." : "") +
    (r.next_cursor ? " More pages remain — use Continue." : "");
  const notice: Notice = {
    kind: r.vectors < r.embedded ? "err" : "ok",
    message,
  };

  // On the cookie path re-render the maintenance page (with a Continue form when
  // a cursor remains); on the pasted-token path there's no session CSRF for the
  // Continue form, so a terminal notice card with the page's recap is the result.
  if (authz.via === "cookie") {
    return await serveConsoleMaintenance(req, env, notice, r.next_cursor, mode);
  }
  return consoleResponse(
    renderNoticeCard("maintenance", "Backfill", notice.kind, notice.message, "/admin/console/maintenance", "Back to maintenance"),
  );
}

// ============================================================================
// Shared form-authz failure card
// ============================================================================

/**
 * Render a `FormAuthz` failure (the `{ ok: false }` variant) as a notice card at
 * its status. Centralized so every POST handler surfaces an auth failure
 * identically (401 "sign in or paste the token" / 403 "CSRF failed").
 */
function formAuthzCard(
  active: Nav,
  title: string,
  authz: Extract<FormAuthz, { ok: false }>,
  backHref: string,
  backLabel: string,
): Response {
  return consoleResponse(
    renderNoticeCard(active, title, "err", authz.message, backHref, backLabel),
    authz.status,
  );
}
