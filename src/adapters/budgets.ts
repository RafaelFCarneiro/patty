import {
  BUDGET_ENTITY_TAG,
  BudgetEntitySchema,
  BudgetSchema,
  type Budget,
  type BudgetEntity,
} from '../models/budget.js';
import * as persistence from '../logic/persistence.js';
import type { BudgetRow } from '../wire/db/budgets.js';

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
