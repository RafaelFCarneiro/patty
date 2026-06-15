import type { Driver } from 'neo4j-driver'
import * as transactionAdapters from '../../../adapters/transactions.js'
import { Bill } from '../../../models/bill.js'
import type { TransactionView } from '../../../models/transaction.js'
import { computeBillTotal, type BillPeriod } from '../../../logic/bill.js'
import { run } from '../driver.js'

type NodeLike = { properties: Record<string, unknown> }

const toBill = (record: Record<string, unknown>): Bill => Bill.parse((record['b'] as NodeLike).properties)

export type BillWithItems = { bill: Bill; cardName: string; total: number; transactions: TransactionView[] }

export type BillsRepo = {
  /** MERGE the cycle's bill for a card (created open) and attach the transaction. */
  ensureAndAttach: (cardId: string, transactionId: string, period: BillPeriod, newId: string) => Promise<Bill>
  get: (cardId: string, month: number, year: number) => Promise<BillWithItems | null>
  setStatus: (billId: string, status: 'open' | 'closed' | 'paid') => Promise<Bill | null>
}

export const billsRepo = (driver: Driver): BillsRepo => ({
  ensureAndAttach: async (cardId, transactionId, period, newId) => {
    const rows = await run(
      driver,
      `MATCH (cc:CreditCard {id: $cardId})
       MERGE (cc)<-[:OF]-(b:Bill {month: $month, year: $year})
       ON CREATE SET b.id = $newId, b.closeDate = $closeDate, b.dueDate = $dueDate, b.status = 'open'
       WITH b
       MATCH (t:Transaction {id: $transactionId})
       MERGE (b)-[:CONTAINS]->(t)
       RETURN b`,
      { cardId, transactionId, newId, ...period },
    )
    return toBill(rows[0]!)
  },

  get: async (cardId, month, year) => {
    const rows = await run(
      driver,
      `MATCH (cc:CreditCard {id: $cardId})<-[:OF]-(b:Bill {month: $month, year: $year})
       OPTIONAL MATCH (b)-[:CONTAINS]->(t:Transaction)
       OPTIONAL MATCH (t)-[:IN]->(c:Category)
       OPTIONAL MATCH (t)-[:AT]->(m:Merchant)
       WITH cc, b, t, c, m, true AS created
       ORDER BY t.date
       RETURN b, cc.name AS cardName,
              collect(CASE WHEN t IS NULL THEN NULL ELSE {
                t: t, accountId: NULL, accountName: NULL,
                categoryId: c.id, categoryName: c.name, merchant: m.key, created: created
              } END) AS items`,
      { cardId, month, year },
    )
    const row = rows[0]
    if (!row) return null
    const items = (row['items'] as Array<Record<string, unknown> | null>).filter(
      (i): i is Record<string, unknown> => i !== null,
    )
    const transactions = items.map(transactionAdapters.dbToModel)
    return {
      bill: toBill(row),
      cardName: String(row['cardName']),
      total: computeBillTotal(transactions),
      transactions,
    }
  },

  setStatus: async (billId, status) => {
    const rows = await run(driver, 'MATCH (b:Bill {id: $billId}) SET b.status = $status RETURN b', {
      billId,
      status,
    })
    return rows[0] ? toBill(rows[0]) : null
  },
})
