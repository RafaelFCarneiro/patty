import { sql } from 'drizzle-orm'
import { expectPresent } from '../../../common/present.js'
import { CreditCard } from '../../../models/creditCard.js'
import type { Db } from '../driver.js'
import { creditCards } from '../schema.js'

const toCard = (record: Record<string, unknown>): CreditCard =>
  CreditCard.parse({
    id:         record['id'],
    name:       record['name'],
    currency:   record['currency'],
    closingDay: record['closingDay'] ?? record['closing_day'],
    dueDay:     record['dueDay'] ?? record['due_day'],
    limit:      record['limitAmount'] ?? record['limit_amount'] ?? undefined,
  })

export type CreditCardsRepo = {
  list: () => Promise<CreditCard[]>
  create: (card: CreditCard) => Promise<CreditCard>
  findByName: (name: string) => Promise<CreditCard | null>
}

export const creditCardsRepo = (db: Db): CreditCardsRepo => ({
  list: async () => {
    const rows = await db.select().from(creditCards).orderBy(creditCards.name)
    return rows.map(toCard)
  },

  create: async (card) => {
    const [row] = await db
      .insert(creditCards)
      .values({
        id:          card.id,
        name:        card.name,
        currency:    card.currency,
        closingDay:  card.closingDay,
        dueDay:      card.dueDay,
        limitAmount: card.limit ?? null,
      })
      .returning()
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
})
