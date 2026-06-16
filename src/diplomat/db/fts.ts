/**
 * Convert free user text into a safe FTS5 MATCH query.
 *
 * User input must never reach `MATCH` verbatim: FTS5 interprets its argument as a
 * query expression, so characters like `" - * : ( )` and bareword operators
 * (`AND`, `OR`, `NOT`, `NEAR`) cause `fts5: syntax error` at runtime. We tokenise on
 * whitespace and emit each token as a quoted string literal (internal quotes doubled),
 * combined with implicit AND. The value is still passed as a bound parameter — this
 * only neutralises FTS5 *expression* syntax, it is not about SQL injection.
 *
 * Returns `null` when there is no searchable token (caller skips the FTS filter).
 */
export const toMatchQuery = (text: string): string | null => {
  const tokens = text.split(/\s+/).filter((token) => token.length > 0)
  if (tokens.length === 0) return null
  return tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(' ')
}
