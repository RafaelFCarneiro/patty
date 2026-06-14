import type { Driver } from 'neo4j-driver'
import * as accountAdapters from '../../../adapters/accounts.js'
import type { Account } from '../../../models/account.js'
import { BalancePartsRow } from '../../../wire/db/accounts.js'
import { run } from '../driver.js'


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
    return rows.map(accountAdapters.dbToModel)
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
    return accountAdapters.dbToModel(rows[0]!)
  },

  findByName: async (name) => {
    const rows = await run(
      driver,
      `MATCH (a:Account)-[:DENOMINATED_IN]->(cur:Currency)
       WHERE toLower(a.name) = toLower($name)
       RETURN a, cur.code AS currency LIMIT 1`,
      { name },
    )
    return rows[0] ? accountAdapters.dbToModel(rows[0]) : null
  },

  balanceParts: async (accountId) => {
    // Single structure: outflow via [:FROM] (expense | transfer), inflow via income + [:TO]
    const rows = await run(
      driver,
      `MATCH (a:Account {id: $accountId})
       OPTIONAL MATCH (t:Transaction)-[:FROM]->(a)
       WITH a,
            sum(CASE WHEN t.type = 'income' THEN t.amount ELSE 0 END) AS income,
            sum(CASE WHEN t.type = 'expense' THEN t.amount ELSE 0 END) AS expenses,
            sum(CASE WHEN t.type = 'transfer' THEN t.amount ELSE 0 END) AS transfersOut
       OPTIONAL MATCH (tin:Transaction {type: 'transfer'})-[:TO]->(a)
       RETURN income, expenses, transfersOut, sum(coalesce(tin.amount, 0)) AS transfersIn`,
      { accountId },
    )
    return BalancePartsRow.parse(rows[0] ?? { income: 0, expenses: 0, transfersIn: 0, transfersOut: 0 })
  },
})
