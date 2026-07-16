import { ok, safeTry, type ResultAsync } from 'neverthrow';
import type { AppError } from '../../common/errors.js';
import { guard, okOr } from '../../common/result.js';
import { assertCurrencyMatch, assertNonCreditType } from '../../logic/account.js';
import * as persistence from '../../logic/persistence.js';
import { accountErrors, ACCOUNT_ENTITY_TAG, AccountType, type Account } from '../../models/account.js';
import { cardErrors, CREDIT_CARD_ENTITY_TAG, type CreateCreditCard, type CreditCard } from '../../models/creditCard.js';
import { notFound } from '../../models/error.js';
import type { FlowOutcome, Persistable } from '../../models/persistable.js';
import type { Deps } from '../deps.js';
import { resolveAccountRef, resolveCardRef } from '../resolve.js';

export type DeleteCreditCardResult =
  | { deleted: true; card: string }
  | {
      deleted: false;
      dryRun: true;
      wouldDelete: { card: string; account: string; transactions: number; bills: number };
      hint: string;
    };

export const listCreditCards = (deps: Deps): Promise<CreditCard[]> => deps.creditCards.list();

/** Repo-touching precondition: true when no card already holds this name. */
const assertCardNameAvailable = async (deps: Deps, name: string): Promise<boolean> =>
  !(await deps.creditCards.findByName(name));

/** Repo-touching precondition: true when no account already holds this name. */
const assertAccountNameAvailable = async (deps: Deps, name: string): Promise<boolean> =>
  !(await deps.accounts.findByName(name));

/**
 * Delete a credit card (ADR-021): the dry-run preview (no writes — an empty `persist` batch,
 * mirroring `deleteAccountTransaction`) is unchanged. On confirm, emits a two-entity batch —
 * `[remove creditCard, remove account]` — the card first (its own `creditCardApplier` cascades
 * every correlated purchase/bill/tag ahead of the card row itself, mirroring the pre-ADR-021
 * `deleteCard`'s behavior), then the internal liability account, safe to remove once the card row
 * referencing it is gone. `resolveCardRef`'s `CreditCard`/`resolveAccountRef`'s `Account` carry no
 * `version`; a version-carrying re-read of each (`findRawById`) supplies what the `Persistable`s need.
 */
export const deleteCreditCard = (
  deps: Deps,
  input: { card: string; confirm: boolean },
): ResultAsync<FlowOutcome<DeleteCreditCardResult>, AppError> =>
  safeTry(async function* () {
    const card = yield* resolveCardRef(deps, input.card);
    const counts = await deps.creditCards.countCorrelated(card.id, card.accountId);

    if (!input.confirm)
      return ok({
        persist: [],
        response: {
          deleted: false as const,
          dryRun: true as const,
          wouldDelete: {
            card: card.name,
            account: `Card: ${card.name}`,
            transactions: counts.transactions,
            bills: counts.bills,
          },
          hint: 'Destructive action: show what would be deleted to the user and call again with confirm: true.',
        },
      });

    const rawCard = yield* okOr(await deps.creditCards.findRawById(card.id), notFound('card', card.id, []));
    const rawAccount = yield* okOr(
      await deps.accounts.findRawById(card.accountId),
      notFound('account', card.accountId, []),
    );

    const persist: Persistable[] = [
      persistence.remove({ entity: CREDIT_CARD_ENTITY_TAG, id: rawCard.id, version: rawCard.version }),
      persistence.remove({ entity: ACCOUNT_ENTITY_TAG, id: rawAccount.id, version: rawAccount.version }),
    ];
    return ok({ persist, response: { deleted: true as const, card: card.name } });
  });

/**
 * Create a credit card with its internal liability account (ADR-010/ADR-021): a two-entity
 * insert batch — `[insert internal account, insert creditCard]`, account first since the card
 * row's `accountId` is a NOT NULL FK into it (mirrors the pre-ADR-021 `createWithAccount`'s own
 * insert order).
 */
export const createCreditCard = (deps: Deps, input: CreateCreditCard): ResultAsync<FlowOutcome<CreditCard>, AppError> =>
  safeTry(async function* () {
    yield* guard(await assertCardNameAvailable(deps, input.name), cardErrors.duplicateName(input.name));

    let paymentAccountId: string | undefined;
    if (input.paymentAccount) {
      const paymentAccount = yield* resolveAccountRef(deps, input.paymentAccount);
      yield* guard(assertNonCreditType(paymentAccount.type), accountErrors.creditPaymentRejected);
      yield* guard(
        assertCurrencyMatch({ currency: input.currency }, paymentAccount),
        cardErrors.currencyMismatch(input.currency, paymentAccount.currency),
      );
      paymentAccountId = paymentAccount.id;
    }

    const internalAccountName = `Card: ${input.name}`;
    yield* guard(
      await assertAccountNameAvailable(deps, internalAccountName),
      accountErrors.duplicateName(internalAccountName),
    );

    const accountId = deps.newId();
    const account: Account = {
      id: accountId,
      name: internalAccountName,
      type: AccountType.enum.credit,
      currency: input.currency,
      initialBalance: 0,
    };
    const card: CreditCard = {
      id: deps.newId(),
      name: input.name,
      currency: input.currency,
      closingDay: input.closingDay,
      dueDay: input.dueDay,
      limit: input.limit,
      accountId,
      paymentAccountId,
    };

    const persist: Persistable[] = [
      persistence.insert({ entity: ACCOUNT_ENTITY_TAG, model: account }),
      persistence.insert({ entity: CREDIT_CARD_ENTITY_TAG, model: card }),
    ];
    return ok({ persist, response: card });
  });
