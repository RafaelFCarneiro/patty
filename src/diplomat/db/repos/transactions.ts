import neo4j, { type Driver } from 'neo4j-driver'
import { z } from 'zod'
import { toTransaction } from '../../../adapters/records.js'
import { transactionDraftToDb, transactionPatchToDb } from '../../../adapters/transactions.js'
import type { SummaryRow } from '../../../logic/summary.js'
import type { Transaction, TransactionDraft, TransactionPatch } from '../../../models/transaction.js'
import { run } from '../driver.js'

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
         ta.id AS toAccountId, ta.name AS toAccountName,
         cc.id AS cardId, cc.name AS cardName,
         c.id AS categoryId, c.name AS categoryName,
         m.key AS merchant,
         created`

const MATCH_REFS = `
  OPTIONAL MATCH (t)-[:FROM]->(a:Account)
  OPTIONAL MATCH (t)-[:TO]->(ta:Account)
  OPTIONAL MATCH (t)-[:CHARGED_TO]->(cc:CreditCard)
  OPTIONAL MATCH (t)-[:IN]->(c:Category)
  OPTIONAL MATCH (t)-[:AT]->(m:Merchant)`

export type TransactionsRepo = {
  /** Receives domain shapes; model→db flattening happens here (adapters/transactions.ts). */
  create: (draft: TransactionDraft) => Promise<CreateTxResult>
  getById: (id: string) => Promise<Transaction | null>
  update: (
    id: string,
    patch: TransactionPatch,
    refs: { accountId: string | null; categoryId: string | null },
  ) => Promise<Transaction | null>
  delete: (id: string) => Promise<boolean>
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
  create: async (draft) => {
    const { props, refs } = transactionDraftToDb(draft)
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
       OPTIONAL MATCH (toAcc:Account {id: $toAccountId})
       FOREACH (_ IN CASE WHEN created AND toAcc IS NOT NULL THEN [1] ELSE [] END |
         MERGE (t)-[:TO]->(toAcc))
       WITH t, created
       OPTIONAL MATCH (cat:Category {id: $categoryId})
       FOREACH (_ IN CASE WHEN created AND cat IS NOT NULL THEN [1] ELSE [] END |
         MERGE (t)-[:IN]->(cat))
       WITH t, created
       OPTIONAL MATCH (mer:Merchant {key: $merchantKey})
       FOREACH (_ IN CASE WHEN created AND mer IS NOT NULL THEN [1] ELSE [] END |
         MERGE (t)-[:AT]->(mer))
       WITH t, created
       OPTIONAL MATCH (card:CreditCard {id: $cardId})
       FOREACH (_ IN CASE WHEN created AND card IS NOT NULL THEN [1] ELSE [] END |
         MERGE (t)-[:CHARGED_TO]->(card))
       WITH t, created
       ${MATCH_REFS}
       ${RETURN_TX}`,
      {
        idempotencyKey: props.idempotencyKey,
        props,
        accountId: refs.accountId,
        toAccountId: refs.toAccountId,
        cardId: refs.cardId,
        categoryId: refs.categoryId,
        merchantKey: refs.merchantKey,
      },
    )
    const row = rows[0]!
    return { transaction: toTransaction(row), created: Boolean(row['created']) }
  },

  getById: async (id) => {
    const rows = await run(
      driver,
      `MATCH (t:Transaction {id: $id})
       WITH t, true AS created
       ${MATCH_REFS}
       ${RETURN_TX}`,
      { id },
    )
    return rows[0] ? toTransaction(rows[0]) : null
  },

  /** Patch scalar props; re-link [:IN]/[:FROM] edges when new refs are provided. */
  update: async (id, patch, refs) => {
    const props = transactionPatchToDb(patch)
    const rows = await run(
      driver,
      `MATCH (t:Transaction {id: $id})
       SET t += $props
       WITH t
       OPTIONAL MATCH (newCat:Category {id: $categoryId})
       OPTIONAL MATCH (t)-[oldIn:IN]->(:Category)
       FOREACH (_ IN CASE WHEN newCat IS NOT NULL AND oldIn IS NOT NULL THEN [1] ELSE [] END | DELETE oldIn)
       FOREACH (_ IN CASE WHEN newCat IS NOT NULL THEN [1] ELSE [] END | MERGE (t)-[:IN]->(newCat))
       WITH DISTINCT t
       OPTIONAL MATCH (newAcc:Account {id: $accountId})
       OPTIONAL MATCH (t)-[oldFrom:FROM]->(:Account)
       FOREACH (_ IN CASE WHEN newAcc IS NOT NULL AND oldFrom IS NOT NULL THEN [1] ELSE [] END | DELETE oldFrom)
       FOREACH (_ IN CASE WHEN newAcc IS NOT NULL THEN [1] ELSE [] END | MERGE (t)-[:FROM]->(newAcc))
       WITH DISTINCT t, true AS created
       ${MATCH_REFS}
       ${RETURN_TX}`,
      { id, props, categoryId: refs.categoryId, accountId: refs.accountId },
    )
    return rows[0] ? toTransaction(rows[0]) : null
  },

  delete: async (id) => {
    const rows = await run(
      driver,
      `MATCH (t:Transaction {id: $id})
       DETACH DELETE t
       RETURN count(t) AS deleted`,
      { id },
    )
    return Number(rows[0]?.['deleted'] ?? 0) > 0
  },

  search: async (filters) => {
    const rows = await run(
      driver,
      `MATCH (t:Transaction)
       ${MATCH_REFS}
       WITH t, a, cc, c, m, true AS created
       WHERE ($from IS NULL OR t.date >= $from)
         AND ($to IS NULL OR t.date < $to)
         AND ($type IS NULL OR t.type = $type)
         AND ($text IS NULL OR toLower(t.description) CONTAINS toLower($text))
         AND ($accountId IS NULL OR a.id = $accountId OR ta.id = $accountId)
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
         AND t.type <> 'transfer' // transfers move value between accounts — never spending
       OPTIONAL MATCH (t)-[:IN]->(c:Category)
       RETURN t.currency AS currency, t.type AS type, c.name AS category,
              sum(t.amount) AS total, count(t) AS count`,
      { from, to },
    )
    return rows.map((r) => SummaryRowSchema.parse(r))
  },
})
