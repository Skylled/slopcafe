/**
 * Search query preparation for the FTS5-backed document search.
 *
 * FTS5 accepts a small query language (implicit AND across whitespace-
 * separated tokens, plus `"phrases"`, `column:term`, `OR`, `NOT`, `NEAR`,
 * and trailing `*` for prefix match). Exposing it raw to agents has two
 * problems:
 *
 *   1. An unbalanced `"` or stray `(` makes the whole MATCH throw a SQLITE
 *      parse error, which we can't catch structurally — the agent gets a
 *      generic 500 with no learnable signal.
 *   2. `column:term` lets a caller probe the schema (e.g. `tags:foo`),
 *      bypassing the tokenizer guarantees we make in core.ts. Not a
 *      security issue, but it muddies the contract.
 *
 * v1 takes the simple route: tokenize on word characters (Unicode letters,
 * digits, `_`, `-`), allow a trailing `*` for prefix match, and AND-join.
 * Anything else (quotes, parens, operators, punctuation) is silently
 * dropped. Tokens shorter than 2 chars are dropped — `a*` would otherwise
 * match almost every document and FTS5 evaluates short-prefix searches
 * linearly.
 *
 * Phrase queries and explicit OR/NEAR are deliberately deferred. If they
 * earn their place later, we'll extend the grammar here; callers see
 * `bad_query` for inputs that tokenize to nothing, which is the only
 * failure shape they need to handle.
 */

/**
 * Convert an agent's raw query string into a sanitized FTS5 MATCH expression.
 * Returns `null` when the input contains no usable tokens — the caller
 * surfaces this as `bad_query` rather than running an FTS MATCH against
 * the empty string (which FTS5 rejects).
 *
 * Examples:
 *   "publishing docs"        → "publishing docs"      (implicit AND)
 *   "publi*"                 → "publi*"               (prefix match)
 *   "\"quoted phrase\""      → "quoted phrase"        (quotes dropped, words kept)
 *   "()"                     → null                   (no usable tokens)
 *   "a b cd"                 → "cd"                   (short tokens dropped)
 *   "naïve résumé"           → "naïve résumé"         (diacritics handled at tokenize time)
 */
export function buildFtsMatchQuery(raw: string): string | null {
  // The regex captures runs of word characters with an optional `*` suffix.
  // `\p{L}\p{N}` covers Unicode letters and numbers; `_-` are tag-charset
  // adjacent and useful inside identifiers. Anything else acts as a separator.
  const matches = raw.matchAll(/[\p{L}\p{N}_-]+\*?/gu);
  const tokens: string[] = [];
  for (const m of matches) {
    // Lowercase before submitting. FTS5 operators (AND, OR, NOT, NEAR) are
    // case-sensitive uppercase keywords — "math AND physics" from a user is
    // almost certainly three words, not a Boolean. Lowercasing collapses
    // them to ordinary terms. unicode61 folds case at index time too, so
    // this also normalizes the comparison without losing matches.
    const t = m[0].toLowerCase();
    // Drop tokens whose base (sans trailing `*`) is shorter than 2 chars —
    // short prefixes are pathological for FTS5, and one-letter terms hit
    // almost every document.
    const base = t.endsWith("*") ? t.slice(0, -1) : t;
    if (base.length < 2) continue;
    tokens.push(t);
  }
  if (tokens.length === 0) return null;
  // FTS5 defaults to implicit AND for space-separated tokens at the top
  // level of a MATCH expression — exactly the semantic we want.
  return tokens.join(" ");
}
