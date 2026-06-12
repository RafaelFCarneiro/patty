import { ok, safeTry, type ResultAsync } from 'neverthrow'
import * as R from 'remeda'
import type { AppError } from '../common/errors.js'
import { guard, okOr } from '../common/result.js'
import { billPeriodFor } from '../logic/bill.js'
import { deriveIdempotencyKey, needsReview } from '../logic/bulk.js'
import {
  pickClassification,
  userClassification,
  type ClassifyOutcome,
} from '../logic/classify.js'
import { normalizeMerchant } from '../logic/merchant.js'
import { periodRange, toIsoDate } from '../logic/period.js'
import type { Transaction, TransactionSource } from '../models/transaction.js'
import type {
  CreateTransactionInput,
  CreateTransactionsBulkInput,
  SearchTransactionsInput,
  UpdateTransactionInput,
} from '../wire/in/transactions.js'
import type { Deps } from './deps.js'
import { resolveAccountRef, resolveCardRef, resolveCategoryRef } from './resolve.js'

export type CreateTransactionResult = {
  transaction: Transaction
  created: boolean
  classification: ClassifyOutcome
}

export const createTransaction = (
  deps: Deps,
  input: CreateTransactionInput,
  source: TransactionSource,
): ResultAsync<CreateTransactionResult, AppError> =>
  safeTry(async function* () {
    yield* guard(!(input.account && input.card), {
      code: 'validation',
      issues: ['provide account OR card, not both'],
    })

    const account = input.account ? yield* resolveAccountRef(deps, input.account) : null
    const card = input.card ? yield* resolveCardRef(deps, input.card) : null

    const classification = input.category
      ? userClassification(yield* resolveCategoryRef(deps, input.category))
      : pickClassification(await deps.merchants.matchCandidates(normalizeMerchant(input.description)))

    const date = input.date ?? toIsoDate(deps.clock())
    const { transaction, created } = await deps.transactions.create({
      id: deps.newId(),
      description: input.description,
      amount: input.amount,
      type: input.type,
      date,
      currency: account?.currency ?? card?.currency ?? input.currency ?? 'BRL',
      source,
      idempotencyKey: input.idempotencyKey,
      classification,
      rawInput: input.rawInput,
      refs: {
        accountId: account?.id,
        cardId: card?.id,
        categoryId: classification.categoryId,
        merchantKey: classification.merchantKey,
      },
    })

    // Card transactions join their cycle's bill (fatura), created open on demand
    if (card && created)
      await deps.bills.ensureAndAttach(
        card.id,
        transaction.id,
        billPeriodFor(date, card.closingDay, card.dueDay),
        deps.newId(),
      )

    return ok({ transaction, created, classification })
  })

export type BulkItemResult =
  | { status: 'created' | 'needs_review'; transaction: Transaction; classification: ClassifyOutcome }
  | { status: 'duplicate'; transaction: Transaction }
  | { status: 'error'; description: string; error: AppError }

export type BulkResult = {
  summary: { created: number; needsReview: number; duplicates: number; errors: number }
  items: BulkItemResult[]
}

const toBulkItemResult = (result: Awaited<ReturnType<typeof createTransaction>>, description: string) =>
  result.match<BulkItemResult>(
    (r) =>
      !r.created
        ? { status: 'duplicate', transaction: r.transaction }
        : {
            status: needsReview(r.classification) ? 'needs_review' : 'created',
            transaction: r.transaction,
            classification: r.classification,
          },
    (error) => ({ status: 'error', description, error }),
  )

/** Statement paste/import: each line idempotent, classified, flagged for review when uncertain. */
export const createTransactionsBulk = (
  deps: Deps,
  input: CreateTransactionsBulkInput,
  source: TransactionSource,
): ResultAsync<BulkResult, AppError> =>
  safeTry(async function* () {
    const items: BulkItemResult[] = []
    for (const item of input.items) {
      const date = item.date ?? toIsoDate(deps.clock())
      const result = await createTransaction(
        deps,
        {
          ...item,
          date,
          account: item.account ?? input.account,
          card: item.card ?? input.card,
          idempotencyKey: item.idempotencyKey ?? deriveIdempotencyKey({ ...item, date }),
          rawInput: input.rawInput,
        },
        source,
      )
      items.push(toBulkItemResult(result, item.description))
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
  })

export const updateTransaction = (
  deps: Deps,
  input: UpdateTransactionInput,
): ResultAsync<Transaction, AppError> =>
  safeTry(async function* () {
    const existing = yield* okOr(await deps.transactions.getById(input.id), {
      code: 'unknown_transaction',
      id: input.id,
    })

    const account = input.account ? yield* resolveAccountRef(deps, input.account) : null
    const category = input.category ? yield* resolveCategoryRef(deps, input.category) : null

    const updated = yield* okOr(
      await deps.transactions.update(
        input.id,
        {
          description: input.description,
          amount: input.amount,
          type: input.type,
          date: input.date,
          currency: account?.currency,
          classification: category ? { method: 'user', confidence: 1 } : undefined,
        },
        { accountId: account?.id ?? null, categoryId: category?.id ?? null },
      ),
      { code: 'unknown_transaction', id: input.id },
    )

    // Learning loop: correcting the category teaches the merchant graph
    if (category && category.id !== existing.categoryId)
      await deps.merchants.strengthenFromTransaction(input.id, category.id)

    return ok(updated)
  })

export type DeleteTransactionResult =
  | { deleted: true; transaction: Transaction }
  | { deleted: false; dryRun: true; wouldDelete: Transaction; hint: string }

export const deleteTransaction = (
  deps: Deps,
  input: { id: string; confirm: boolean },
): ResultAsync<DeleteTransactionResult, AppError> =>
  safeTry(async function* () {
    const existing = yield* okOr(await deps.transactions.getById(input.id), {
      code: 'unknown_transaction',
      id: input.id,
    })

    if (!input.confirm)
      return ok({
        deleted: false as const,
        dryRun: true as const,
        wouldDelete: existing,
        hint: 'Destructive action: show the transaction to the user and call again with confirm: true.',
      })

    await deps.transactions.delete(input.id)
    return ok({ deleted: true as const, transaction: existing })
  })

export const searchTransactions = (
  deps: Deps,
  input: SearchTransactionsInput,
): ResultAsync<Transaction[], AppError> =>
  safeTry(async function* () {
    const range = input.month && input.year ? periodRange({ month: input.month, year: input.year }) : null
    const account = input.account ? yield* resolveAccountRef(deps, input.account) : null
    const category = input.category ? yield* resolveCategoryRef(deps, input.category) : null

    return ok(
      await deps.transactions.search({
        from: range?.from ?? input.from ?? null,
        to: range?.to ?? input.to ?? null,
        type: input.type ?? null,
        text: input.text ?? null,
        accountId: account?.id ?? null,
        categoryId: category?.id ?? null,
        limit: input.limit,
      }),
    )
  })
