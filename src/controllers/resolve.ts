import { err, ok, type Result, ResultAsync } from 'neverthrow'
import type { AppError } from '../common/errors.js'
import { resolveByName, resolveByNames, type Named, type Resolution } from '../logic/resolve.js'
import type { Account } from '../models/account.js'
import type { Category, SubCategory } from '../models/category.js'
import type { CreditCard } from '../models/creditCard.js'
import type { MovementType } from '../models/transaction.js'
import type { Deps } from './deps.js'

/** Resolution → Result with the right structured error for the entity kind. */
export const resolutionToResult = <T extends Named>(
  res: Resolution<T>,
  kind: 'account' | 'category' | 'sub_category' | 'card',
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
  ResultAsync.fromSafePromise(deps.categories.list()).andThen((rawCategories) => {
    const locale = ResultAsync.fromSafePromise(deps.locale())
    return locale.andThen((loc) => {
      const resolved = rawCategories.map((c) => ({ ...c, name: c.names?.[loc] ?? c.name }))
      const canonicalById = new Map(rawCategories.map((c) => [c.id, c.name]))
      const synonyms = (cat: Category): string[] => {
        const all: string[] = []
        const canonical = canonicalById.get(cat.id)
        if (canonical) all.push(canonical)
        if (cat.names) all.push(...Object.values(cat.names))
        return all
      }
      return resolutionToResult(resolveByNames(resolved, name, synonyms), 'category')
    })
  })

export const resolveSubCategoryRef = (deps: Deps, name: string): ResultAsync<SubCategory, AppError> =>
  ResultAsync.fromSafePromise(deps.subCategories.list()).andThen((subCategories) =>
    resolutionToResult(resolveByName(subCategories, name), 'sub_category'),
  )

export const resolveCardRef = (deps: Deps, name: string): ResultAsync<CreditCard, AppError> =>
  ResultAsync.fromSafePromise(deps.creditCards.list()).andThen((cards) =>
    resolutionToResult(resolveByName(cards, name), 'card'),
  )

/** Guard that a category's kind is compatible with the transaction type. */
export const guardCategoryKind = (
  category: Category | SubCategory,
  txType: MovementType,
): Result<void, AppError> => {
  if (category.kind === 'both' || category.kind === txType) return ok(undefined)
  return err({
    code: 'category_kind_mismatch',
    transactionType: txType,
    categoryName: category.name,
    categoryKind: category.kind,
    hint: `Category "${category.name}" is ${category.kind}-only; to use it, set type: "${category.kind}"`,
  })
}
