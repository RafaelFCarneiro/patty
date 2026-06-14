import * as R from 'remeda'

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
  | { code: 'validation'; issues: string[] }

export const formatAppError = (e: AppError): string =>
  R.conditional(
    e,
    [(e): e is Extract<AppError, { query: string }>    => 'query'  in e, (e) => `${e.code}: "${e.query}" (candidates: ${e.candidates.join(', ')})`],
    [(e): e is Extract<AppError, { issues: string[] }> => 'issues' in e, (e) => `${e.code}: ${e.issues.join(', ')}`],
    [(e): e is Extract<AppError, { hint: string }>     => 'hint'   in e, (e) => `${e.code}: ${e.hint}`],
    [(e): e is Extract<AppError, { entity: string }>   => 'entity' in e, (e) => `${e.code}: ${e.entity} "${e.name}"`],
    [(e): e is Extract<AppError, { id: string }>       => 'id'     in e, (e) => `${e.code}: ${e.id}`],
    [(e): e is Extract<AppError, { card: string }>     => 'card'   in e, (e) => `${e.code}: ${e.card} ${e.year}-${String(e.month).padStart(2, '0')}`],
    (e) => e.code,
  )

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
      return 409
    case 'category_kind_mismatch':
      return 422
    case 'validation':
      return 422
  }
}
