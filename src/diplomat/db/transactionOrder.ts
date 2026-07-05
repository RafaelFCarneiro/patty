import { sql, type SQL } from 'drizzle-orm';
import { SortDirection, type CursorKey } from '../../models/page.js';
import { TransactionSortField } from '../../models/transaction.js';

/**
 * ADR-011/014: ORDER BY structure comes only from this whitelist — the caller-selected `sort`
 * enum picks a fixed, developer-authored column fragment; caller text never reaches the SQL
 * string. `Record<TransactionSortField, SQL>` gives compile-time exhaustiveness (adding a sort
 * field without a matching entry here is a type error), the same style as aggregateWhitelist.ts.
 */
export const ORDER_BY_COLUMN: Record<TransactionSortField, SQL> = {
  [TransactionSortField.enum.date]: sql`t.date`,
  [TransactionSortField.enum.amount]: sql`t.amount`,
};

/** Tiebreaker (t.id) follows `dir` — one uniform direction across the composite key, which is
 *  what keeps the keyset predicate below stable (ADR-014 Decision 1). */
export const orderByClause = (sort: TransactionSortField, dir: SortDirection): SQL => {
  const direction = dir === SortDirection.enum.asc ? sql`ASC` : sql`DESC`;
  return sql`${ORDER_BY_COLUMN[sort]} ${direction}, t.id ${direction}`;
};

/** Expanded keyset predicate, consistent with `orderByClause` per key component (ADR-014):
 *  `(col < ? OR (col = ? AND t.id < ?))` for `dir: desc`, `>` for `dir: asc`. Values are always
 *  parameter-bound; only the column fragment and comparator come from the whitelist. */
export const keysetPredicate = (sort: TransactionSortField, dir: SortDirection, key: CursorKey): SQL => {
  const column = ORDER_BY_COLUMN[sort];
  const cmp = dir === SortDirection.enum.asc ? sql`>` : sql`<`;
  return sql`(${column} ${cmp} ${key.value} OR (${column} = ${key.value} AND t.id ${cmp} ${key.id}))`;
};
