/**
 * Sanitizes a free-text user query for SQLite FTS5's MATCH syntax.
 *
 * FTS5 query strings have their own grammar (AND / OR / NOT, column
 * filters via `col:`, prefix matches via `*`, grouping via `()`, `-` as a
 * NOT-prefix shorthand, etc). A user query containing any of that syntax
 * must never make `MATCH` throw a syntax error — so every whitespace-
 * separated term is wrapped in double quotes, turning it into a literal
 * FTS5 phrase token. Any double quote already inside a term is escaped by
 * doubling it (`"` -> `""`), which is FTS5's own escape convention for
 * quoted strings.
 *
 * The result: terms are ANDed together (FTS5's implicit default between
 * bareword/phrase tokens) as literal text, so words like "AND" or "OR"
 * typed by a user are searched for as themselves, not treated as
 * operators.
 */
export function sanitizeFtsQuery(query: string): string {
  const terms = query.trim().split(/\s+/).filter((t) => t.length > 0);
  if (terms.length === 0) return "";

  return terms.map((term) => `"${term.replace(/"/g, '""')}"`).join(" ");
}
