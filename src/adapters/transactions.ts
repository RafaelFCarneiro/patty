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
import type { BulkItemResult, BulkResult } from '../logic/transaction.js'
import type { TransactionDbProps, TransactionDbRefs } from '../wire/db/transactions.js'
import type * as wireIn from '../wire/in/transactions.js'
import type { BulkResultOut, CreateTransactionOut, DeleteTransactionOut } from '../wire/out/transactions.js'

export type { TransactionDbProps, TransactionDbRefs }

type NodeLike = { properties: Record<string, unknown> }
const props = (v: unknown): Record<string, unknown> => (v as NodeLike).properties

/** db→model: decode a Cypher record into a TransactionView read projection. */
export const dbToModel = (record: Record<string, unknown>): TransactionView => {
  const p = props(record['t'])
  return TransactionView.parse({
    ...p,
    classification: { method: p['classificationMethod'] ?? 'none', confidence: p['confidence'] ?? 0 },
    accountId: record['accountId'] ?? undefined,
    accountName: record['accountName'] ?? undefined,
    toAccountId: record['toAccountId'] ?? undefined,
    toAccountName: record['toAccountName'] ?? undefined,
    cardId: record['cardId'] ?? undefined,
    cardName: record['cardName'] ?? undefined,
    categoryId: record['categoryId'] ?? undefined,
    categoryName: record['categoryName'] ?? undefined,
    subCategoryId: record['subCategoryId'] ?? undefined,
    subCategoryName: record['subCategoryName'] ?? undefined,
    merchant: record['merchant'] ?? undefined,
    tags: record['tags'] ?? [],
    rawInput: p['rawInput'] ?? undefined,
  })
}

/** model→db: flatten a domain Transaction entity into node properties + edge refs. */
export const modelToDb = (
  entity: Transaction,
): { props: TransactionDbProps; refs: TransactionDbRefs } => ({
  props: {
    id: entity.id,
    description: entity.description,
    amount: entity.amount,
    type: entity.type,
    date: entity.date,
    currency: entity.currency,
    source: entity.source,
    idempotencyKey: entity.idempotencyKey,
    classificationMethod: entity.classification.method,
    confidence: entity.classification.confidence,
    rawInput: entity.rawInput ?? null,
  },
  refs: {
    accountId: entity.refs.accountId ?? null,
    toAccountId: entity.refs.toAccountId ?? null,
    cardId: entity.refs.cardId ?? null,
    categoryId: entity.refs.categoryId ?? null,
    subCategoryId: entity.refs.subCategoryId ?? null,
    merchantKey: entity.refs.merchantKey ?? null,
  },
})

/** model→db: flatten a domain patch into SET-able node properties. */
export const patchToDb = (patch: TransactionPatch): Partial<TransactionDbProps> => ({
  ...(patch.description !== undefined && { description: patch.description }),
  ...(patch.amount !== undefined && { amount: patch.amount }),
  ...(patch.type !== undefined && { type: patch.type }),
  ...(patch.date !== undefined && { date: patch.date }),
  ...(patch.currency !== undefined && { currency: patch.currency }),
  ...(patch.classification !== undefined && {
    classificationMethod: patch.classification.method,
    confidence: patch.classification.confidence,
  }),
})

/** wire/in→model: adapt parsed wire input to domain input types. */
export const createWireInToModel = (input: wireIn.CreateTransactionInput): CreateTransactionInput => input
export const bulkWireInToModel = (input: wireIn.CreateTransactionsBulkInput): CreateTransactionsBulkInput => input
export const transferWireInToModel = (input: wireIn.CreateTransferInput): CreateTransferInput => input
export const updateWireInToModel = (input: wireIn.UpdateTransactionInput): UpdateTransactionInput => input
export const searchWireInToModel = (input: wireIn.SearchTransactionsInput): SearchTransactionsInput => input

// ─── model→wire/out ───────────────────────────────────────────────────────────

export const createResultToWireOut = (result: CreateTransactionResult): CreateTransactionOut => result

const bulkItemToWireOut = (item: BulkItemResult): import('../wire/out/transactions.js').BulkItemOut => {
  if (item.status === 'error') {
    const { code } = item.error
    const msg = 'issues' in item.error
      ? `${code}: ${item.error.issues.join(', ')}`
      : code
    return { status: 'error', description: item.description, error: msg }
  }
  return item
}

export const bulkResultToWireOut = (result: BulkResult): BulkResultOut => ({
  summary: result.summary,
  items: result.items.map(bulkItemToWireOut),
})

export const deleteResultToWireOut = (result: DeleteTransactionResult): DeleteTransactionOut => result
