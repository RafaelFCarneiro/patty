import { eq, sql } from 'drizzle-orm'
import * as accountAdapters from '../../../adapters/accounts.js'
import { expectPresent } from '../../../common/present.js'
import type { Account, AccountType } from '../../../models/account.js'
import type { CurrencyCode } from '../../../models/common.js'
import { TransactionStatus, TransactionType } from '../../../models/transaction.js'
import { BalancePartsRow } from '../../../wire/db/accounts.js'
import type { Db } from '../driver.js'
import { accounts, creditCards, recurringRules, transactions } from '../schema.js'

export type AccountReferences = { transactions: number; recurring: number; cards: number }

export type AccountPatch = {
  name?: string
  initialBalance?: number
  type?: AccountType
  currency?: CurrencyCode
}

export type AccountsRepo = {
  list: () => Promise<Account[]>
  create: (account: Account) => Promise<Account>
  findById: (id: string) => Promise<Account | null>
  findByName: (name: string) => Promise<Account | null>
  /** Aggregated movement per account: transactions + transfers, both directions. */
  balanceParts: (accountId: string) => Promise<BalancePartsRow>
  countReferences: (accountId: string) => Promise<AccountReferences>
  delete: (accountId: string) => Promise<void>
  update: (accountId: string, patch: AccountPatch) => Promise<Account>
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

  findById: async (id) => {
    const rows = await db
      .select()
      .from(accounts)
      .where(sql`${accounts.id} = ${id}`)
      .limit(1)
    return rows[0] ? accountAdapters.dbToModel(rows[0]) : null
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

  countReferences: async (accountId) => {
    const [txRow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(transactions)
      .where(sql`${transactions.fromAccountId} = ${accountId} OR ${transactions.toAccountId} = ${accountId}`)
    const [recRow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(recurringRules)
      .where(eq(recurringRules.accountId, accountId))
    const [cardRow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(creditCards)
      .where(eq(creditCards.paymentAccountId, accountId))
    return {
      transactions: txRow?.count ?? 0,
      recurring: recRow?.count ?? 0,
      cards: cardRow?.count ?? 0,
    }
  },

  delete: async (accountId) => {
    await db.delete(accounts).where(eq(accounts.id, accountId))
  },

  update: async (accountId, patch) => {
    const values: Record<string, unknown> = {}
    if (patch.name !== undefined) values.name = patch.name
    if (patch.initialBalance !== undefined) values.initialBalance = patch.initialBalance
    if (patch.type !== undefined) values.type = patch.type
    if (patch.currency !== undefined) values.currency = patch.currency
    const [row] = await db
      .update(accounts)
      .set(values)
      .where(eq(accounts.id, accountId))
      .returning()
    return accountAdapters.dbToModel(expectPresent(row, 'accounts: row not found after update'))
  },
})
