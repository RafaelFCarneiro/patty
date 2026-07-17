import { sql } from 'drizzle-orm';
import * as recurringAdapters from '../../../adapters/recurring.js';
import type { RecurringRuleEntity, RecurringRuleView } from '../../../models/recurring.js';
import type { Db } from '../driver.js';
import { recurringRules } from '../schema.js';
import { versionedTableApplier, type EntityApplier } from '../unitOfWork.js';

const RULE_FROM = sql`FROM recurring_rules r`;

const RULE_SELECT_BARE = sql`SELECT r.*, NULL AS account_name, NULL AS category_name ${RULE_FROM}`;

const RULE_SELECT = sql`
  SELECT r.*, a.name AS account_name, c.name AS category_name
  ${RULE_FROM}
  LEFT JOIN accounts a ON a.id = r.account_id
  LEFT JOIN categories c ON c.id = r.category_id
`;

export type RecurringRepo = {
  list: () => Promise<RecurringRuleView[]>;
  /** Version-carrying, for building a version-guarded `Persistable` update. */
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
      ${RULE_SELECT_BARE} WHERE r.next_due <= ${onOrBefore} ORDER BY r.next_due
    `);
    return rows.map(recurringAdapters.dbToEntity);
  },
});

export const recurringRuleApplier: EntityApplier = versionedTableApplier(recurringRules);
