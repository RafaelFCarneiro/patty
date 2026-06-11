import { err, ok, type Result } from 'neverthrow'
import type { AppError } from '../common/errors.js'
import { pickClassification, type ClassifyOutcome } from '../logic/classify.js'
import { normalizeMerchant } from '../logic/merchant.js'
import { periodRange, toIsoDate } from '../logic/period.js'
import { resolveByName } from '../logic/resolve.js'
import type {
  CreateTransactionInput,
  SearchTransactionsInput,
  Transaction,
  TransactionSource,
} from '../models/transaction.js'
import type { Deps } from './deps.js'

export type CreateTransactionResult = {
  transaction: Transaction
  created: boolean
  classification: ClassifyOutcome
}

export const createTransaction = async (
  deps: Deps,
  input: CreateTransactionInput,
  source: TransactionSource,
): Promise<Result<CreateTransactionResult, AppError>> => {
  // 1. Resolve account by name, if given
  let accountId: string | null = null
  let accountCurrency: string | null = null
  if (input.account) {
    const accounts = await deps.accounts.list()
    const res = resolveByName(accounts, input.account)
    if (res.kind === 'none')
      return err({ code: 'unknown_account', query: res.query, candidates: res.candidates })
    if (res.kind === 'ambiguous')
      return err({ code: 'ambiguous_account', query: res.query, candidates: res.candidates })
    accountId = res.entity.id
    accountCurrency = res.entity.currency
  }

  // 2. Resolve category: explicit name wins; otherwise classify via merchant graph
  let categoryId: string | null = null
  let classification: ClassifyOutcome = { method: 'none', confidence: 0 }
  const normalized = normalizeMerchant(input.description)
  if (input.category) {
    const categories = await deps.categories.list()
    const res = resolveByName(categories, input.category)
    if (res.kind === 'none')
      return err({ code: 'unknown_category', query: res.query, candidates: res.candidates })
    if (res.kind === 'ambiguous')
      return err({ code: 'ambiguous_category', query: res.query, candidates: res.candidates })
    categoryId = res.entity.id
    classification = { method: 'user', confidence: 1, categoryId, categoryName: res.entity.name }
  } else {
    const matches = await deps.merchants.matchCandidates(normalized)
    classification = pickClassification(matches)
    categoryId = classification.categoryId ?? null
  }

  // 3. Build node props; currency comes from the account when resolved
  const props = {
    id: deps.newId(),
    description: input.description,
    amount: input.amount,
    type: input.type,
    date: input.date ?? toIsoDate(deps.clock()),
    currency: accountCurrency ?? input.currency ?? 'BRL',
    source,
    idempotencyKey: input.idempotencyKey,
    classificationMethod: classification.method,
    confidence: classification.confidence,
    rawInput: input.rawInput ?? null,
  }

  const { transaction, created } = await deps.transactions.create(props, {
    accountId,
    categoryId,
    merchantKey: classification.merchantKey ?? null,
  })
  return ok({ transaction, created, classification })
}

export const searchTransactions = async (
  deps: Deps,
  input: SearchTransactionsInput,
): Promise<Result<Transaction[], AppError>> => {
  let from = input.from ?? null
  let to = input.to ?? null
  if (input.month && input.year) {
    const range = periodRange({ month: input.month, year: input.year })
    from = range.from
    to = range.to
  }

  let accountId: string | null = null
  if (input.account) {
    const res = resolveByName(await deps.accounts.list(), input.account)
    if (res.kind === 'none')
      return err({ code: 'unknown_account', query: res.query, candidates: res.candidates })
    if (res.kind === 'ambiguous')
      return err({ code: 'ambiguous_account', query: res.query, candidates: res.candidates })
    accountId = res.entity.id
  }

  let categoryId: string | null = null
  if (input.category) {
    const res = resolveByName(await deps.categories.list(), input.category)
    if (res.kind === 'none')
      return err({ code: 'unknown_category', query: res.query, candidates: res.candidates })
    if (res.kind === 'ambiguous')
      return err({ code: 'ambiguous_category', query: res.query, candidates: res.candidates })
    categoryId = res.entity.id
  }

  const list = await deps.transactions.search({
    from,
    to,
    type: input.type ?? null,
    text: input.text ?? null,
    accountId,
    categoryId,
    limit: input.limit,
  })
  return ok(list)
}
