import { err, ok, type Result, ResultAsync } from 'neverthrow';
import * as R from 'remeda';
import type { AppError } from '../common/errors.js';
import { okOr } from '../common/result.js';
import { buildSynonyms, resolveAndSort } from '../logic/category.js';
import { decimalsLookup } from '../logic/money.js';
import { resolveByName, resolveByNames, type Named, type Resolution } from '../logic/resolve.js';
import { resolveTagIds, resolveTagNames, tagSetPersistable } from '../logic/tag.js';
import type { Account } from '../models/account.js';
import type { Category, SubCategory } from '../models/category.js';
import type { CreditCard } from '../models/creditCard.js';
import { ambiguous, notFound } from '../models/error.js';
import type { CurrencyCode } from '../models/money.js';
import type { Persistable } from '../models/persistable.js';
import type { TransactionView } from '../models/transaction.js';
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

/** A currency's own fractional digits, resolved off the live currencies reference list — shared by
 *  every insert-shaped transaction flow to round its idempotency key's amount component
 *  (ADR-029 Phase 2b). No `Result`: every `CurrencyCode` is a validated enum member, always present
 *  in the reference list (`decimalsLookup` itself falls back to fiat decimals for the
 *  should-never-happen case of a missing code). */
export const resolveDecimals = async (deps: Deps, currency: CurrencyCode): Promise<number> =>
  decimalsLookup(await deps.currencies.list())(currency);

/**
 * Resolves the account(s) referenced by a transaction's leg(s) (`accountId`/`toAccountId`) —
 * a neutral I/O helper (ADR-020) making no ownership judgment of its own: a card purchase's
 * `accountId` is the card's own internal account; the bill-payment transfer's `toAccountId` is
 * that same account. Each aggregate interprets the result against its own definition of what it
 * owns (`controllers/creditCard/transaction.ts`'s `assertCreditAccountLeg`, `controllers/account/
 * transaction.ts`'s `assertAccountOwnedLegs`) rather than sharing one judgment between them.
 *
 * Fails on the Result track (`unknown_account`) if a leg id doesn't resolve to an account — same
 * treatment as the analogous stale-`cardId` case in `controllers/creditCard/transaction.ts`'s
 * `updateCardTransaction` (`okOr(await deps.creditCards.findById(cardId), notFound('card', cardId,
 * []))`): an internal FK inconsistency that accounts/cards referenced by a transaction can't
 * normally produce (`accountErrors.inUse` blocks deleting a referenced account; `deleteCreditCard`
 * cascades every correlated transaction itself, as its own `Persistable`s), but is still routed
 * through `AppError` rather than a bare
 * throw, for the same reason it is there — consistency with every other resolver in this module.
 */
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

// `undefined` (the caller's `input.tags` omitted) means "leave tags alone" — returns null, no
// Persistable, no deps.tags.list() read: a create/update that never mentions tags shouldn't pay
// for one. Never fails otherwise — an unmatched name is dropped, not an error — so this is a
// plain Promise rather than a ResultAsync, unlike this module's other resolvers. `transactionId`
// is the flow's own `entity.id`; on a duplicate-idempotency replay the applier no-ops on it
// (models/transactionTag.ts), so a duplicate never touches the surviving row's tags.
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
