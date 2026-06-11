import type { Driver } from 'neo4j-driver'
import { RecurringRule } from '../../../models/recurring.js'
import { run } from '../driver.js'

type NodeLike = { properties: Record<string, unknown> }

const toRule = (record: Record<string, unknown>): RecurringRule =>
  RecurringRule.parse({
    ...(record['r'] as NodeLike).properties,
    accountId: record['accountId'] ?? undefined,
    accountName: record['accountName'] ?? undefined,
    categoryId: record['categoryId'] ?? undefined,
    categoryName: record['categoryName'] ?? undefined,
  })

const RETURN_RULE = `
  RETURN r, a.id AS accountId, a.name AS accountName, c.id AS categoryId, c.name AS categoryName`

export type RecurringRepo = {
  create: (
    rule: { id: string; description: string; amount: number; type: string; period: string; nextDue: string; currency: string },
    refs: { accountId: string | null; categoryId: string | null },
  ) => Promise<RecurringRule>
  list: () => Promise<RecurringRule[]>
  due: (onOrBefore: string) => Promise<RecurringRule[]>
  advance: (ruleId: string, newNextDue: string) => Promise<void>
}

export const recurringRepo = (driver: Driver): RecurringRepo => ({
  create: async (rule, refs) => {
    const rows = await run(
      driver,
      `CREATE (r:RecurringRule {id: $id, description: $description, amount: $amount,
              type: $type, period: $period, nextDue: $nextDue, currency: $currency})
       WITH r
       OPTIONAL MATCH (acc:Account {id: $accountId})
       FOREACH (_ IN CASE WHEN acc IS NOT NULL THEN [1] ELSE [] END | MERGE (r)-[:FROM]->(acc))
       WITH r
       OPTIONAL MATCH (cat:Category {id: $categoryId})
       FOREACH (_ IN CASE WHEN cat IS NOT NULL THEN [1] ELSE [] END | MERGE (r)-[:IN]->(cat))
       WITH r
       OPTIONAL MATCH (r)-[:FROM]->(a:Account)
       OPTIONAL MATCH (r)-[:IN]->(c:Category)
       ${RETURN_RULE}`,
      { ...rule, ...refs },
    )
    return toRule(rows[0]!)
  },

  list: async () => {
    const rows = await run(
      driver,
      `MATCH (r:RecurringRule)
       OPTIONAL MATCH (r)-[:FROM]->(a:Account)
       OPTIONAL MATCH (r)-[:IN]->(c:Category)
       ${RETURN_RULE}
       ORDER BY r.nextDue`,
    )
    return rows.map(toRule)
  },

  due: async (onOrBefore) => {
    const rows = await run(
      driver,
      `MATCH (r:RecurringRule) WHERE r.nextDue <= $onOrBefore
       OPTIONAL MATCH (r)-[:FROM]->(a:Account)
       OPTIONAL MATCH (r)-[:IN]->(c:Category)
       ${RETURN_RULE}
       ORDER BY r.nextDue`,
      { onOrBefore },
    )
    return rows.map(toRule)
  },

  advance: async (ruleId, newNextDue) => {
    await run(driver, 'MATCH (r:RecurringRule {id: $ruleId}) SET r.nextDue = $newNextDue', {
      ruleId,
      newNextDue,
    })
  },
})
