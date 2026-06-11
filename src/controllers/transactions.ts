import { err, ok, type Result } from 'neverthrow'
import * as R from 'remeda'
import type { AppError } from '../common/errors.js'
import { billPeriodFor } from '../logic/bill.js'
import { deriveIdempotencyKey, needsReview } from '../logic/bulk.js'
import { pickClassification, type ClassifyOutcome } from '../logic/classify.js'
import { normalizeMerchant } from '../logic/merchant.js'
import { periodRange, toIsoDate } from '../logic/period.js'
import { resolveByName } from '../logic/resolve.js'
import type {
  CreateTransactionInput,
  CreateTransactionsBulkInput,
  SearchTransactionsInput,
  Transaction,
  TransactionSource,
  UpdateTransactionInput,
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
  if (input.account && input.card)
    return err({ code: 'validation', issues: ['provide account OR card, not both'] })

  // 1a. Resolve account by name, if given
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

  // 1b. Resolve credit card by name, if given — transaction joins the cycle's bill
  let card: { id: string; currency: string; closingDay: number; dueDay: number } | null = null
  if (input.card) {
    const res = resolveByName(await deps.creditCards.list(), input.card)
    if (res.kind === 'none')
      return err({ code: 'unknown_card', query: res.query, candidates: res.candidates })
    if (res.kind === 'ambiguous')
      return err({ code: 'ambiguous_card', query: res.query, candidates: res.candidates })
    card = res.entity
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

  // 3. Build node props; currency follows the account/card when resolved
  const date = input.date ?? toIsoDate(deps.clock())
  const props = {
    id: deps.newId(),
    description: input.description,
    amount: input.amount,
    type: input.type,
    date,
    currency: accountCurrency ?? card?.currency ?? input.currency ?? 'BRL',
    source,
    idempotencyKey: input.idempotencyKey,
    classificationMethod: classification.method,
    confidence: classification.confidence,
    rawInput: input.rawInput ?? null,
  }

  const { transaction, created } = await deps.transactions.create(props, {
    accountId,
    toAccountId: null,
    cardId: card?.id ?? null,
    categoryId,
    merchantKey: classification.merchantKey ?? null,
  })

  // 4. Card transactions join their cycle's bill (fatura), created open on demand
  if (card && created) {
    const period = billPeriodFor(date, card.closingDay, card.dueDay)
    await deps.bills.ensureAndAttach(card.id, transaction.id, period, deps.newId())
  }

  return ok({ transaction, created, classification })
}

export type BulkItemResult =
  | { status: 'created' | 'needs_review'; transaction: Transaction; classification: ClassifyOutcome }
  | { status: 'duplicate'; transaction: Transaction }
  | { status: 'error'; description: string; error: AppError }

export type BulkResult = {
  summary: { created: number; needsReview: number; duplicates: number; errors: number }
  items: BulkItemResult[]
}

/** Statement paste/import: each line idempotent, classified, and flagged for review when uncertain. */
export const createTransactionsBulk = async (
  deps: Deps,
  input: CreateTransactionsBulkInput,
  source: TransactionSource,
): Promise<Result<BulkResult, AppError>> => {
  const items: BulkItemResult[] = []
  for (const item of input.items) {
    const date = item.date ?? toIsoDate(deps.clock())
    const single: CreateTransactionInput = {
      ...item,
      date,
      account: item.account ?? input.account,
      card: item.card ?? input.card,
      idempotencyKey: item.idempotencyKey ?? deriveIdempotencyKey({ ...item, date }),
      rawInput: input.rawInput,
    }
    const result = await createTransaction(deps, single, source)
    items.push(
      result.match<BulkItemResult>(
        (r) =>
          !r.created
            ? { status: 'duplicate', transaction: r.transaction }
            : {
                status: needsReview(r.classification) ? 'needs_review' : 'created',
                transaction: r.transaction,
                classification: r.classification,
              },
        (error) => ({ status: 'error', description: item.description, error }),
      ),
    )
  }
  const counts = R.countBy(items, (i) => i.status)
  return ok({
    summary: {
      created: counts['created'] ?? 0,
      needsReview: counts['needs_review'] ?? 0,
      duplicates: counts['duplicate'] ?? 0,
      errors: counts['error'] ?? 0,
    },
    items,
  })
}

export const updateTransaction = async (
  deps: Deps,
  input: UpdateTransactionInput,
): Promise<Result<Transaction, AppError>> => {
  const existing = await deps.transactions.getById(input.id)
  if (!existing) return err({ code: 'unknown_transaction', id: input.id })

  // Resolve new account, if provided — currency follows the account
  let accountId: string | null = null
  let accountCurrency: string | null = null
  if (input.account) {
    const res = resolveByName(await deps.accounts.list(), input.account)
    if (res.kind === 'none')
      return err({ code: 'unknown_account', query: res.query, candidates: res.candidates })
    if (res.kind === 'ambiguous')
      return err({ code: 'ambiguous_account', query: res.query, candidates: res.candidates })
    accountId = res.entity.id
    accountCurrency = res.entity.currency
  }

  // Resolve new category, if provided — a user correction, full confidence
  let categoryId: string | null = null
  if (input.category) {
    const res = resolveByName(await deps.categories.list(), input.category)
    if (res.kind === 'none')
      return err({ code: 'unknown_category', query: res.query, candidates: res.candidates })
    if (res.kind === 'ambiguous')
      return err({ code: 'ambiguous_category', query: res.query, candidates: res.candidates })
    categoryId = res.entity.id
  }

  const props = {
    ...(input.description !== undefined && { description: input.description }),
    ...(input.amount !== undefined && { amount: input.amount }),
    ...(input.type !== undefined && { type: input.type }),
    ...(input.date !== undefined && { date: input.date }),
    ...(accountCurrency !== null && { currency: accountCurrency }),
    ...(categoryId !== null && { classificationMethod: 'user', confidence: 1 }),
  }

  const updated = await deps.transactions.update(input.id, props, { accountId, categoryId })
  if (!updated) return err({ code: 'unknown_transaction', id: input.id })

  // Learning loop: correcting the category teaches the merchant graph
  if (categoryId && categoryId !== existing.categoryId)
    await deps.merchants.strengthenFromTransaction(input.id, categoryId)

  return ok(updated)
}

export type DeleteTransactionResult =
  | { deleted: true; transaction: Transaction }
  | { deleted: false; dryRun: true; wouldDelete: Transaction; hint: string }

export const deleteTransaction = async (
  deps: Deps,
  input: { id: string; confirm: boolean },
): Promise<Result<DeleteTransactionResult, AppError>> => {
  const existing = await deps.transactions.getById(input.id)
  if (!existing) return err({ code: 'unknown_transaction', id: input.id })

  if (!input.confirm)
    return ok({
      deleted: false,
      dryRun: true,
      wouldDelete: existing,
      hint: 'Destructive action: show the transaction to the user and call again with confirm: true.',
    })

  await deps.transactions.delete(input.id)
  return ok({ deleted: true, transaction: existing })
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
