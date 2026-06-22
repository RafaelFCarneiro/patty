/** Expected domain failures, returned as `err(AppError)` from controllers. */
export type AppError =
  | { code: 'unknown_account'; query: string; candidates: string[] }
  | { code: 'ambiguous_account'; query: string; candidates: string[] }
  | { code: 'unknown_category'; query: string; candidates: string[] }
  | { code: 'ambiguous_category'; query: string; candidates: string[] }
  | { code: 'unknown_sub_category'; query: string; candidates: string[] }
  | { code: 'ambiguous_sub_category'; query: string; candidates: string[] }
  | { code: 'unknown_card'; query: string; candidates: string[] }
  | { code: 'ambiguous_card'; query: string; candidates: string[] }
  | { code: 'duplicate_name'; entity: 'account' | 'category' | 'sub_category' | 'credit_card' | 'tag'; name: string }
  | { code: 'unknown_transaction'; id: string }
  | { code: 'unknown_bill'; card: string; month: number; year: number }
  | { code: 'category_kind_mismatch'; transactionType: string; categoryName: string; categoryKind: string; hint: string }
  | { code: 'in_use'; entity: 'category' | 'sub_category'; name: string; references: { transactions: number; recurring: number; subCategories: number } }
  | { code: 'validation'; issues: string[] }

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
      return `${e.code}: ${e.entity} "${e.name}" (transactions: ${e.references.transactions}, recurring: ${e.references.recurring}, subCategories: ${e.references.subCategories})`
    case 'unknown_transaction':
      return `${e.code}: ${e.id}`
    case 'unknown_bill':
      return `${e.code}: ${e.card} ${e.year}-${String(e.month).padStart(2, '0')}`
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
  }
}
