import {
  BUDGET_ENTITY_TAG,
  BudgetEntitySchema,
  BudgetSchema,
  BudgetStatusEntrySchema,
  BudgetViewSchema,
  type Budget,
  type BudgetEntity,
  type BudgetStatusEntry,
  type BudgetView,
} from '../models/budget.js';
import * as persistence from '../logic/persistence.js';
import { BudgetStatusRowSchema, BudgetViewRowSchema, type BudgetRow } from '../wire/db/budgets.js';

export const dbToModel = (row: BudgetRow): Budget =>
  BudgetSchema.parse({
    id: row.id,
    categoryId: row.categoryId,
    currency: row.currency,
    limit: row.limitAmount,
    period: row.period,
  });

/** Read variant carrying `version` — for `updateBudget`/`deleteBudget`, which need it to build a
 *  version-guarded `Persistable`. */
export const dbToEntity = (row: BudgetRow): BudgetEntity =>
  BudgetEntitySchema.parse({
    id: row.id,
    categoryId: row.categoryId,
    currency: row.currency,
    limit: row.limitAmount,
    period: row.period,
    version: row.version,
  });

/** From the raw target-joined SELECT (`diplomat/db/repos/budgets.ts`) — the display projection
 *  actually returned to callers (never the internal `categoryId`). */
export const dbToView = (record: Record<string, unknown>): BudgetView => {
  const row = BudgetViewRowSchema.parse(record);
  const isSubCategory = row.node_parent_id !== null;
  return BudgetViewSchema.parse({
    id: row.id,
    currency: row.currency,
    limit: row.limit_amount,
    period: row.period,
    category: isSubCategory ? row.parent_name : row.node_name,
    subCategory: isSubCategory ? row.node_name : undefined,
  });
};

/** From the raw target-joined + spend-summed SELECT (`diplomat/db/repos/budgets.ts`'s `status`
 *  query) — the flat, ungrouped entry `logic/budget.ts`'s `groupStatusByCategory` reshapes. */
export const dbToStatusEntry = (record: Record<string, unknown>): BudgetStatusEntry => {
  const row = BudgetStatusRowSchema.parse(record);
  const isSubCategory = row.node_parent_id !== null;
  return BudgetStatusEntrySchema.parse({
    id: row.id,
    currency: row.currency,
    limit: row.limit_amount,
    period: row.period,
    category: isSubCategory ? row.parent_name : row.node_name,
    subCategory: isSubCategory ? row.node_name : undefined,
    spent: row.spent,
  });
};

/** Entity → row for the versioned unit of work — the one field rename (`limit` → `limitAmount`). */
export const modelToDb = (entity: BudgetEntity): BudgetRow => ({
  id: entity.id,
  categoryId: entity.categoryId,
  currency: entity.currency,
  limitAmount: entity.limit,
  period: entity.period,
  version: entity.version,
});

export const { persistableToDb, outcomeToDb } = persistence.entityDbAdapter(BUDGET_ENTITY_TAG, modelToDb);
