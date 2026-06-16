import { eq, sql } from 'drizzle-orm'
import * as transactionAdapters from '../../../adapters/transactions.js'
import { Bill } from '../../../models/bill.js'
import type { TransactionView } from '../../../models/transaction.js'
import type { BillPeriod } from '../../../logic/bill.js'
import type { Db } from '../driver.js'
import { bills, transactions } from '../schema.js'

const toBill = (record: Record<string, unknown>): Bill =>
  Bill.parse({
    id:        record['id'],
    month:     record['month'],
    year:      record['year'],
    closeDate: record['close_date'],
    dueDate:   record['due_date'],
    status:    record['status'],
  })

export type BillWithItems = { bill: Bill; cardName: string; transactions: TransactionView[] }

export type BillsRepo = {
  /** UPSERT the cycle's bill for a card (created open) and attach the transaction. */
  ensureAndAttach: (cardId: string, transactionId: string, period: BillPeriod, newId: string) => Promise<Bill>
  get: (cardId: string, month: number, year: number) => Promise<BillWithItems | null>
  setStatus: (billId: string, status: 'open' | 'closed' | 'paid') => Promise<Bill | null>
}

const FULL_TX = sql`
  SELECT t.*,
    fa.name AS from_account_name, ta.name AS to_account_name,
    cc2.name AS credit_card_name,
    c.name AS category_name, sc.name AS subcategory_name,
    json_group_array(tg.name) FILTER (WHERE tg.name IS NOT NULL) AS tags
  FROM transactions t
  LEFT JOIN accounts fa   ON fa.id  = t.from_account_id
  LEFT JOIN accounts ta   ON ta.id  = t.to_account_id
  LEFT JOIN credit_cards cc2 ON cc2.id = t.credit_card_id
  LEFT JOIN categories c  ON c.id   = t.category_id
  LEFT JOIN categories sc ON sc.id  = t.subcategory_id
  LEFT JOIN transaction_tags tt ON tt.transaction_id = t.id
  LEFT JOIN tags tg ON tg.id = tt.tag_id
`

export const billsRepo = (db: Db): BillsRepo => ({
  ensureAndAttach: async (cardId, transactionId, period, newId) => {
    await db.insert(bills).values({
      id:           newId,
      creditCardId: cardId,
      month:        period.month,
      year:         period.year,
      closeDate:    period.closeDate,
      dueDate:      period.dueDate,
      status:       'open',
    }).onConflictDoNothing()

    // Resolve the bill id (may have been the pre-existing one)
    const [bill] = await db.all<Record<string, unknown>>(sql`
      SELECT * FROM bills WHERE credit_card_id = ${cardId} AND month = ${period.month} AND year = ${period.year}
    `)
    const billId = bill!['id'] as string

    // Link the transaction to the bill
    await db.update(transactions).set({ billId }).where(eq(transactions.id, transactionId))

    return toBill(bill!)
  },

  get: async (cardId, month, year) => {
    const [billRow] = await db.all<Record<string, unknown>>(sql`
      SELECT b.*, cc.name AS card_name
      FROM bills b JOIN credit_cards cc ON cc.id = b.credit_card_id
      WHERE b.credit_card_id = ${cardId} AND b.month = ${month} AND b.year = ${year}
    `)
    if (!billRow) return null

    const txRows = await db.all<Record<string, unknown>>(sql`
      ${FULL_TX}
      WHERE t.bill_id = ${billRow['id']}
      GROUP BY t.id
      ORDER BY t.date
    `)
    return {
      bill:         toBill(billRow),
      cardName:     billRow['card_name'] as string,
      transactions: txRows.map(transactionAdapters.dbToModel),
    }
  },

  setStatus: async (billId, status) => {
    await db.update(bills).set({ status }).where(eq(bills.id, billId))
    const [row] = await db.all<Record<string, unknown>>(sql`SELECT * FROM bills WHERE id = ${billId}`)
    return row ? toBill(row) : null
  },
})
