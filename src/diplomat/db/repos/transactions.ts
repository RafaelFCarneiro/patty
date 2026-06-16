import { eq, sql } from 'drizzle-orm'
import * as transactionAdapters from '../../../adapters/transactions.js'
import { expectPresent } from '../../../common/present.js'
import { TransactionType, type Transaction, type TransactionView, type TransactionPatch } from '../../../models/transaction.js'
import { SummaryRowSchema, type SummaryRow } from '../../../wire/db/transactions.js'
import type { Db } from '../driver.js'
import { toMatchQuery } from '../fts.js'
import { merchants, transactionTags, transactions } from '../schema.js'

export type CreateTxResult = { transaction: TransactionView; created: boolean }

export type SearchFilters = {
  from: string | null
  to: string | null
  type: string | null
  text: string | null
  accountId: string | null
  categoryId: string | null
  subCategoryId: string | null
  tagNames: string[]
  limit: number
}

// Full transaction SELECT with all LEFT JOINs for name resolution and tag aggregation.
const fullTxSelect = (whereClause: ReturnType<typeof sql>) => sql`
  SELECT t.*,
    fa.name AS from_account_name, ta.name AS to_account_name,
    cc.name AS credit_card_name,
    c.name AS category_name, sc.name AS subcategory_name,
    json_group_array(tg.name) FILTER (WHERE tg.name IS NOT NULL) AS tags
  FROM transactions t
  LEFT JOIN accounts fa   ON fa.id  = t.from_account_id
  LEFT JOIN accounts ta   ON ta.id  = t.to_account_id
  LEFT JOIN credit_cards cc ON cc.id = t.credit_card_id
  LEFT JOIN categories c  ON c.id   = t.category_id
  LEFT JOIN categories sc ON sc.id  = t.subcategory_id
  LEFT JOIN transaction_tags tt ON tt.transaction_id = t.id
  LEFT JOIN tags tg ON tg.id = tt.tag_id
  WHERE ${whereClause}
  GROUP BY t.id
`

const fetchTx = async (db: Db, id: string): Promise<TransactionView | null> => {
  const [row] = await db.all<Record<string, unknown>>(fullTxSelect(sql`t.id = ${id}`))
  return row ? transactionAdapters.dbToModel(row) : null
}

const attachTags = async (db: Db, txId: string, tagNames: string[]): Promise<void> => {
  if (tagNames.length === 0) return
  for (const name of tagNames) {
    const [tag] = await db.all<{ id: string }>(sql`SELECT id FROM tags WHERE name = ${name}`)
    if (tag) {
      await db.insert(transactionTags)
        .values({ transactionId: txId, tagId: tag.id })
        .onConflictDoNothing()
    }
  }
}

const replaceTags = async (db: Db, txId: string, tagNames: string[]): Promise<void> => {
  await db.delete(transactionTags).where(eq(transactionTags.transactionId, txId))
  await attachTags(db, txId, tagNames)
}

export type TransactionsRepo = {
  /** Receives domain entity; model→db flattening happens here (adapters/transactions.ts). */
  create: (entity: Transaction, tagNames: string[]) => Promise<CreateTxResult>
  getById: (id: string) => Promise<TransactionView | null>
  update: (
    id: string,
    patch: TransactionPatch,
    refs: { accountId: string | null; categoryId: string | null; subCategoryId: string | null; tagNames: string[] | null },
  ) => Promise<TransactionView | null>
  delete: (id: string) => Promise<boolean>
  search: (filters: SearchFilters) => Promise<TransactionView[]>
  summaryRows: (from: string, to: string) => Promise<SummaryRow[]>
}

export const transactionsRepo = (db: Db): TransactionsRepo => ({
  /** Idempotent create: INSERT OR IGNORE on idempotency_key. */
  create: async (entity, tagNames) => {
    const { props, refs } = transactionAdapters.modelToDb(entity)

    // Ensure merchant row exists before FK reference
    if (refs.merchantKey) {
      await db.insert(merchants).values({ key: refs.merchantKey }).onConflictDoNothing()
    }

    const result = await db.insert(transactions)
      .values({
        id:                   props.id,
        description:          props.description,
        amount:               props.amount,
        type:                 props.type,
        date:                 props.date,
        currency:             props.currency,
        source:               props.source,
        idempotencyKey:       props.idempotencyKey,
        classificationMethod: props.classificationMethod,
        confidence:           props.confidence,
        rawInput:             props.rawInput ?? null,
        fromAccountId:        refs.accountId,
        toAccountId:          refs.toAccountId,
        creditCardId:         refs.cardId,
        categoryId:           refs.categoryId,
        subcategoryId:        refs.subCategoryId,
        merchantKey:          refs.merchantKey,
      })
      .onConflictDoNothing()

    const created = (result.rowsAffected ?? 0) > 0

    let transaction: TransactionView | null
    if (created) {
      if (tagNames.length > 0) await attachTags(db, entity.id, tagNames)
      transaction = await fetchTx(db, entity.id)
    } else {
      // Duplicate: the new entity.id was never inserted; find the existing row by idempotency key.
      const [existing] = await db.all<Record<string, unknown>>(
        fullTxSelect(sql`t.idempotency_key = ${props.idempotencyKey}`)
      )
      transaction = existing ? transactionAdapters.dbToModel(existing) : null
    }

    return { transaction: expectPresent(transaction, 'transactions: row not found after write'), created }
  },

  getById: (id) => fetchTx(db, id),

  update: async (id, patch, refs) => {
    const props = transactionAdapters.patchToDb(patch)

    const setData = {
      ...(props.description          !== undefined && { description:          props.description }),
      ...(props.amount               !== undefined && { amount:               props.amount }),
      ...(props.type                 !== undefined && { type:                 props.type }),
      ...(props.date                 !== undefined && { date:                 props.date }),
      ...(props.currency             !== undefined && { currency:             props.currency }),
      ...(props.classificationMethod !== undefined && { classificationMethod: props.classificationMethod }),
      ...(props.confidence           !== undefined && { confidence:           props.confidence }),
      ...(refs.accountId    !== null && { fromAccountId: refs.accountId }),
      ...(refs.categoryId   !== null && { categoryId:    refs.categoryId }),
      ...(refs.subCategoryId!== null && { subcategoryId: refs.subCategoryId }),
    }
    if (Object.keys(setData).length > 0) {
      await db.update(transactions).set(setData).where(eq(transactions.id, id))
    }

    if (refs.tagNames !== null) {
      await replaceTags(db, id, refs.tagNames)
    }

    return fetchTx(db, id)
  },

  delete: async (id) => {
    const result = await db.delete(transactions).where(eq(transactions.id, id))
    return (result.rowsAffected ?? 0) > 0
  },

  search: async (filters) => {
    const conditions: ReturnType<typeof sql>[] = []

    if (filters.from)         conditions.push(sql`t.date >= ${filters.from}`)
    if (filters.to)           conditions.push(sql`t.date < ${filters.to}`)
    if (filters.type)         conditions.push(sql`t.type = ${filters.type}`)
    if (filters.accountId)    conditions.push(sql`(t.from_account_id = ${filters.accountId} OR t.to_account_id = ${filters.accountId})`)
    if (filters.categoryId)   conditions.push(sql`t.category_id = ${filters.categoryId}`)
    if (filters.subCategoryId)conditions.push(sql`t.subcategory_id = ${filters.subCategoryId}`)
    if (filters.tagNames.length > 0) {
      const placeholders = sql.join(filters.tagNames.map((n) => sql`${n}`), sql`, `)
      conditions.push(sql`EXISTS (
        SELECT 1 FROM transaction_tags tt2
        JOIN tags tg2 ON tg2.id = tt2.tag_id
        WHERE tt2.transaction_id = t.id AND tg2.name IN (${placeholders})
      )`)
    }

    // Free-text search resolves to a set of FTS5 rowids, intersected with the other filters.
    if (filters.text) {
      const matchQuery = toMatchQuery(filters.text)
      if (matchQuery === null) return [] // text given but no searchable token → no matches
      const ftsResults = await db.all<{ rowid: number }>(sql`
        SELECT rowid FROM transactions_fts WHERE transactions_fts MATCH ${matchQuery}
      `)
      if (ftsResults.length === 0) return []
      const rowidList = sql.join(ftsResults.map((r) => sql`${r.rowid}`), sql`, `)
      conditions.push(sql`t.rowid IN (${rowidList})`)
    }

    const where = conditions.length > 0 ? sql.join(conditions, sql` AND `) : sql`1=1`
    const rows = await db.all<Record<string, unknown>>(sql`
      ${fullTxSelect(where)}
      ORDER BY t.date DESC, t.id
      LIMIT ${filters.limit}
    `)

    return rows.map(transactionAdapters.dbToModel)
  },

  summaryRows: async (from, to) => {
    const rows = await db.all<Record<string, unknown>>(sql`
      SELECT t.currency, t.type, c.name AS category,
             SUM(t.amount) AS total, COUNT(*) AS count
      FROM transactions t
      LEFT JOIN categories c ON c.id = t.category_id
      WHERE t.date >= ${from} AND t.date < ${to}
        AND t.type != ${TransactionType.enum.transfer}
      GROUP BY t.currency, t.type, c.id
    `)
    return rows.map((r) => SummaryRowSchema.parse(r))
  },
})
