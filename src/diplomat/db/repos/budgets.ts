import { and, eq, sql } from 'drizzle-orm';
import * as budgetAdapters from '../../../adapters/budgets.js';
import type { BudgetEntity, BudgetPeriod } from '../../../models/budget.js';
import type { CurrencyCode } from '../../../models/money.js';
import { BudgetViewRowSchema, type BudgetViewRow } from '../../../wire/db/budgets.js';
import type { Db } from '../driver.js';
import { budgets } from '../schema.js';
import { isUniqueConstraintViolation } from '../sqliteErrors.js';
import { VersionConflict, versionedTableApplier, type EntityApplier } from '../effects.js';

// Budgets target either a top-level category or a sub-category — both rows in `categories` — so
// the display projection always joins the node plus its (possibly absent) parent. Mirrors
// `subCategoriesRepo`'s `SUB_SELECT` (`diplomat/db/repos/subCategories.ts`): a hand-written raw
// join, not the query builder, for the same self-referencing-table reason. `node.names`/
// `parent.names` travel alongside the raw names so the repo itself never has to decide a locale.
// `node.id` (== `b.category_id`) travels too as `target_id`, needed to match spend against it in
// `logic/budget.ts` now that this repo no longer joins `transactions` (ADR-028).
const BUDGET_VIEW_SELECT = sql`
  SELECT b.id, b.currency, b.limit_amount, b.period, b.version, node.id AS target_id,
         node.name AS node_name, node.names AS node_names, node.parent_id AS node_parent_id,
         parent.name AS parent_name, parent.names AS parent_names
  FROM budgets b
  JOIN categories node ON node.id = b.category_id
  LEFT JOIN categories parent ON parent.id = node.parent_id
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

export const budgetsRepo = (db: Db): BudgetsRepo => ({
  list: async () => {
    const rows = await db.all<Record<string, unknown>>(sql`
      ${BUDGET_VIEW_SELECT}
      ORDER BY COALESCE(parent.name, node.name), node.name
    `);
    return rows.map((r) => BudgetViewRowSchema.parse(r));
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
