import { sql, type SQL } from 'drizzle-orm';
import { TransactionSortField } from '../../models/transaction.js';

/**
 * ADR-011/014 whitelist: the only column each `search_transactions` sort field may resolve to.
 * The caller-selected `sort` enum picks a fixed, developer-authored fragment here — caller text
 * never reaches ORDER BY. Same role and shape as aggregateWhitelist.ts's GROUP_BY_MAP/METRIC_MAP
 * (a data-only map; `Record<TransactionSortField, SQL>` gives compile-time exhaustiveness). This
 * file holds only the whitelist data — composing it into ORDER BY / the keyset predicate happens
 * in diplomat/db/repos/transactions.ts, alongside every other query assembly, not here.
 */
export const ORDER_BY_COLUMN: Record<TransactionSortField, SQL> = {
  [TransactionSortField.enum.date]: sql`t.date`,
  [TransactionSortField.enum.amount]: sql`t.amount`,
};
