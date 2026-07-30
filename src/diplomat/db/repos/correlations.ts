import { sql } from 'drizzle-orm';
import { TransactionStatus, TransactionType } from '../../../models/transaction.js';
import {
  BudgetFitDbRowSchema,
  MerchantSpendDbRowSchema,
  RecurringCandidateDbRowSchema,
  SpendingShiftDbRowSchema,
  type BudgetFitDbRow,
  type MerchantSpendDbRow,
  type RecurringCandidateDbRow,
  type SpendingShiftDbRow,
} from '../../../wire/db/correlations.js';
import type { Db } from '../driver.js';
import { budgetTargetMatch } from './budgets.js';

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

/** Same current/baseline conditional-SUM split as `SPENDING_SHIFTS_SELECT`, but matched to each
 *  budget's own target via the shared `budgetTargetMatch` predicate (top-level rollup or
 *  sub-category alone) instead of a plain category rollup — Feature Design 016 phase D. */
const BUDGET_FIT_SELECT = (baselineFrom: string, currentFrom: string, currentTo: string) => sql`
  SELECT b.id, b.currency, b.limit_amount,
         node.name AS node_name, node.names AS node_names,
         node.parent_id AS node_parent_id, parent.name AS parent_name, parent.names AS parent_names,
         COALESCE(SUM(CASE WHEN t.date >= ${currentFrom} THEN t.amount ELSE 0 END), 0) AS current,
         COALESCE(SUM(CASE WHEN t.date < ${currentFrom} THEN t.amount ELSE 0 END), 0) AS baseline_total
  FROM budgets b
  JOIN categories node ON node.id = b.category_id
  LEFT JOIN categories parent ON parent.id = node.parent_id
  LEFT JOIN transactions t
    ON t.currency = b.currency
    AND t.status = ${TransactionStatus.enum.effective}
    AND t.type = ${TransactionType.enum.expense}
    AND t.date >= ${baselineFrom} AND t.date < ${currentTo}
    AND (${budgetTargetMatch})
  GROUP BY b.id
`;

/** Per-merchant spend within `[from, to)`, optionally narrowed to one category — Feature Design
 *  016 phase C. `categoryId` binds as a parameter when present; the fragment is empty (no
 *  string-built clause) when absent, so caller text never reaches the query shape itself. */
const MERCHANT_CONCENTRATION_SELECT = (from: string, to: string, categoryId: string | null) => sql`
  SELECT c.name AS category, c.names AS category_names, t.currency, t.merchant_key, SUM(t.amount) AS spent
  FROM transactions t
  JOIN categories c ON c.id = t.category_id
  WHERE t.date >= ${from} AND t.date < ${to}
    AND t.status = ${TransactionStatus.enum.effective}
    AND t.type = ${TransactionType.enum.expense}
    ${categoryId ? sql`AND t.category_id = ${categoryId}` : sql``}
  GROUP BY t.currency, c.id, t.merchant_key
`;

/** Per-(merchant, currency) qualifying transaction rows within `[from, today]`, one row per
 *  transaction (not pre-aggregated) — cadence detection needs the individual dates/amounts, not a
 *  sum. Excludes merchants with no `merchant_key` (nothing to build a rule against) and merchants
 *  that already have one, via an exact match on Feature Design 017's `recurring_rules.merchant_key`
 *  — Feature Design 016 phase B. */
const RECURRING_CANDIDATES_SELECT = (from: string, today: string) => sql`
  SELECT t.merchant_key, t.currency, c.name AS category, c.names AS category_names, t.date, t.amount
  FROM transactions t
  JOIN categories c ON c.id = t.category_id
  WHERE t.date >= ${from} AND t.date <= ${today}
    AND t.status = ${TransactionStatus.enum.effective}
    AND t.type = ${TransactionType.enum.expense}
    AND t.merchant_key IS NOT NULL
    AND t.merchant_key NOT IN (SELECT merchant_key FROM recurring_rules WHERE merchant_key IS NOT NULL)
  ORDER BY t.merchant_key, t.currency, t.date
`;

export type CorrelationsRepo = {
  /** `[baselineFrom, currentFrom)` is the trailing baseline window; `[currentFrom, currentTo)` is
   *  the reference month. */
  spendingShifts: (baselineFrom: string, currentFrom: string, currentTo: string) => Promise<SpendingShiftDbRow[]>;
  /** One row per existing budget, same window semantics as `spendingShifts`. */
  budgetFit: (baselineFrom: string, currentFrom: string, currentTo: string) => Promise<BudgetFitDbRow[]>;
  /** One row per (category, currency, merchant) with spend in `[from, to)`. */
  merchantConcentration: (from: string, to: string, categoryId: string | null) => Promise<MerchantSpendDbRow[]>;
  /** One row per qualifying transaction in `[from, today]`, not already covered by a rule. */
  recurringCandidates: (from: string, today: string) => Promise<RecurringCandidateDbRow[]>;
};

export const correlationsRepo = (db: Db): CorrelationsRepo => ({
  spendingShifts: async (baselineFrom, currentFrom, currentTo) => {
    const rows = await db.all<Record<string, unknown>>(SPENDING_SHIFTS_SELECT(baselineFrom, currentFrom, currentTo));
    return rows.map((r) => SpendingShiftDbRowSchema.parse(r));
  },

  budgetFit: async (baselineFrom, currentFrom, currentTo) => {
    const rows = await db.all<Record<string, unknown>>(BUDGET_FIT_SELECT(baselineFrom, currentFrom, currentTo));
    return rows.map((r) => BudgetFitDbRowSchema.parse(r));
  },

  merchantConcentration: async (from, to, categoryId) => {
    const rows = await db.all<Record<string, unknown>>(MERCHANT_CONCENTRATION_SELECT(from, to, categoryId));
    return rows.map((r) => MerchantSpendDbRowSchema.parse(r));
  },

  recurringCandidates: async (from, today) => {
    const rows = await db.all<Record<string, unknown>>(RECURRING_CANDIDATES_SELECT(from, today));
    return rows.map((r) => RecurringCandidateDbRowSchema.parse(r));
  },
});
