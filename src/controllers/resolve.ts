import { err, ok, type Result, ResultAsync } from 'neverthrow';
import * as R from 'remeda';
import type { AppError } from '../common/errors.js';
import { okOr } from '../common/result.js';
import { buildSynonyms, resolveAndSort } from '../logic/category.js';
import { normalizeMerchant } from '../logic/merchant.js';
import { decimalsLookup } from '../logic/money.js';
import { resolveByName, resolveByNames, type Named, type Resolution } from '../logic/resolve.js';
import { resolveTagIds, resolveTagNames, tagSetPersistable } from '../logic/tag.js';
import type { Account } from '../models/account.js';
import type { Category, SubCategory } from '../models/category.js';
import type { CreditCard } from '../models/creditCard.js';
import { ambiguous, notFound } from '../models/error.js';
import type { CurrencyCode } from '../models/money.js';
import type { Persistable } from '@rfc0/effect-runner';
import type { CategorySelection, MerchantMatch, TransactionView } from '../models/transaction.js';
import type { Deps } from './deps.js';

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

export const resolveDecimals = async (deps: Deps, currency: CurrencyCode): Promise<number> =>
  decimalsLookup(await deps.currencies.list())(currency);

export const matchCandidatesFor = async (
  deps: Deps,
  description: string,
  categorySelection: CategorySelection | null,
): Promise<MerchantMatch[]> =>
  categorySelection ? [] : deps.merchants.matchCandidates(normalizeMerchant(description));

export const resolveLegAccounts = (
  deps: Deps,
  tx: Pick<TransactionView, 'accountId' | 'toAccountId'>,
): ResultAsync<Account[], AppError> =>
  ResultAsync.combine(
    R.pipe(
      [tx.accountId, tx.toAccountId],
      R.filter(R.isNonNullish),
      R.unique(),
      R.map((id) =>
        ResultAsync.fromSafePromise(deps.accounts.findById(id)).andThen((account) =>
          okOr(account, notFound('account', id, [])),
        ),
      ),
    ),
  );

export type TagLinksResolution = { persistable: Persistable; tags: string[] };

export const resolveTagLinks = async (
  deps: Deps,
  transactionId: string,
  tagNames: readonly string[] | undefined,
): Promise<TagLinksResolution | null> => {
  if (R.isNullish(tagNames)) return null;
  if (R.isEmpty(tagNames)) return { persistable: tagSetPersistable(transactionId, []), tags: [] };
  const allTags = await deps.tags.list();
  return {
    persistable: tagSetPersistable(transactionId, resolveTagIds(tagNames, allTags)),
    tags: resolveTagNames(tagNames, allTags),
  };
};
