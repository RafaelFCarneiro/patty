import type { TransactionDraft, TransactionPatch } from '../models/transaction.js'

/** Db-wire shape: flat node properties as stored on (:Transaction). */
export type TransactionDbProps = {
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

/** Edge refs with explicit nulls, as Cypher parameters expect. */
export type TransactionDbRefs = {
  accountId: string | null
  toAccountId: string | null
  cardId: string | null
  categoryId: string | null
  merchantKey: string | null
}

/** model->db: flatten a domain patch into SET-able node properties. Pure. */
export const transactionPatchToDb = (patch: TransactionPatch): Partial<TransactionDbProps> => ({
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

/** model->db: flatten a domain TransactionDraft into node properties + edge refs. Pure. */
export const transactionDraftToDb = (
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
