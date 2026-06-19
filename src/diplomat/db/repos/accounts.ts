import { sql } from 'drizzle-orm'
import * as accountAdapters from '../../../adapters/accounts.js'
import { expectPresent } from '../../../common/present.js'
import type { Account } from '../../../models/account.js'
import { TransactionStatus, TransactionType } from '../../../models/transaction.js'
import { BalancePartsRow } from '../../../wire/db/accounts.js'
import type { Db } from '../driver.js'
import { accounts } from '../schema.js'

export type AccountsRepo = {
  list: () => Promise<Account[]>
  create: (account: Account) => Promise<Account>
  findByName: (name: string) => Promise<Account | null>
  /** Aggregated movement per account: transactions + transfers, both directions. */
  balanceParts: (accountId: string) => Promise<BalancePartsRow>
}

export const accountsRepo = (db: Db): AccountsRepo => ({
  list: async () => {
    const rows = await db.select().from(accounts).orderBy(accounts.name)
    return rows.map(accountAdapters.dbToModel)
  },

  create: async (account) => {
    const [row] = await db
      .insert(accounts)
      .values({
        id:             account.id,
        name:           account.name,
        type:           account.type,
        initialBalance: account.initialBalance,
        currency:       account.currency,
      })
      .returning()
    return accountAdapters.dbToModel(expectPresent(row, 'accounts: row not found after insert'))
  },

  findByName: async (name) => {
    const rows = await db
      .select()
      .from(accounts)
      .where(sql`lower(${accounts.name}) = lower(${name})`)
      .limit(1)
    return rows[0] ? accountAdapters.dbToModel(rows[0]) : null
  },

  balanceParts: async (accountId) => {
    const [row] = await db.all<{
      income: number; expenses: number; transfers_out: number; transfers_in: number
    }>(sql`
      SELECT
        COALESCE(SUM(CASE WHEN t.type = ${TransactionType.enum.income}   THEN t.amount ELSE 0 END), 0) AS income,
        COALESCE(SUM(CASE WHEN t.type = ${TransactionType.enum.expense}  THEN t.amount ELSE 0 END), 0) AS expenses,
        COALESCE(SUM(CASE WHEN t.type = ${TransactionType.enum.transfer} THEN t.amount ELSE 0 END), 0) AS transfers_out,
        COALESCE((
          SELECT SUM(t2.amount) FROM transactions t2
          WHERE t2.to_account_id = ${accountId}
            AND t2.type = ${TransactionType.enum.transfer}
            AND t2.status = ${TransactionStatus.enum.effective}
        ), 0) AS transfers_in
      FROM transactions t
      WHERE t.from_account_id = ${accountId}
        AND t.status = ${TransactionStatus.enum.effective}
    `)
    return BalancePartsRow.parse({
      income:       row?.income        ?? 0,
      expenses:     row?.expenses      ?? 0,
      transfersIn:  row?.transfers_in  ?? 0,
      transfersOut: row?.transfers_out ?? 0,
    })
  },
})
