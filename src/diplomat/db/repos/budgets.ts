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

/** For a period `[from, to)` (Feature Design 015 phase 2): each budget's spend, joined against
 *  transactions that are `effective`, **`expense`-typed** (never `income` or `transfer`),
 *  same-currency as the budget, dated in range, and matched to the target the same way `status`'s
 *  own JOIN condition below decides. Deliberately `type = expense`, not just `!= transfer`: a
 *  budget can target a `both`-kind category (`isExpenseEligible`, `logic/budget.ts` — only pure
 *  `income`-kind is rejected), and `aggregate`/`summaryRows` (this same repo file's siblings) keep
 *  `type` as an explicit output dimension for their own caller/shaping layer to separate income
 *  from expense — `spent` here is a single collapsed scalar with no such dimension, so the filter
 *  has to make the expense-only cut itself, or an income transaction booked to a `both`-kind
 *  category would inflate a spending cap. `COALESCE(SUM(t.amount), 0)` is what makes an empty
 *  month `spent: 0` rather than a missing row (the LEFT JOIN still yields one row per budget with
 *  no match). `node.parent_id IS NULL` (a top-level target) matches on `t.category_id` — which
 *  rolls up sub-category spend for free, since a sub-category transaction's `category_id` is
 *  always set to its parent — while a sub-category target matches only `t.subcategory_id`, its own
 *  spend alone (and independently of the parent's own condition, so the same transaction counts
 *  toward both a sub-category's budget and its parent's, when both exist). */
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
    AND (
      (node.parent_id IS NULL AND t.category_id = b.category_id)
      OR (node.parent_id IS NOT NULL AND t.subcategory_id = b.category_id)
    )
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
