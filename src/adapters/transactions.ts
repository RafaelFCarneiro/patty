import type { TransactionDraft } from '../models/transaction.js'

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
