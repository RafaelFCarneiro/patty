import { eq, sql } from 'drizzle-orm'
import { expectPresent } from '../../../common/present.js'
import { RecurringRuleViewSchema } from '../../../models/recurring.js'
import type { RecurringRuleView } from '../../../models/recurring.js'
import { RecurringRowSchema } from '../../../wire/db/recurring.js'
import type { Db } from '../driver.js'
import { recurringRules } from '../schema.js'

const toRule = (record: Record<string, unknown>): RecurringRuleView => {
  const row = RecurringRowSchema.parse(record)
  return RecurringRuleViewSchema.parse({
    id:           row.id,
    description:  row.description,
    amount:       row.amount,
    type:         row.type,
    period:       row.period,
    nextDue:      row.next_due,
    currency:     row.currency,
    accountId:    row.account_id    ?? undefined,
    accountName:  row.account_name  ?? undefined,
    categoryId:   row.category_id   ?? undefined,
    categoryName: row.category_name ?? undefined,
  })
}

const RULE_SELECT = sql`
  SELECT r.*, a.name AS account_name, c.name AS category_name
  FROM recurring_rules r
  LEFT JOIN accounts a ON a.id = r.account_id
  LEFT JOIN categories c ON c.id = r.category_id
`

export type RecurringRepo = {
  create: (
    rule: { id: string; description: string; amount: number; type: string; period: string; nextDue: string; currency: string },
    refs: { accountId: string | null; categoryId: string | null },
  ) => Promise<RecurringRuleView>
  list: () => Promise<RecurringRuleView[]>
  due: (onOrBefore: string) => Promise<RecurringRuleView[]>
  advance: (ruleId: string, newNextDue: string) => Promise<void>
}

export const recurringRepo = (db: Db): RecurringRepo => ({
  create: async (rule, refs) => {
    await db.insert(recurringRules).values({
      id:          rule.id,
      description: rule.description,
      amount:      rule.amount,
      type:        rule.type as 'income' | 'expense',
      period:      rule.period as 'monthly' | 'weekly',
      nextDue:     rule.nextDue,
      currency:    rule.currency,
      accountId:   refs.accountId  ?? null,
      categoryId:  refs.categoryId ?? null,
    })
    const [row] = await db.all<Record<string, unknown>>(sql`
      ${RULE_SELECT} WHERE r.id = ${rule.id}
    `)
    return toRule(expectPresent(row, 'recurring_rules: row not found after insert'))
  },

  list: async () => {
    const rows = await db.all<Record<string, unknown>>(sql`
      ${RULE_SELECT} ORDER BY r.next_due
    `)
    return rows.map(toRule)
  },

  due: async (onOrBefore) => {
    const rows = await db.all<Record<string, unknown>>(sql`
      ${RULE_SELECT} WHERE r.next_due <= ${onOrBefore} ORDER BY r.next_due
    `)
    return rows.map(toRule)
  },

  advance: async (ruleId, newNextDue) => {
    await db.update(recurringRules).set({ nextDue: newNextDue }).where(eq(recurringRules.id, ruleId))
  },
})
