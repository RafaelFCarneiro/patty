import { Transaction, type TransactionDraft, type TransactionPatch } from '../models/transaction.js'
import type {
  CreateTransactionInput,
  CreateTransactionsBulkInput,
  CreateTransferInput,
  SearchTransactionsInput,
  UpdateTransactionInput,
} from '../models/transaction.js'
import type { TransactionDbProps, TransactionDbRefs } from '../wire/db/transactions.js'
import type * as wireIn from '../wire/in/transactions.js'

export type { TransactionDbProps, TransactionDbRefs }

type NodeLike = { properties: Record<string, unknown> }
const props = (v: unknown): Record<string, unknown> => (v as NodeLike).properties

/** db→model: decode a Cypher record into a Transaction domain model. */
export const dbToModel = (record: Record<string, unknown>): Transaction => {
  const p = props(record['t'])
  return Transaction.parse({
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
    merchant: record['merchant'] ?? undefined,
    rawInput: p['rawInput'] ?? undefined,
  })
}

/** model→db: flatten a domain TransactionDraft into node properties + edge refs. */
export const modelToDb = (
  draft: TransactionDraft,
): { props: TransactionDbProps; refs: TransactionDbRefs } => ({
  props: {
    id: draft.id,
    description: draft.description,
    amount: draft.amount,
    type: draft.type,
    date: draft.date,
    currency: draft.currency,
    source: draft.source,
    idempotencyKey: draft.idempotencyKey,
    classificationMethod: draft.classification.method,
    confidence: draft.classification.confidence,
    rawInput: draft.rawInput ?? null,
  },
  refs: {
    accountId: draft.refs.accountId ?? null,
    toAccountId: draft.refs.toAccountId ?? null,
    cardId: draft.refs.cardId ?? null,
    categoryId: draft.refs.categoryId ?? null,
    merchantKey: draft.refs.merchantKey ?? null,
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
