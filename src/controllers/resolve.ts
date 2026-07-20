import { err, ok, type Result, ResultAsync } from 'neverthrow';
import * as R from 'remeda';
import type { AppError } from '../common/errors.js';
import { okOr } from '../common/result.js';
import { buildSynonyms, resolveAndSort } from '../logic/category.js';
import { resolveByName, resolveByNames, type Named, type Resolution } from '../logic/resolve.js';
import { resolveTagIds, resolveTagNames, tagSetPersistable } from '../logic/tag.js';
import type { Account } from '../models/account.js';
import type { Category, SubCategory } from '../models/category.js';
import type { CreditCard } from '../models/creditCard.js';
import { ambiguous, notFound } from '../models/error.js';
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

/** What `resolveTagLinks` hands back to a create/update flow: the tag-set `Persistable` to add to
 *  its batch, plus the matched tag names the flow's own response should show — the flow composes
 *  `tags` onto its response itself (see the doc comment below for why). */
export type TagLinksResolution = { persistable: Persistable; tags: string[] };

/**
 * Resolves `tagNames` (a create's `input.tags ?? []`, or an update's `input.tags ?? existing.tags`
 * — the caller's already-merged desired set) into the transaction's tag-set `Persistable`
 * (ADR-023 step 2): matches names against the full tag list and replaces the set, silently
 * dropping any name that doesn't match (`logic/tag.ts`'s `resolveTagIds`/`resolveTagNames`).
 * Always resolves and always returns a `Persistable` — unconditional, like an update's old
 * `replaceTags` — never fails: unlike this module's other resolvers, an unmatched tag name is a
 * decided leniency, not an error, so this returns a plain `Promise` rather than a `ResultAsync`.
 * The `Persistable` is addressed by the transaction's `idempotencyKey`, not its own id — see
 * `models/transactionTag.ts` for why.
 *
 * Also returns the matched names for the flow's response to show directly, rather than trusting a
 * DB round-trip: `transactionTagApplier` applies later in the batch than `transactionApplier`'s
 * own read-back (`diplomat/db/repos/transactions.ts`'s `fetchTx`, called immediately after ITS OWN
 * write), so that read-back can't yet reflect a tag-set write still to come in the same batch. The
 * core already knows the matched set without reading anything back — rule 6 ("The response is the
 * core's, derived from the values it already holds").
 */
export const resolveTagLinks = async (
  deps: Deps,
  idempotencyKey: string,
  tagNames: readonly string[],
): Promise<TagLinksResolution> => {
  const allTags = await deps.tags.list();
  return {
    persistable: tagSetPersistable(idempotencyKey, resolveTagIds(tagNames, allTags)),
    tags: resolveTagNames(tagNames, allTags),
  };
};
