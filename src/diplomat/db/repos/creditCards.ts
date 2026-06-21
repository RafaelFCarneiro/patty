import { eq, sql } from 'drizzle-orm'
import { expectPresent } from '../../../common/present.js'
import type { Account } from '../../../models/account.js'
import { CreditCard } from '../../../models/creditCard.js'
import type { CreditCardRow } from '../../../wire/db/creditCards.js'
import type { Db } from '../driver.js'
import { accounts, bills, creditCards } from '../schema.js'

const toCard = (row: CreditCardRow): CreditCard =>
  CreditCard.parse({
    id:               row.id,
    name:             row.name,
    currency:         row.currency,
    closingDay:       row.closingDay,
    dueDay:           row.dueDay,
    limit:            row.limitAmount ?? undefined,
    accountId:        row.accountId,
    paymentAccountId: row.paymentAccountId ?? undefined,
  })

export type DeleteCardCounts = { transactions: number; bills: number }

export type CreditCardsRepo = {
  list: () => Promise<CreditCard[]>
  createWithAccount: (card: CreditCard, account: Account) => Promise<CreditCard>
  findByName: (name: string) => Promise<CreditCard | null>
  countCorrelated: (cardId: string, accountId: string) => Promise<DeleteCardCounts>
  deleteCard: (cardId: string, accountId: string) => Promise<void>
}

export const creditCardsRepo = (db: Db): CreditCardsRepo => ({
  list: async () => {
    const rows = await db.select().from(creditCards).orderBy(creditCards.name)
    return rows.map(toCard)
  },

  createWithAccount: async (card, account) => {
    const [row] = await db.transaction(async (tx) => {
      await tx.insert(accounts).values({
        id:             account.id,
        name:           account.name,
        type:           account.type,
        initialBalance: account.initialBalance,
        currency:       account.currency,
      })
      return tx
        .insert(creditCards)
        .values({
          id:               card.id,
          name:             card.name,
          currency:         card.currency,
          closingDay:       card.closingDay,
          dueDay:           card.dueDay,
          limitAmount:      card.limit ?? null,
          accountId:        card.accountId,
          paymentAccountId: card.paymentAccountId ?? null,
        })
        .returning()
    })
    return toCard(expectPresent(row, 'credit_cards: row not found after insert'))
  },

  findByName: async (name) => {
    const rows = await db
      .select()
      .from(creditCards)
      .where(sql`lower(${creditCards.name}) = lower(${name})`)
      .limit(1)
    return rows[0] ? toCard(rows[0]) : null
  },

  countCorrelated: async (cardId, accountId) => {
    const [txRow] = await db.all<{ count: number }>(sql`
      SELECT COUNT(*) as count FROM transactions
      WHERE credit_card_id = ${cardId}
        OR from_account_id = ${accountId}
        OR to_account_id = ${accountId}
    `)
    const [billRow] = await db.all<{ count: number }>(sql`
      SELECT COUNT(*) as count FROM bills WHERE credit_card_id = ${cardId}
    `)
    return { transactions: txRow?.count ?? 0, bills: billRow?.count ?? 0 }
  },

  deleteCard: async (cardId, accountId) => {
    await db.transaction(async (tx) => {
      // FK-safe order: tags → transactions → bills → card → account
      await tx.run(sql`
        DELETE FROM transaction_tags WHERE transaction_id IN (
          SELECT id FROM transactions
          WHERE credit_card_id = ${cardId}
            OR from_account_id = ${accountId}
            OR to_account_id = ${accountId}
        )
      `)
      await tx.run(sql`
        DELETE FROM transactions
        WHERE credit_card_id = ${cardId}
          OR from_account_id = ${accountId}
          OR to_account_id = ${accountId}
      `)
      await tx.delete(bills).where(eq(bills.creditCardId, cardId))
      await tx.delete(creditCards).where(eq(creditCards.id, cardId))
      await tx.delete(accounts).where(eq(accounts.id, accountId))
    })
  },
})
