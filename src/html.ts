// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/**
 * Tiny shared HTML/display helpers for the server-rendered (no-JS) operator
 * surfaces. Pure string functions — no env, no D1/R2/WASM — so they can be
 * imported anywhere a page is rendered (serve.ts, login.ts, the console)
 * without dragging dependencies along. The operator console is server-rendered
 * with no client JavaScript, so EVERY dynamic value interpolated into HTML must
 * pass through `escapeHtml` first.
 */

/** HTML-escape minimal entity set for safe interpolation into element text/attrs. */
export function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Render a `documents.created_at` ISO timestamp as `YYYY-MM-DD HH:MM UTC`.
 * Server-rendered because the shell CSP forbids JS (no `Intl` in the page).
 * Slicing — not parsing — because D1 always emits the canonical strftime
 * shape `YYYY-MM-DDTHH:MM:SS.sssZ` (see migrations/0001_init.sql defaults).
 */
export function formatCreatedAt(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}
