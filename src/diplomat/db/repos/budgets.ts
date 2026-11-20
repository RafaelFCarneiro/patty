import { and, eq, sql } from 'drizzle-orm';
import * as budgetAdapters from '../../../adapters/budgets.js';
import type { BudgetEntity, BudgetPeriod } from '../../../models/budget.js';
import type { CurrencyCode } from '../../../models/money.js';
import { BudgetViewRowSchema, type BudgetViewRow } from '../../../wire/db/budgets.js';
import type { Db } from '../driver.js';
import { budgets } from '../schema.js';
import { ownedTableApplier, uniqueViolationAsConflict, type EntityApplier } from '../effects.js';
import { ownedBy, ownedWhere } from '../queries/scope.js';

// Budgets target either a top-level category or a sub-category — both rows in `categories` — so
// the display projection always joins the node plus its (possibly absent) parent. Mirrors
// `subCategoriesRepo`'s `SUB_SELECT` (`diplomat/db/repos/sub-categories.ts`): a hand-written raw
// join, not the query builder, for the same self-referencing-table reason. `node.names`/
// `parent.names` travel alongside the raw names so the repo itself never has to decide a locale.
// `node.id` (== `b.category_id`) travels too as `target_id`, needed to match spend against it in
// `logic/budget.ts` now that this repo no longer joins `transactions` (ADR-028).
const BUDGET_VIEW_SELECT = (userId: string) => sql`
  SELECT b.id, b.currency, b.limit_amount, b.period, b.version, node.id AS target_id,
         node.name AS node_name, node.names AS node_names, node.parent_id AS node_parent_id,
         parent.name AS parent_name, parent.names AS parent_names
  FROM budgets b
  JOIN categories node ON node.id = b.category_id
  LEFT JOIN categories parent ON parent.id = node.parent_id
  WHERE ${ownedBy(userId, 'b')}
`;

export type BudgetsRepo = {
  /** Budgets only — no spend. Correlating a budget to its transactions is orchestration, not a
   *  repo join (ADR-028). */
  list: () => Promise<BudgetViewRow[]>;
  /** Existence check for the `(category_id, currency, period)` duplicate guard in `createBudget`. */
  findByTarget: (categoryId: string, currency: CurrencyCode, period: BudgetPeriod) => Promise<boolean>;
  /** Version-carrying read — for `updateBudget`/`deleteBudget`, which need it to build a
   *  version-guarded `Persistable`. */
  findById: (id: string) => Promise<BudgetEntity | null>;
};

export const budgetsRepo = (db: Db, userId: string): BudgetsRepo => ({
  list: async () => {
    const rows = await db.all<Record<string, unknown>>(sql`
      ${BUDGET_VIEW_SELECT(userId)}
      ORDER BY COALESCE(parent.name, node.name), node.name
    `);
    return rows.map((r) => BudgetViewRowSchema.parse(r));
  },

  findByTarget: async (categoryId, currency, period) => {
    const [row] = await db
      .select({ id: budgets.id })
      .from(budgets)
      .where(
        ownedWhere(
          budgets.userId,
          userId,
          and(eq(budgets.categoryId, categoryId), eq(budgets.currency, currency), eq(budgets.period, period)),
        ),
      )
      .limit(1);
    return row !== undefined;
  },

  findById: async (id) => {
    const [row] = await db
      .select()
      .from(budgets)
      .where(ownedWhere(budgets.userId, userId, eq(budgets.id, id)))
      .limit(1);
    return row ? budgetAdapters.dbToEntity(row) : null;
  },
});

// UNIQUE(user_id, category_id, currency, period): a concurrent create of one budget target.
export const budgetApplier = (userId: string): EntityApplier =>
  uniqueViolationAsConflict(ownedTableApplier(budgets, userId));
