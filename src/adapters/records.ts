import { Account } from '../models/account.js'
import { Category } from '../models/category.js'
import { Transaction } from '../models/transaction.js'

/** Decode-at-the-boundary: every Cypher record is zod-parsed into a model. */

type NodeLike = { properties: Record<string, unknown> }

const props = (v: unknown): Record<string, unknown> => (v as NodeLike).properties

export const toAccount = (record: Record<string, unknown>): Account =>
  Account.parse({ ...props(record['a']), currency: record['currency'] })

export const toCategory = (record: Record<string, unknown>): Category => Category.parse(props(record['c']))

export const toTransaction = (record: Record<string, unknown>): Transaction => {
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
