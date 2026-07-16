import { sql } from 'drizzle-orm';
import * as recurringAdapters from '../../../adapters/recurring.js';
import type { RecurringRuleEntity, RecurringRuleView } from '../../../models/recurring.js';
import type { Db } from '../driver.js';
import { recurringRules } from '../schema.js';
import { versionedTableApplier, type EntityApplier } from '../unitOfWork.js';

const RULE_SELECT = sql`
  SELECT r.*, a.name AS account_name, c.name AS category_name
  FROM recurring_rules r
  LEFT JOIN accounts a ON a.id = r.account_id
  LEFT JOIN categories c ON c.id = r.category_id
`;

export type RecurringRepo = {
  list: () => Promise<RecurringRuleView[]>;
  /** Version-carrying — callers build a version-guarded `Persistable` update from it, never write directly. */
  due: (onOrBefore: string) => Promise<RecurringRuleEntity[]>;
};

export const recurringRepo = (db: Db): RecurringRepo => ({
  list: async () => {
    const rows = await db.all<Record<string, unknown>>(sql`
      ${RULE_SELECT} ORDER BY r.next_due
    `);
    return rows.map(recurringAdapters.dbToModel);
  },

  due: async (onOrBefore) => {
    const rows = await db.all<Record<string, unknown>>(sql`
      ${RULE_SELECT} WHERE r.next_due <= ${onOrBefore} ORDER BY r.next_due
    `);
    return rows.map(recurringAdapters.dbToEntity);
  },
});

/**
 * The recurring-rule entity's `EntityApplier` (ADR-021) — plain `versionedTableApplier`, no
 * mechanics beyond the ordinary `id`/`version` convention (mirrors `accountApplier`): the row shape
 * (`adapters/recurring.ts`'s `modelToDb`) already matches the `recurring_rules` table 1:1.
 * Registered under `models/recurring.ts`'s `RECURRING_ENTITY_TAG` at the composition root
 * (`main.ts`).
 */
export const recurringRuleApplier: EntityApplier = versionedTableApplier(recurringRules);
