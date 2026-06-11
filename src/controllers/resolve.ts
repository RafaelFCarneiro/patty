import { err, ok, type Result, ResultAsync } from 'neverthrow'
import type { AppError } from '../common/errors.js'
import { resolveByName, type Named, type Resolution } from '../logic/resolve.js'
import type { Account } from '../models/account.js'
import type { Category } from '../models/category.js'
import type { CreditCard } from '../models/creditCard.js'
import type { Deps } from './deps.js'

/** Resolution → Result with the right structured error for the entity kind. */
export const resolutionToResult = <T extends Named>(
  res: Resolution<T>,
  kind: 'account' | 'category' | 'card',
): Result<T, AppError> => {
  if (res.kind === 'found') return ok(res.entity)
  const code = res.kind === 'none' ? (`unknown_${kind}` as const) : (`ambiguous_${kind}` as const)
  return err({ code, query: res.query, candidates: res.candidates })
}

export const resolveAccountRef = (deps: Deps, name: string): ResultAsync<Account, AppError> =>
  ResultAsync.fromSafePromise(deps.accounts.list()).andThen((accounts) =>
    resolutionToResult(resolveByName(accounts, name), 'account'),
  )

export const resolveCategoryRef = (deps: Deps, name: string): ResultAsync<Category, AppError> =>
  ResultAsync.fromSafePromise(deps.categories.list()).andThen((categories) =>
    resolutionToResult(resolveByName(categories, name), 'category'),
  )

export const resolveCardRef = (deps: Deps, name: string): ResultAsync<CreditCard, AppError> =>
  ResultAsync.fromSafePromise(deps.creditCards.list()).andThen((cards) =>
    resolutionToResult(resolveByName(cards, name), 'card'),
  )
