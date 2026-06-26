import type { AccountError } from '../models/account.js'
import type { BillError } from '../models/bill.js'
import type { CategoryError } from '../models/category.js'
import type { CardError } from '../models/creditCard.js'
import type { TagError } from '../models/tag.js'
import type { TransactionError } from '../models/transaction.js'

/** Expected domain failures, returned as `err(AppError)` from controllers. */
export type AppError =
  | AccountError
  | CategoryError
  | CardError
  | TransactionError
  | BillError
  | TagError

export const formatAppError = (e: AppError): string => {
  switch (e.code) {
    case 'unknown_account':
    case 'ambiguous_account':
    case 'unknown_category':
    case 'ambiguous_category':
    case 'unknown_sub_category':
    case 'ambiguous_sub_category':
    case 'unknown_card':
    case 'ambiguous_card':
      return `${e.code}: "${e.query}" (candidates: ${e.candidates.join(', ')})`
    case 'validation':
      return `${e.code}: ${e.issues.join(', ')}`
    case 'category_kind_mismatch':
      return `${e.code}: ${e.hint}`
    case 'duplicate_name':
      return `${e.code}: ${e.entity} "${e.name}"`
    case 'in_use':
      return e.entity === 'account'
        ? `${e.code}: ${e.entity} "${e.name}" (transactions: ${e.references.transactions}, recurring: ${e.references.recurring}, cards: ${e.references.cards})`
        : `${e.code}: ${e.entity} "${e.name}" (transactions: ${e.references.transactions}, recurring: ${e.references.recurring}, subCategories: ${e.references.subCategories})`
    case 'unknown_transaction':
      return `${e.code}: ${e.id}`
    case 'unknown_bill':
      return `${e.code}: ${e.card} ${e.year}-${String(e.month).padStart(2, '0')}`
    default: {
      const _exhaustive: never = e
      return `unknown error: ${JSON.stringify(_exhaustive)}`
    }
  }
}

export const httpStatus = (e: AppError): number => {
  switch (e.code) {
    case 'unknown_account':
    case 'unknown_category':
    case 'unknown_sub_category':
    case 'unknown_card':
    case 'unknown_transaction':
    case 'unknown_bill':
      return 404
    case 'ambiguous_account':
    case 'ambiguous_category':
    case 'ambiguous_sub_category':
    case 'ambiguous_card':
    case 'duplicate_name':
    case 'in_use':
      return 409
    case 'category_kind_mismatch':
      return 422
    case 'validation':
      return 422
    default: {
      const _exhaustive: never = e
      throw new Error(`unmapped error code: ${JSON.stringify(_exhaustive)}`)
    }
  }
}
