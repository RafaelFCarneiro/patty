import type { Driver } from 'neo4j-driver'
import { z } from 'zod'
import { toAccount } from '../../../adapters/records.js'
import type { Account } from '../../../models/account.js'
import { run } from '../driver.js'

const BalancePartsRow = z.object({
  income: z.number(),
  expenses: z.number(),
  transfersIn: z.number(),
  transfersOut: z.number(),
})
export type BalancePartsRow = z.infer<typeof BalancePartsRow>

export type AccountsRepo = {
  list: () => Promise<Account[]>
  create: (account: Account) => Promise<Account>
  findByName: (name: string) => Promise<Account | null>
  /** Aggregated movement per account: transactions + transfers, both directions. */
  balanceParts: (accountId: string) => Promise<BalancePartsRow>
}

export const accountsRepo = (driver: Driver): AccountsRepo => ({
  list: async () => {
    const rows = await run(
      driver,
      `MATCH (a:Account)-[:DENOMINATED_IN]->(cur:Currency)
       RETURN a, cur.code AS currency ORDER BY a.name`,
    )
    return rows.map(toAccount)
  },

  create: async (account) => {
    const rows = await run(
      driver,
      `MATCH (cur:Currency {code: $currency})
       CREATE (a:Account {id: $id, name: $name, type: $type, initialBalance: $initialBalance})
       MERGE (a)-[:DENOMINATED_IN]->(cur)
       RETURN a, cur.code AS currency`,
      { ...account },
    )
    return toAccount(rows[0]!)
  },

  findByName: async (name) => {
    const rows = await run(
      driver,
      `MATCH (a:Account)-[:DENOMINATED_IN]->(cur:Currency)
       WHERE toLower(a.name) = toLower($name)
       RETURN a, cur.code AS currency LIMIT 1`,
      { name },
    )
    return rows[0] ? toAccount(rows[0]) : null
  },

  balanceParts: async (accountId) => {
    // Sequential aggregation (one WITH per pattern) avoids row-multiplication
    const rows = await run(
      driver,
      `MATCH (a:Account {id: $accountId})
       OPTIONAL MATCH (t:Transaction)-[:FROM]->(a)
       WITH a,
            sum(CASE WHEN t.type = 'income' THEN t.amount ELSE 0 END) AS income,
            sum(CASE WHEN t.type = 'expense' THEN t.amount ELSE 0 END) AS expenses
       OPTIONAL MATCH (tout:Transfer)-[:FROM]->(a)
       WITH a, income, expenses, sum(coalesce(tout.amount, 0)) AS transfersOut
       OPTIONAL MATCH (tin:Transfer)-[:TO]->(a)
       RETURN income, expenses, transfersOut, sum(coalesce(tin.amount, 0)) AS transfersIn`,
      { accountId },
    )
    return BalancePartsRow.parse(rows[0] ?? { income: 0, expenses: 0, transfersIn: 0, transfersOut: 0 })
  },
})
