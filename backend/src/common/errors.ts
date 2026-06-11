/** Expected domain failures, returned as `err(AppError)` from controllers. */
export type AppError =
  | { code: 'unknown_account'; query: string; candidates: string[] }
  | { code: 'ambiguous_account'; query: string; candidates: string[] }
  | { code: 'unknown_category'; query: string; candidates: string[] }
  | { code: 'ambiguous_category'; query: string; candidates: string[] }
  | { code: 'duplicate_name'; entity: 'account' | 'category'; name: string }
  | { code: 'validation'; issues: string[] }

export const httpStatus = (e: AppError): number => {
  switch (e.code) {
    case 'unknown_account':
    case 'unknown_category':
      return 404
    case 'ambiguous_account':
    case 'ambiguous_category':
      return 409
    case 'duplicate_name':
      return 409
    case 'validation':
      return 422
  }
}
