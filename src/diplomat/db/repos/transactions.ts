import { eq, inArray, sql } from 'drizzle-orm'
import * as transactionAdapters from '../../../adapters/transactions.js'
import { expectPresent } from '../../../common/present.js'
import { TransactionStatus, TransactionType, type Transaction, type RawTransactionView, type TransactionPatch } from '../../../models/transaction.js'
import { SummaryRowSchema, type SummaryRow } from '../../../wire/db/transactions.js'
import type { Db } from '../driver.js'
import { toMatchQuery } from '../fts.js'
import { merchants, tags, transactionTags, transactions } from '../schema.js'
import { fullTxSelect } from '../transactionSelect.js'

export type CreateTxResult = { transaction: RawTransactionView; created: boolean }

export type SearchFilters = {
  from: string | null
  to: string | null
  type: string | null
  status: TransactionStatus | null
  text: string | null
  accountId: string | null
  categoryId: string | null
  subCategoryId: string | null
  tagNames: string[]
  limit: number
}

const fetchTx = async (db: Db, id: string): Promise<RawTransactionView | null> => {
  const [row] = await db.all<Record<string, unknown>>(fullTxSelect(sql`t.id = ${id}`))
  return row ? transactionAdapters.dbToModel(row) : null
}

const attachTags = async (db: Db, txId: string, tagNames: string[]): Promise<void> => {
  if (tagNames.length === 0) return
  const matches = await db.select({ id: tags.id }).from(tags).where(inArray(tags.name, tagNames))
  if (matches.length === 0) return
  await db.insert(transactionTags)
    .values(matches.map((tag) => ({ transactionId: txId, tagId: tag.id })))
    .onConflictDoNothing({ target: [transactionTags.transactionId, transactionTags.tagId] })
}

const replaceTags = async (db: Db, txId: string, tagNames: string[]): Promise<void> => {
  await db.delete(transactionTags).where(eq(transactionTags.transactionId, txId))
  await attachTags(db, txId, tagNames)
}

export type TransactionsRepo = {
  /** Receives domain entity; model→db flattening happens here (adapters/transactions.ts). */
  create: (entity: Transaction, tagNames: string[]) => Promise<CreateTxResult>
  getById: (id: string) => Promise<RawTransactionView | null>
  update: (
    id: string,
    patch: TransactionPatch,
    refs: {
      accountId: string | null
      categoryId: string | null
      /** undefined = leave untouched; null = explicitly clear (decided by the controller). */
      subCategoryId: string | null | undefined
      tagNames: string[] | null
    },
  ) => Promise<RawTransactionView | null>
  /** Flip status pending → effective. Returns null if the id does not exist. */
  confirm: (id: string) => Promise<RawTransactionView | null>
  delete: (id: string) => Promise<boolean>
  search: (filters: SearchFilters) => Promise<RawTransactionView[]>
  summaryRows: (from: string, to: string) => Promise<SummaryRow[]>
  /** Aggregated pending amounts for an account dated on/before asOf. */
  pendingBalanceParts: (accountId: string, asOf: string) => Promise<{
    income: number; expenses: number; transfersIn: number; transfersOut: number
  }>
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
        status:               props.status,
        date:                 props.date,
        currency:             props.currency,
        source:               props.source,
        idempotencyKey:       props.idempotencyKey,
        classificationMethod: props.classificationMethod,
        confidence:           props.confidence,
        rawInput:             props.rawInput ?? null,
        note:                 props.note ?? null,
        fromAccountId:        refs.accountId,
        toAccountId:          refs.toAccountId,
        creditCardId:         refs.cardId,
        billId:               refs.billId,
        categoryId:           refs.categoryId,
        subcategoryId:        refs.subCategoryId,
        merchantKey:          refs.merchantKey,
      })
      .onConflictDoNothing({ target: transactions.idempotencyKey })

    const created = (result.rowsAffected ?? 0) > 0

    let transaction: RawTransactionView | null
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
      ...(props.status               !== undefined && { status:               props.status }),
      ...(props.date                 !== undefined && { date:                 props.date }),
      ...(props.currency             !== undefined && { currency:             props.currency }),
      ...(props.classificationMethod !== undefined && { classificationMethod: props.classificationMethod }),
      ...(props.confidence           !== undefined && { confidence:           props.confidence }),
      ...(props.note                 !== undefined && { note:                 props.note }),
      ...(refs.accountId     !== null      && { fromAccountId: refs.accountId }),
      ...(refs.categoryId    !== null      && { categoryId:    refs.categoryId }),
      // undefined = caller left it untouched; null = caller explicitly clears it
      // (e.g. controller clears a stale sub-category when only the category changes).
      ...(refs.subCategoryId !== undefined && { subcategoryId: refs.subCategoryId }),
    }
    if (Object.keys(setData).length > 0) {
      await db.update(transactions).set(setData).where(eq(transactions.id, id))
    }

    if (refs.tagNames !== null) {
      await replaceTags(db, id, refs.tagNames)
    }

    return fetchTx(db, id)
  },

  confirm: async (id) => {
    await db.update(transactions)
      .set({ status: TransactionStatus.enum.effective })
      .where(sql`${transactions.id} = ${id} AND ${transactions.status} = ${TransactionStatus.enum.pending}`)
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
    if (filters.status)       conditions.push(sql`t.status = ${filters.status}`)
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

    // Free-text search stays inside the main query as a correlated FTS5 subquery.
    // A whitespace-only text has no searchable token — toMatchQuery returns null and
    // the filter is skipped entirely (no text filter), not treated as "match nothing".
    if (filters.text) {
      const matchQuery = toMatchQuery(filters.text)
      if (matchQuery !== null) {
        conditions.push(sql`t.rowid IN (SELECT rowid FROM transactions_fts WHERE transactions_fts MATCH ${matchQuery})`)
      }
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
        AND t.status = ${TransactionStatus.enum.effective}
      GROUP BY t.currency, t.type, c.id
    `)
    return rows.map((r) => SummaryRowSchema.parse(r))
  },

  pendingBalanceParts: async (accountId, asOf) => {
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
            AND t2.status = ${TransactionStatus.enum.pending}
            AND t2.date <= ${asOf}
        ), 0) AS transfers_in
      FROM transactions t
      WHERE t.from_account_id = ${accountId}
        AND t.status = ${TransactionStatus.enum.pending}
        AND t.date <= ${asOf}
    `)
    return {
      income:       row?.income        ?? 0,
      expenses:     row?.expenses      ?? 0,
      transfersIn:  row?.transfers_in  ?? 0,
      transfersOut: row?.transfers_out ?? 0,
    }
  },
})
