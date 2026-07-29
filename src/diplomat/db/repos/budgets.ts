import { and, eq, sql } from 'drizzle-orm';
import * as budgetAdapters from '../../../adapters/budgets.js';
import type { BudgetEntity, BudgetPeriod, BudgetStatusEntry, BudgetView } from '../../../models/budget.js';
import type { CurrencyCode } from '../../../models/money.js';
import { TransactionStatus, TransactionType } from '../../../models/transaction.js';
import type { Db } from '../driver.js';
import { budgets } from '../schema.js';
import { isUniqueConstraintViolation } from '../sqliteErrors.js';
import { VersionConflict, versionedTableApplier, type EntityApplier } from '../effects.js';

// Budgets target either a top-level category or a sub-category — both rows in `categories` — so
// the display projection always joins the node plus its (possibly absent) parent. Mirrors
// `subCategoriesRepo`'s `SUB_SELECT` (`diplomat/db/repos/subCategories.ts`): a hand-written raw
// join, not the query builder, for the same self-referencing-table reason.
const BUDGET_VIEW_SELECT = sql`
  SELECT b.id, b.currency, b.limit_amount, b.period, b.version,
         node.name AS node_name, node.parent_id AS node_parent_id, parent.name AS parent_name
  FROM budgets b
  JOIN categories node ON node.id = b.category_id
  LEFT JOIN categories parent ON parent.id = node.parent_id
`;

/** A top-level target (`node.parent_id IS NULL`) matches on `t.category_id`, rolling up
 *  sub-category spend for free; a sub-category target matches only `t.subcategory_id`. Assumes the
 *  query aliases `budgets b`/`categories node` the same way every consumer does. Shared by
 *  `budgetsRepo.status` and `correlationsRepo.budgetFit` so the two can't drift apart — mirrors
 *  `transactionsRepo.correlatedToCard`. */
export const budgetTargetMatch = sql`
  (node.parent_id IS NULL AND t.category_id = b.category_id)
  OR (node.parent_id IS NOT NULL AND t.subcategory_id = b.category_id)
`;

/** Each budget's spend over `[from, to)`: `effective`, `expense`-typed, same-currency transactions
 *  matched to the target (`budgetTargetMatch`). `type = expense`, not just `!= transfer`: a
 *  `both`-kind category is a legitimate budget target (`isExpenseEligible`), and unlike
 *  `aggregate`/`summaryRows` (`diplomat/db/repos/transactions.ts`, which keep `type` as an output
 *  dimension their callers separate income from expense by), `spent` here is one collapsed scalar —
 *  an income transaction on a `both`-kind category has to be excluded at the filter itself, or it
 *  inflates the cap. `COALESCE(SUM(t.amount), 0)` yields `spent: 0` for a budget with no match,
 *  rather than a missing row. */
const BUDGET_STATUS_SELECT = (from: string, to: string) => sql`
  SELECT b.id, b.currency, b.limit_amount, b.period,
         node.name AS node_name, node.parent_id AS node_parent_id, parent.name AS parent_name,
         COALESCE(SUM(t.amount), 0) AS spent
  FROM budgets b
  JOIN categories node ON node.id = b.category_id
  LEFT JOIN categories parent ON parent.id = node.parent_id
  LEFT JOIN transactions t
    ON t.currency = b.currency
    AND t.status = ${TransactionStatus.enum.effective}
    AND t.type = ${TransactionType.enum.expense}
    AND t.date >= ${from} AND t.date < ${to}
    AND (${budgetTargetMatch})
  GROUP BY b.id
  ORDER BY COALESCE(parent.name, node.name), node.name
`;

export type BudgetsRepo = {
  list: () => Promise<BudgetView[]>;
  /** Existence check for the `(category_id, currency, period)` duplicate guard in `createBudget`. */
  findByTarget: (categoryId: string, currency: CurrencyCode, period: BudgetPeriod) => Promise<boolean>;
  /** Version-carrying read — for `updateBudget`/`deleteBudget`, which need it to build a
   *  version-guarded `Persistable`. */
  findById: (id: string) => Promise<BudgetEntity | null>;
  /** Every budget's measured spend over `[from, to)` — `controllers/budgets.ts`'s `getBudgetStatus`
   *  groups these flat entries by category. */
  status: (from: string, to: string) => Promise<BudgetStatusEntry[]>;
};

export const budgetsRepo = (db: Db): BudgetsRepo => ({
  list: async () => {
    const rows = await db.all<Record<string, unknown>>(sql`
      ${BUDGET_VIEW_SELECT}
      ORDER BY COALESCE(parent.name, node.name), node.name
    `);
    return rows.map(budgetAdapters.dbToView);
  },

  findByTarget: async (categoryId, currency, period) => {
    const [row] = await db
      .select({ id: budgets.id })
      .from(budgets)
      .where(and(eq(budgets.categoryId, categoryId), eq(budgets.currency, currency), eq(budgets.period, period)))
      .limit(1);
    return row !== undefined;
  },

  findById: async (id) => {
    const [row] = await db.select().from(budgets).where(eq(budgets.id, id)).limit(1);
    return row ? budgetAdapters.dbToEntity(row) : null;
  },

  status: async (from, to) => {
    const rows = await db.all<Record<string, unknown>>(BUDGET_STATUS_SELECT(from, to));
    return rows.map(budgetAdapters.dbToStatusEntry);
  },
});

const versionedBudgetApplier = versionedTableApplier(budgets);

/** `budgets` has the secondary `UNIQUE(category_id, currency, period)` beyond `createBudget`'s
 *  own pre-check (`findByTarget`, which only guards the common case) — a concurrent create of the
 *  same target races into a real `SQLITE_CONSTRAINT_UNIQUE` the id-scoped `onConflictDoNothing`
 *  doesn't swallow. Recognized and rethrown as `VersionConflict`, rolling back and retrying — the
 *  retry's own `findByTarget` then sees the committed row and returns `duplicate_budget` instead of
 *  a raw 500. Structurally identical to `tagApplier`/`billApplier` (`update`/`delete` stay plain —
 *  neither touches the target/currency/period key). */
export const budgetApplier: EntityApplier = {
  ...versionedBudgetApplier,
  insert: async (tx, model) => {
    try {
      return await versionedBudgetApplier.insert(tx, model);
    } catch (cause) {
      if (isUniqueConstraintViolation(cause)) throw new VersionConflict();
      throw cause;
    }
  },
};
