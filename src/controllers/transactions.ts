import { ok, safeTry, type ResultAsync } from 'neverthrow'
import type { AppError } from '../common/errors.js'
import { guard, okOr } from '../common/result.js'
import { billPeriodFor } from '../logic/bill.js'
import { pickClassification, userClassification } from '../logic/classify.js'
import type { ClassifyOutcome } from '../models/transaction.js'
import { normalizeMerchant } from '../logic/merchant.js'
import { periodRange, toIsoDate } from '../logic/period.js'
import type { BulkItemResult, BulkResult } from '../logic/transaction.js'
import {
  deriveIdempotencyKey,
  guardTransferMutability,
  resolveCurrency,
  resolveEffectiveType,
  summarizeBulkItems,
  toBulkItemResult,
} from '../logic/transaction.js'
import {
  TransactionStatus,
} from '../models/transaction.js'
import type {
  CreateTransactionInput,
  CreateTransactionResult,
  CreateTransactionsBulkInput,
  DeleteTransactionResult,
  SearchTransactionsInput,
  TransactionView,
  TransactionSource,
  UpdateTransactionInput,
} from '../models/transaction.js'
import type { Deps } from './deps.js'
import { guardCategoryKind, resolveAccountRef, resolveCardRef, resolveCategoryRef, resolveSubCategoryRef } from './resolve.js'


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
    yield* guard(!(input.category && input.subCategory), {
      code: 'validation',
      issues: ['provide category OR subCategory, not both — subCategory implies its parent category'],
    })

    const account = input.account ? yield* resolveAccountRef(deps, input.account) : null
    const card = input.card ? yield* resolveCardRef(deps, input.card) : null

    let classification: ClassifyOutcome
    let subCategoryId: string | undefined

    if (input.subCategory) {
      const subCat = yield* resolveSubCategoryRef(deps, input.subCategory)
      yield* guardCategoryKind(subCat, input.type)
      subCategoryId = subCat.id
      classification = userClassification({ id: subCat.parentId, name: subCat.parentName })
    } else if (input.category) {
      const cat = yield* resolveCategoryRef(deps, input.category)
      yield* guardCategoryKind(cat, input.type)
      classification = userClassification(cat)
    } else {
      classification = pickClassification(
        await deps.merchants.matchCandidates(normalizeMerchant(input.description)),
      )
    }

    const date = input.date ?? toIsoDate(deps.clock())
    const today = toIsoDate(deps.clock())
    const status =
      input.status ??
      (date > today ? TransactionStatus.enum.pending : TransactionStatus.enum.effective)

    const { transaction, created } = await deps.transactions.create(
      {
        id: deps.newId(),
        description: input.description,
        amount: input.amount,
        type: input.type,
        status,
        date,
        currency: resolveCurrency(account, card, input),
        source,
        idempotencyKey: input.idempotencyKey,
        classification,
        rawInput: input.rawInput,
        refs: {
          accountId: account?.id,
          cardId: card?.id,
          categoryId: classification.categoryId,
          subCategoryId,
          merchantKey: classification.merchantKey,
        },
      },
      input.tags ?? [],
    )

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

    return ok({ summary: summarizeBulkItems(items), items })
  })

export const updateTransaction = (
  deps: Deps,
  input: UpdateTransactionInput,
): ResultAsync<TransactionView, AppError> =>
  safeTry(async function* () {
    yield* guard(!(input.category && input.subCategory), {
      code: 'validation',
      issues: ['provide category OR subCategory, not both'],
    })

    const existing = yield* okOr(await deps.transactions.getById(input.id), {
      code: 'unknown_transaction',
      id: input.id,
    })

    yield* guardTransferMutability(existing, input)

    const account = input.account ? yield* resolveAccountRef(deps, input.account) : null
    const effectiveType = resolveEffectiveType(existing, input)

    let categoryId: string | null = null
    // undefined = leave the sub-category untouched; null = explicitly clear it.
    let subCategoryId: string | null | undefined

    if (input.subCategory) {
      const subCat = yield* resolveSubCategoryRef(deps, input.subCategory)
      if (effectiveType) yield* guardCategoryKind(subCat, effectiveType)
      subCategoryId = subCat.id
      categoryId = subCat.parentId
    } else if (input.category) {
      const cat = yield* resolveCategoryRef(deps, input.category)
      if (effectiveType) yield* guardCategoryKind(cat, effectiveType)
      categoryId = cat.id
      // Business rule: assigning a plain category clears any prior sub-category —
      // "sub-category always paired with its parent" would otherwise go stale.
      subCategoryId = null
    }

    const isUserCorrection = !!(input.category || input.subCategory)

    const updated = yield* okOr(
      await deps.transactions.update(
        input.id,
        {
          description: input.description,
          amount: input.amount,
          type: input.type,
          date: input.date,
          currency: account?.currency,
          classification: isUserCorrection ? { method: 'user', confidence: 1 } : undefined,
        },
        { accountId: account?.id ?? null, categoryId, subCategoryId, tagNames: input.tags ?? null },
      ),
      { code: 'unknown_transaction', id: input.id },
    )

    // Learning loop: correcting the category strengthens the merchant→category association
    if (categoryId && categoryId !== existing.categoryId)
      await deps.merchants.strengthenFromTransaction(input.id, categoryId)

    return ok(updated)
  })

/** Flip a pending transaction to effective. No-op (returns existing) if already effective. */
export const confirmTransaction = (
  deps: Deps,
  input: { id: string },
): ResultAsync<TransactionView, AppError> =>
  safeTry(async function* () {
    const existing = yield* okOr(await deps.transactions.getById(input.id), {
      code: 'unknown_transaction',
      id: input.id,
    })

    if (existing.status === TransactionStatus.enum.effective) return ok(existing)

    return ok(
      yield* okOr(await deps.transactions.confirm(input.id), {
        code: 'unknown_transaction',
        id: input.id,
      }),
    )
  })

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
): ResultAsync<TransactionView[], AppError> =>
  safeTry(async function* () {
    const range = input.month && input.year ? periodRange({ month: input.month, year: input.year }) : null
    const account = input.account ? yield* resolveAccountRef(deps, input.account) : null
    const category = input.category ? yield* resolveCategoryRef(deps, input.category) : null
    const subCategory = input.subCategory ? yield* resolveSubCategoryRef(deps, input.subCategory) : null

    return ok(
      await deps.transactions.search({
        from: range?.from ?? input.from ?? null,
        to: range?.to ?? input.to ?? null,
        type: input.type ?? null,
        status: input.status ?? null,
        text: input.text ?? null,
        accountId: account?.id ?? null,
        categoryId: category?.id ?? null,
        subCategoryId: subCategory?.id ?? null,
        tagNames: input.tags ?? [],
        limit: input.limit,
      }),
    )
  })
