import { eq, sql } from 'drizzle-orm';
import { expectPresent, rowNotFoundAfterWrite } from '../present.js';
import {
  RecurringRuleEntitySchema,
  RecurringRuleViewSchema,
  type RecurringRuleEntity,
  type RecurringRuleView,
} from '../../../models/recurring.js';
import { RecurringRowSchema } from '../../../wire/db/recurring.js';
import type { Db } from '../driver.js';
import { recurringRules } from '../schema.js';
import { versionedTableApplier, type EntityApplier } from '../unitOfWork.js';

const toRule = (record: Record<string, unknown>): RecurringRuleView => {
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
  });
};

/** Read variant carrying `version`, no joined display names — a due rule is never displayed, only
 *  used to build a version-guarded `Persistable`. Mirrors `adapters/accounts.ts`'s `dbToEntity`. */
const toEntity = (record: Record<string, unknown>): RecurringRuleEntity => {
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
    version: row.version,
  });
};

const RULE_SELECT = sql`
  SELECT r.*, a.name AS account_name, c.name AS category_name
  FROM recurring_rules r
  LEFT JOIN accounts a ON a.id = r.account_id
  LEFT JOIN categories c ON c.id = r.category_id
`;

export type RecurringRepo = {
  /** No current caller — kept until phase 3d removes it. */
  create: (
    rule: {
      id: string;
      description: string;
      amount: number;
      type: string;
      period: string;
      nextDue: string;
      currency: string;
    },
    refs: { accountId: string | null; categoryId: string | null },
  ) => Promise<RecurringRuleView>;
  list: () => Promise<RecurringRuleView[]>;
  /** Version-carrying — callers build a version-guarded `Persistable` update from it, never write directly. */
  due: (onOrBefore: string) => Promise<RecurringRuleEntity[]>;
  /** No current caller — kept until phase 3d removes it. */
  advance: (ruleId: string, newNextDue: string) => Promise<void>;
};

export const recurringRepo = (db: Db): RecurringRepo => ({
  create: async (rule, refs) => {
    await db.insert(recurringRules).values({
      id: rule.id,
      description: rule.description,
      amount: rule.amount,
      type: rule.type as 'income' | 'expense',
      period: rule.period as 'monthly' | 'weekly',
      nextDue: rule.nextDue,
      currency: rule.currency,
      accountId: refs.accountId ?? null,
      categoryId: refs.categoryId ?? null,
    });
    const [row] = await db.all<Record<string, unknown>>(sql`
      ${RULE_SELECT} WHERE r.id = ${rule.id}
    `);
    return toRule(expectPresent(row, rowNotFoundAfterWrite('recurring_rules', 'insert')));
  },

  list: async () => {
    const rows = await db.all<Record<string, unknown>>(sql`
      ${RULE_SELECT} ORDER BY r.next_due
    `);
    return rows.map(toRule);
  },

  due: async (onOrBefore) => {
    const rows = await db.all<Record<string, unknown>>(sql`
      ${RULE_SELECT} WHERE r.next_due <= ${onOrBefore} ORDER BY r.next_due
    `);
    return rows.map(toEntity);
  },

  advance: async (ruleId, newNextDue) => {
    await db.update(recurringRules).set({ nextDue: newNextDue }).where(eq(recurringRules.id, ruleId));
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
