/** Expected domain failures, returned as `err(AppError)` from controllers. */
export type AppError =
  | { code: 'unknown_account'; query: string; candidates: string[] }
  | { code: 'ambiguous_account'; query: string; candidates: string[] }
  | { code: 'unknown_category'; query: string; candidates: string[] }
  | { code: 'ambiguous_category'; query: string; candidates: string[] }
  | { code: 'unknown_card'; query: string; candidates: string[] }
  | { code: 'ambiguous_card'; query: string; candidates: string[] }
  | { code: 'duplicate_name'; entity: 'account' | 'category' | 'credit_card' | 'tag'; name: string }
  | { code: 'unknown_transaction'; id: string }
  | { code: 'unknown_bill'; card: string; month: number; year: number }
  | { code: 'validation'; issues: string[] }

export const httpStatus = (e: AppError): number => {
  switch (e.code) {
    case 'unknown_account':
    case 'unknown_category':
    case 'unknown_card':
    case 'unknown_transaction':
    case 'unknown_bill':
      return 404
    case 'ambiguous_account':
    case 'ambiguous_category':
    case 'ambiguous_card':
    case 'duplicate_name':
      return 409
    case 'validation':
      return 422
  }
}
