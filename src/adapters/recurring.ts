import { RECURRING_ENTITY_TAG, type CreateRecurring, type RecurringRuleEntity } from '../models/recurring.js';
import * as persistence from '../logic/persistence.js';
import type { RecurringRuleRow } from '../wire/db/recurring.js';
import type * as wireIn from '../wire/in/recurring.js';

export const wireInToModel = (input: wireIn.CreateRecurring): CreateRecurring => input;

/** Entity → row for the versioned unit of work (ADR-021) — the only recurring-rule write path that
 *  needs `version` on the wire-db row. */
export const modelToDb = (entity: RecurringRuleEntity): RecurringRuleRow => ({
  id: entity.id,
  description: entity.description,
  amount: entity.amount,
  type: entity.type,
  period: entity.period,
  nextDue: entity.nextDue,
  currency: entity.currency,
  accountId: entity.accountId ?? null,
  categoryId: entity.categoryId ?? null,
  version: entity.version,
});

export const { persistableToDb, outcomeToDb } = persistence.entityDbAdapter(RECURRING_ENTITY_TAG, modelToDb);
