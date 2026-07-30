import {
  RECURRING_ENTITY_TAG,
  RecurringRuleEntitySchema,
  RecurringRuleViewSchema,
  type CreateRecurring,
  type RecurringRuleEntity,
  type RecurringRuleView,
} from '../models/recurring.js';
import * as persistence from '../logic/persistence.js';
import { RecurringRowSchema, type RecurringRuleRow } from '../wire/db/recurring.js';
import type * as wireIn from '../wire/in/recurring.js';

export const wireInToModel = (input: wireIn.CreateRecurring): CreateRecurring => input;

export const dbToModel = (record: Record<string, unknown>): RecurringRuleView => {
  const row = RecurringRowSchema.parse(record);
  return RecurringRuleViewSchema.parse({
    id: row.id,
    description: row.description,
    amount: row.amount,
    type: row.type,
    period: row.period,
    nextDue: row.next_due,
    currency: row.currency,
    accountId: row.account_id ?? undefined,
    accountName: row.account_name ?? undefined,
    categoryId: row.category_id ?? undefined,
    categoryName: row.category_name ?? undefined,
    merchantKey: row.merchant_key ?? undefined,
  });
};

/** Read variant carrying `version`, no joined display names — a due rule is never displayed, only
 *  used to build a version-guarded `Persistable`. */
export const dbToEntity = (record: Record<string, unknown>): RecurringRuleEntity => {
  const row = RecurringRowSchema.parse(record);
  return RecurringRuleEntitySchema.parse({
    id: row.id,
    description: row.description,
    amount: row.amount,
    type: row.type,
    period: row.period,
    nextDue: row.next_due,
    currency: row.currency,
    accountId: row.account_id ?? undefined,
    categoryId: row.category_id ?? undefined,
    merchantKey: row.merchant_key ?? undefined,
    version: row.version,
  });
};

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
  merchantKey: entity.merchantKey ?? null,
  version: entity.version,
});

export const { persistableToDb, outcomeToDb } = persistence.entityDbAdapter(RECURRING_ENTITY_TAG, modelToDb);
