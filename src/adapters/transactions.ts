import {
  RawTransactionViewSchema,
  type RawTransactionView,
  type Transaction,
  type TransactionPatch,
} from '../models/transaction.js'
import { LocalizedNamesSchema } from '../models/category.js'
import type {
  CreateTransaction,
  CreateTransactionResult,
  CreateTransactionsBulk,
  CreateTransfer,
  DeleteTransactionResult,
  SearchTransactions,
  UpdateTransaction,
} from '../models/transaction.js'
import type { BulkItemResult } from '../logic/transaction.js'
import type { AppError } from '../common/errors.js'
import { TransactionRowSchema, type TransactionDbProps, type TransactionDbRefs } from '../wire/db/transactions.js'
import type * as wireIn from '../wire/in/transactions.js'
import type { BulkItemOut } from '../wire/out/transactions.js'
import { BulkResultOut, CreateTransactionOut, DeleteTransactionOut } from '../wire/out/transactions.js'
import { formatAppError } from '../common/errors.js'
import type { BulkResult } from '../logic/transaction.js'


/** db→model: decode a flat SQL row (from a full transaction SELECT) into a RawTransactionView. */
export const dbToModel = (record: Record<string, unknown>): RawTransactionView => {
  // Decode the raw row at the boundary; downstream mapping then trusts the typed shape.
  const row = TransactionRowSchema.parse(record)

  const parsedTags = row.tags ? (JSON.parse(row.tags) as unknown[]) : []
  const tags = parsedTags.filter((tag): tag is string => typeof tag === 'string')
  const categoryNames = row.category_names !== null ? LocalizedNamesSchema.parse(JSON.parse(row.category_names)) : null
  const subCategoryNames = row.subcategory_names !== null
    ? LocalizedNamesSchema.parse(JSON.parse(row.subcategory_names))
    : null

  return RawTransactionViewSchema.parse({
    id:              row.id,
    description:     row.description,
    amount:          row.amount,
    type:            row.type,
    status:          row.status,
    date:            row.date,
    currency:        row.currency,
    source:          row.source,
    idempotencyKey:  row.idempotency_key,
    classification: {
      method:     row.classification_method,
      confidence: row.confidence,
    },
    rawInput:        row.raw_input ?? undefined,
    note:            row.note ?? undefined,
    accountId:       row.from_account_id ?? undefined,
    accountName:     row.from_account_name ?? undefined,
    toAccountId:     row.to_account_id ?? undefined,
    toAccountName:   row.to_account_name ?? undefined,
    cardId:          row.credit_card_id ?? undefined,
    cardName:        row.credit_card_name ?? undefined,
    categoryId:      row.category_id ?? undefined,
    categoryName:    row.category_name ?? undefined,
    categoryNames,
    subCategoryId:   row.subcategory_id ?? undefined,
    subCategoryName: row.subcategory_name ?? undefined,
    subCategoryNames,
    merchant:        row.merchant_key ?? undefined,
    tags,
  })
}

/** model→db: flatten a domain Transaction entity into node properties + edge refs. */
export const modelToDb = (
  entity: Transaction,
): { props: TransactionDbProps; refs: TransactionDbRefs } => ({
  props: {
    id:                   entity.id,
    description:          entity.description,
    amount:               entity.amount,
    type:                 entity.type,
    status:               entity.status,
    date:                 entity.date,
    currency:             entity.currency,
    source:               entity.source,
    idempotencyKey:       entity.idempotencyKey,
    classificationMethod: entity.classification.method,
    confidence:           entity.classification.confidence,
    rawInput:             entity.rawInput ?? null,
    note:                 entity.note ?? null,
  },
  refs: {
    accountId:    entity.refs.accountId    ?? null,
    toAccountId:  entity.refs.toAccountId  ?? null,
    cardId:       entity.refs.cardId       ?? null,
    billId:       entity.refs.billId       ?? null,
    categoryId:   entity.refs.categoryId   ?? null,
    subCategoryId:entity.refs.subCategoryId?? null,
    merchantKey:  entity.refs.merchantKey  ?? null,
  },
})

/** model→db: flatten a domain patch into SQL-settable properties. */
export const patchToDb = (patch: TransactionPatch): Partial<TransactionDbProps> => ({
  ...(patch.description !== undefined && { description: patch.description }),
  ...(patch.amount      !== undefined && { amount: patch.amount }),
  ...(patch.type        !== undefined && { type: patch.type }),
  ...(patch.status      !== undefined && { status: patch.status }),
  ...(patch.date        !== undefined && { date: patch.date }),
  ...(patch.currency    !== undefined && { currency: patch.currency }),
  ...(patch.classification !== undefined && {
    classificationMethod: patch.classification.method,
    confidence:           patch.classification.confidence,
  }),
  ...(patch.note !== undefined && { note: patch.note === '' ? null : patch.note }),
})

// ─── wire/in→model ───────────────────────────────────────────────────────────

export const createWireInToModel  = (input: wireIn.CreateTransactionInput):       CreateTransaction       => input
export const bulkWireInToModel    = (input: wireIn.CreateTransactionsBulkInput):  CreateTransactionsBulk  => input
export const transferWireInToModel= (input: wireIn.CreateTransferInput):          CreateTransfer          => input
export const updateWireInToModel  = (input: wireIn.UpdateTransactionInput):       UpdateTransaction       => input
export const searchWireInToModel  = (input: wireIn.SearchTransactionsInput):      SearchTransactions      => input

// ─── model→wire/out ──────────────────────────────────────────────────────────

export const createResultToWireOut = (result: CreateTransactionResult): CreateTransactionOut =>
  CreateTransactionOut.parse(result)

const bulkItemToWireOut = (item: BulkItemResult<AppError>): BulkItemOut =>
  item.status === 'error'
    ? { status: 'error', description: item.description, error: formatAppError(item.error) }
    : item

export const bulkResultToWireOut = (result: BulkResult<AppError>): BulkResultOut =>
  BulkResultOut.parse({ summary: result.summary, items: result.items.map(bulkItemToWireOut) })

export const deleteResultToWireOut = (result: DeleteTransactionResult): DeleteTransactionOut =>
  DeleteTransactionOut.parse(result)
