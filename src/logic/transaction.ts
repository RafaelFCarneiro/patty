import type { AppError } from '../common/errors.js'
import type { Account } from '../models/account.js'
import type { CreditCard } from '../models/creditCard.js'
import { CurrencyCode } from '../models/common.js'
import type {
  Classification,
  ClassifyOutcome,
  CreateTransactionInput,
  CreateTransactionResult,
  TransactionView,
  UpdateTransactionInput,
} from '../models/transaction.js'
import { err, ok, type Result } from 'neverthrow'
import * as R from 'remeda'
import { normalizeMerchant } from './merchant.js'

// ─── Currency ────────────────────────────────────────────────────────────────

/** Resolve transaction currency: account > card > explicit > BRL default. */
export const resolveCurrency = (
  account: Pick<Account, 'currency'> | null,
  card: Pick<CreditCard, 'currency'> | null,
  input: Pick<CreateTransactionInput, 'currency'>,
): CurrencyCode => account?.currency ?? card?.currency ?? input.currency ?? CurrencyCode.enum.BRL

// ─── Transfer mutability guards ───────────────────────────────────────────────

/**
 * Enforce transfer invariants on update:
 * - A transfer's type cannot be changed.
 * - A transfer cannot receive a category or sub-category.
 */
export const guardTransferMutability = (
  existing: Pick<TransactionView, 'type'>,
  input: Pick<UpdateTransactionInput, 'type' | 'category' | 'subCategory'>,
): Result<void, AppError> => {
  if (existing.type === 'transfer' && input.type)
    return err({ code: 'validation', issues: ['cannot change the type of a transfer transaction'] })
  const resolvedType = input.type ?? existing.type
  if (resolvedType === 'transfer' && (input.category || input.subCategory))
    return err({ code: 'validation', issues: ['transfer transactions cannot have a category or sub-category'] })
  return ok(undefined)
}

/** The effective movement type after applying an update, or undefined for transfers. */
export const resolveEffectiveType = (
  existing: Pick<TransactionView, 'type'>,
  input: Pick<UpdateTransactionInput, 'type'>,
): 'income' | 'expense' | undefined => {
  const resolved = input.type ?? existing.type
  return resolved !== 'transfer' ? resolved : undefined
}

// ─── Bulk ─────────────────────────────────────────────────────────────────────

/** Stable idempotency key derived from statement line: re-importing is a no-op. */
export const deriveIdempotencyKey = (item: {
  date: string
  description: string
  amount: number
}): string =>
  `${item.date}-${normalizeMerchant(item.description).replace(/\s+/g, '-') || 'tx'}-${item.amount.toFixed(2)}`

/** Items the agent should surface to the user for category confirmation. */
export const needsReview = (c: Classification): boolean => c.method === 'none' || c.confidence < 0.6

export type BulkItemResult =
  | { status: 'created' | 'needs_review'; transaction: TransactionView; classification: ClassifyOutcome }
  | { status: 'duplicate'; transaction: TransactionView }
  | { status: 'error'; description: string; error: AppError }

export const toBulkItemResult = (
  result: Result<CreateTransactionResult, AppError>,
  description: string,
): BulkItemResult =>
  result.match(
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

export type BulkResult = {
  summary: { created: number; needsReview: number; duplicates: number; errors: number }
  items: BulkItemResult[]
}

export const summarizeBulkItems = (
  items: BulkItemResult[],
): { created: number; needsReview: number; duplicates: number; errors: number } => {
  const counts = R.countBy(items, (i) => i.status)
  return {
    created: counts['created'] ?? 0,
    needsReview: counts['needs_review'] ?? 0,
    duplicates: counts['duplicate'] ?? 0,
    errors: counts['error'] ?? 0,
  }
}
