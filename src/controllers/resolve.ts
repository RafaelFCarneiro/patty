import { err, ok, type Result, ResultAsync } from 'neverthrow';
import type { AppError } from '../common/errors.js';
import { buildSynonyms, resolveAndSort } from '../logic/category.js';
import { resolveByName, resolveByNames, type Named, type Resolution } from '../logic/resolve.js';
import type { Account } from '../models/account.js';
import type { Category, SubCategory } from '../models/category.js';
import type { CreditCard } from '../models/creditCard.js';
import { ambiguous, notFound } from '../models/error.js';
import type { Deps } from './deps.js';

/** Resolution → Result with the right structured error for the entity kind. */
export const resolutionToResult = <T extends Named>(
  res: Resolution<T>,
  kind: 'account' | 'category' | 'sub_category' | 'card',
): Result<T, AppError> => {
  if (res.kind === 'found') return ok(res.entity);
  return res.kind === 'none'
    ? err(notFound(kind, res.query, res.candidates))
    : err(ambiguous(kind, res.query, res.candidates));
};

export const resolveAccountRef = (deps: Deps, name: string): ResultAsync<Account, AppError> =>
  ResultAsync.fromSafePromise(deps.accounts.list()).andThen((accounts) =>
    resolutionToResult(resolveByName(accounts, name), 'account'),
  );

export const resolveCategoryRef = (deps: Deps, name: string): ResultAsync<Category, AppError> =>
  ResultAsync.fromSafePromise(Promise.all([deps.categories.list(), deps.locale()] as const)).andThen(
    ([rawCategories, locale]) => {
      const resolved = resolveAndSort(rawCategories, locale);
      return resolutionToResult(resolveByNames(resolved, name, buildSynonyms(rawCategories)), 'category');
    },
  );

export const resolveSubCategoryRef = (deps: Deps, name: string): ResultAsync<SubCategory, AppError> =>
  ResultAsync.fromSafePromise(deps.subCategories.list()).andThen((subCategories) =>
    resolutionToResult(resolveByName(subCategories, name), 'sub_category'),
  );

export const resolveCardRef = (deps: Deps, name: string): ResultAsync<CreditCard, AppError> =>
  ResultAsync.fromSafePromise(deps.creditCards.list()).andThen((cards) =>
    resolutionToResult(resolveByName(cards, name), 'card'),
  );
