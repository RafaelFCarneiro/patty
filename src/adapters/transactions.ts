import { TransactionView, type Transaction, type TransactionPatch } from '../models/transaction.js'
import type {
  CreateTransactionInput,
  CreateTransactionResult,
  CreateTransactionsBulkInput,
  CreateTransferInput,
  DeleteTransactionResult,
  SearchTransactionsInput,
  UpdateTransactionInput,
} from '../models/transaction.js'
import type { BulkItemResult } from '../logic/transaction.js'
import type { TransactionDbProps, TransactionDbRefs } from '../wire/db/transactions.js'
import type * as wireIn from '../wire/in/transactions.js'
import type { BulkItemOut } from '../wire/out/transactions.js'
import { BulkResultOut, CreateTransactionOut, DeleteTransactionOut } from '../wire/out/transactions.js'
import { formatAppError } from '../common/errors.js'
import type { BulkResult } from '../logic/transaction.js'

/** db→model: decode a flat SQL row (from a full transaction SELECT) into a TransactionView. */
export const dbToModel = (record: Record<string, unknown>): TransactionView => {
  const rawTags = record['tags']
  const tags: string[] =
    typeof rawTags === 'string' && rawTags.length > 0 && rawTags !== '[null]'
      ? (JSON.parse(rawTags) as string[]).filter(Boolean)
      : []

  return TransactionView.parse({
    id:              record['id'],
    description:     record['description'],
    amount:          record['amount'],
    type:            record['type'],
    date:            record['date'],
    currency:        record['currency'],
    source:          record['source'],
    idempotencyKey:  record['idempotency_key'],
    classification: {
      method:     record['classification_method'] ?? 'none',
      confidence: record['confidence'] ?? 0,
    },
    rawInput:        record['raw_input'] ?? undefined,
    accountId:       record['from_account_id'] ?? undefined,
    accountName:     record['from_account_name'] ?? undefined,
    toAccountId:     record['to_account_id'] ?? undefined,
    toAccountName:   record['to_account_name'] ?? undefined,
    cardId:          record['credit_card_id'] ?? undefined,
    cardName:        record['credit_card_name'] ?? undefined,
    categoryId:      record['category_id'] ?? undefined,
    categoryName:    record['category_name'] ?? undefined,
    subCategoryId:   record['subcategory_id'] ?? undefined,
    subCategoryName: record['subcategory_name'] ?? undefined,
    merchant:        record['merchant_key'] ?? undefined,
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
    date:                 entity.date,
    currency:             entity.currency,
    source:               entity.source,
    idempotencyKey:       entity.idempotencyKey,
    classificationMethod: entity.classification.method,
    confidence:           entity.classification.confidence,
    rawInput:             entity.rawInput ?? null,
  },
  refs: {
    accountId:    entity.refs.accountId    ?? null,
    toAccountId:  entity.refs.toAccountId  ?? null,
    cardId:       entity.refs.cardId       ?? null,
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
  ...(patch.date        !== undefined && { date: patch.date }),
  ...(patch.currency    !== undefined && { currency: patch.currency }),
  ...(patch.classification !== undefined && {
    classificationMethod: patch.classification.method,
    confidence:           patch.classification.confidence,
  }),
})

// ─── wire/in→model ───────────────────────────────────────────────────────────

export const createWireInToModel  = (input: wireIn.CreateTransactionInput):       CreateTransactionInput       => input
export const bulkWireInToModel    = (input: wireIn.CreateTransactionsBulkInput):  CreateTransactionsBulkInput  => input
export const transferWireInToModel= (input: wireIn.CreateTransferInput):          CreateTransferInput          => input
export const updateWireInToModel  = (input: wireIn.UpdateTransactionInput):       UpdateTransactionInput       => input
export const searchWireInToModel  = (input: wireIn.SearchTransactionsInput):      SearchTransactionsInput      => input

// ─── model→wire/out ──────────────────────────────────────────────────────────

export const createResultToWireOut = (result: CreateTransactionResult): CreateTransactionOut =>
  CreateTransactionOut.parse(result)

const bulkItemToWireOut = (item: BulkItemResult): BulkItemOut =>
  item.status === 'error'
    ? { status: 'error', description: item.description, error: formatAppError(item.error) }
    : item

export const bulkResultToWireOut = (result: BulkResult): BulkResultOut =>
  BulkResultOut.parse({ summary: result.summary, items: result.items.map(bulkItemToWireOut) })

export const deleteResultToWireOut = (result: DeleteTransactionResult): DeleteTransactionOut =>
  DeleteTransactionOut.parse(result)
