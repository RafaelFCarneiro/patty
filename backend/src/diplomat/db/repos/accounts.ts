import type { Driver } from 'neo4j-driver'
import { toAccount } from '../../../adapters/records.js'
import type { Account } from '../../../models/account.js'
import { run } from '../driver.js'

export type AccountsRepo = {
  list: () => Promise<Account[]>
  create: (account: Account) => Promise<Account>
  findByName: (name: string) => Promise<Account | null>
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
       CREATE (a:Account {id: $id, name: $name, type: $type})
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
})
