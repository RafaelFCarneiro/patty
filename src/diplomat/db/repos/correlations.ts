import { sql } from 'drizzle-orm';
import { TransactionStatus, TransactionType } from '../../../models/transaction.js';
import { SpendingShiftDbRowSchema, type SpendingShiftDbRow } from '../../../wire/db/correlations.js';
import type { Db } from '../driver.js';

/** One conditional-SUM pass splits `[baselineFrom, currentTo)` into `current`/`baseline_total` —
 *  covers a category present in only one window (brand-new or dropped) without a `FULL OUTER JOIN`
 *  (unsupported in SQLite). The `JOIN` (not `LEFT JOIN`) excludes uncategorized transactions; a
 *  sub-category transaction's `category_id` is always its parent's, so sub-category spend rolls up
 *  for free. */
const SPENDING_SHIFTS_SELECT = (baselineFrom: string, currentFrom: string, currentTo: string) => sql`
  SELECT c.name AS category, c.names AS category_names, t.currency,
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
   *  the reference month. */
  spendingShifts: (baselineFrom: string, currentFrom: string, currentTo: string) => Promise<SpendingShiftDbRow[]>;
};

export const correlationsRepo = (db: Db): CorrelationsRepo => ({
  spendingShifts: async (baselineFrom, currentFrom, currentTo) => {
    const rows = await db.all<Record<string, unknown>>(SPENDING_SHIFTS_SELECT(baselineFrom, currentFrom, currentTo));
    return rows.map((r) => SpendingShiftDbRowSchema.parse(r));
  },
});
