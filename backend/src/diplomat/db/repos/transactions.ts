import neo4j, { type Driver } from 'neo4j-driver'
import { z } from 'zod'
import { toTransaction } from '../../../adapters/records.js'
import type { SummaryRow } from '../../../logic/summary.js'
import type { Transaction } from '../../../models/transaction.js'
import { run } from '../driver.js'

export type TransactionProps = {
  id: string
  description: string
  amount: number
  type: string
  date: string
  currency: string
  source: string
  idempotencyKey: string
  classificationMethod: string
  confidence: number
  rawInput: string | null
}

export type CreateTxResult = { transaction: Transaction; created: boolean }

export type SearchFilters = {
  from: string | null
  to: string | null
  type: string | null
  text: string | null
  accountId: string | null
  categoryId: string | null
  limit: number
}

const RETURN_TX = `
  RETURN t,
         a.id AS accountId, a.name AS accountName,
         c.id AS categoryId, c.name AS categoryName,
         m.key AS merchant,
         created`

export type TransactionsRepo = {
  create: (
    props: TransactionProps,
    refs: { accountId: string | null; categoryId: string | null; merchantKey: string | null },
  ) => Promise<CreateTxResult>
  search: (filters: SearchFilters) => Promise<Transaction[]>
  summaryRows: (from: string, to: string) => Promise<SummaryRow[]>
}

const SummaryRowSchema = z.object({
  currency: z.enum(['BRL', 'USD']),
  type: z.enum(['expense', 'income']),
  category: z.string().nullable(),
  total: z.number(),
  count: z.number(),
})

export const transactionsRepo = (driver: Driver): TransactionsRepo => ({
  /** Idempotent create: MERGE on idempotencyKey; edges attached only on first write. */
  create: async (props, refs) => {
    const rows = await run(
      driver,
      `MERGE (t:Transaction {idempotencyKey: $idempotencyKey})
       ON CREATE SET t += $props, t._new = true
       WITH t, coalesce(t._new, false) AS created
       REMOVE t._new
       WITH t, created
       OPTIONAL MATCH (acc:Account {id: $accountId})
       FOREACH (_ IN CASE WHEN created AND acc IS NOT NULL THEN [1] ELSE [] END |
         MERGE (t)-[:FROM]->(acc))
       WITH t, created
       OPTIONAL MATCH (cat:Category {id: $categoryId})
       FOREACH (_ IN CASE WHEN created AND cat IS NOT NULL THEN [1] ELSE [] END |
         MERGE (t)-[:IN]->(cat))
       WITH t, created
       OPTIONAL MATCH (mer:Merchant {key: $merchantKey})
       FOREACH (_ IN CASE WHEN created AND mer IS NOT NULL THEN [1] ELSE [] END |
         MERGE (t)-[:AT]->(mer))
       WITH t, created
       OPTIONAL MATCH (t)-[:FROM]->(a:Account)
       OPTIONAL MATCH (t)-[:IN]->(c:Category)
       OPTIONAL MATCH (t)-[:AT]->(m:Merchant)
       ${RETURN_TX}`,
      {
        idempotencyKey: props.idempotencyKey,
        props,
        accountId: refs.accountId,
        categoryId: refs.categoryId,
        merchantKey: refs.merchantKey,
      },
    )
    const row = rows[0]!
    return { transaction: toTransaction(row), created: Boolean(row['created']) }
  },

  search: async (filters) => {
    const rows = await run(
      driver,
      `MATCH (t:Transaction)
       OPTIONAL MATCH (t)-[:FROM]->(a:Account)
       OPTIONAL MATCH (t)-[:IN]->(c:Category)
       OPTIONAL MATCH (t)-[:AT]->(m:Merchant)
       WITH t, a, c, m, true AS created
       WHERE ($from IS NULL OR t.date >= $from)
         AND ($to IS NULL OR t.date < $to)
         AND ($type IS NULL OR t.type = $type)
         AND ($text IS NULL OR toLower(t.description) CONTAINS toLower($text))
         AND ($accountId IS NULL OR a.id = $accountId)
         AND ($categoryId IS NULL OR c.id = $categoryId)
       ${RETURN_TX}
       ORDER BY t.date DESC, t.id
       LIMIT $limit`,
      { ...filters, limit: neo4j.int(filters.limit) },
    )
    return rows.map(toTransaction)
  },

  summaryRows: async (from, to) => {
    const rows = await run(
      driver,
      `MATCH (t:Transaction)
       WHERE t.date >= $from AND t.date < $to
       OPTIONAL MATCH (t)-[:IN]->(c:Category)
       RETURN t.currency AS currency, t.type AS type, c.name AS category,
              sum(t.amount) AS total, count(t) AS count`,
      { from, to },
    )
    return rows.map((r) => SummaryRowSchema.parse(r))
  },
})
