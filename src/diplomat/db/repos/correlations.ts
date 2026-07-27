import { sql } from 'drizzle-orm';
import { TransactionStatus, TransactionType } from '../../../models/transaction.js';
import { SpendingShiftDbRowSchema, type SpendingShiftDbRow } from '../../../wire/db/correlations.js';
import type { Db } from '../driver.js';

/** Every (category, currency) with effective expense activity anywhere in `[baselineFrom,
 *  currentTo)`, split into `current` (on/after `currentFrom`) and `baseline_total` (before it) by
 *  one conditional-SUM pass — cheaper than two separate queries and, unlike a `FULL OUTER JOIN`
 *  (unsupported in SQLite), naturally covers a category present in only one of the two windows
 *  (a brand-new category, or one that dropped off entirely). Uncategorized transactions
 *  (`category_id IS NULL`) are excluded by the `JOIN` — `find_correlations` reports on named
 *  categories, mirroring how `create_budget`/`create_category` name-resolve rather than accept a
 *  null target. Rolls up sub-category spend into its parent for free: a sub-category transaction's
 *  `category_id` is always its parent's (the same invariant `aggregate_spending`/budgets rely on). */
const SPENDING_SHIFTS_SELECT = (baselineFrom: string, currentFrom: string, currentTo: string) => sql`
  SELECT c.id AS category_id, c.name AS category, c.names AS category_names, t.currency,
         SUM(CASE WHEN t.date >= ${currentFrom} THEN t.amount ELSE 0 END) AS current,
         SUM(CASE WHEN t.date < ${currentFrom} THEN t.amount ELSE 0 END) AS baseline_total
  FROM transactions t
  JOIN categories c ON c.id = t.category_id
  WHERE t.date >= ${baselineFrom} AND t.date < ${currentTo}
    AND t.status = ${TransactionStatus.enum.effective}
    AND t.type = ${TransactionType.enum.expense}
  GROUP BY t.currency, c.id
`;

export type CorrelationsRepo = {
  /** `[baselineFrom, currentFrom)` is the trailing baseline window; `[currentFrom, currentTo)` is
   *  the reference month — `controllers/correlations.ts` derives both from `logic/period.ts`'s
   *  `periodRange`/`baselineRange` before calling in. */
  spendingShifts: (baselineFrom: string, currentFrom: string, currentTo: string) => Promise<SpendingShiftDbRow[]>;
};

export const correlationsRepo = (db: Db): CorrelationsRepo => ({
  spendingShifts: async (baselineFrom, currentFrom, currentTo) => {
    const rows = await db.all<Record<string, unknown>>(SPENDING_SHIFTS_SELECT(baselineFrom, currentFrom, currentTo));
    return rows.map((r) => SpendingShiftDbRowSchema.parse(r));
  },
});
