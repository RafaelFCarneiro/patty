import { ok, safeTry, type ResultAsync } from 'neverthrow';
import * as R from 'remeda';
import type { AppError } from '../../common/errors.js';
import { guard, okOr } from '../../common/result.js';
import { assertCurrencyMatch, assertNonCreditType } from '../../logic/account.js';
import { billEntityFrom } from '../../logic/bill.js';
import { internalAccountNameFor, isCardRename } from '../../logic/creditCard.js';
import * as persistence from '../../logic/persistence.js';
import { accountErrors, ACCOUNT_ENTITY_TAG, AccountType, type Account } from '../../models/account.js';
import { BILL_ENTITY_TAG, type RawBill } from '../../models/bill.js';
import {
  cardErrors,
  CREDIT_CARD_ENTITY_TAG,
  DELETE_CREDIT_CARD_CONFIRM_HINT,
  type CreateCreditCard,
  type CreditCard,
  type CreditCardEntity,
  type UpdateCreditCard,
} from '../../models/creditCard.js';
import { notFound } from '../../models/error.js';
import type { FlowOutcome, Persistable } from '../../effects/persistable.js';
import { TRANSACTION_ENTITY_TAG } from '../../models/transaction.js';
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

/** A bill with a payment transfer has a circular reference with it (`bills.payment_transaction_id`
 *  → the transfer; the transfer's own `bill_id` → the bill; no `ON DELETE` action on either
 *  column, libsql enforces foreign keys) — so that reference must be cleared before either row can
 *  be deleted. Returns nothing for a bill that never had a transfer. */
const billClearFor = (bill: RawBill): Persistable[] =>
  bill.paymentTransactionId
    ? [persistence.update({ entity: BILL_ENTITY_TAG, model: { ...billEntityFrom(bill), paymentTransactionId: null } })]
    : [];

/** The bill's own removal — version-guarded. A bill `billClearFor` already emitted an `update` for
 *  is removed at the version the shell will have bumped it to by the time this applies in the same
 *  batch (rule 4: an `update` always becomes `model.version + 1`, deterministically) — not the
 *  version read here, which the update already moved past. */
const billRemovalFor = (bill: RawBill): Persistable =>
  persistence.remove({
    entity: BILL_ENTITY_TAG,
    id: bill.id,
    version: bill.paymentTransactionId ? bill.version + 1 : bill.version,
  });

/**
 * Delete a credit card: the dry-run preview (no writes — an empty `persist` batch) is unchanged.
 * On confirm, the domain reads every bill and transaction correlated to the card
 * (`findAllByCard`/`findAllCorrelatedToCard`) and decides their removal itself, in FK-safe order:
 * every bill's payment-transfer reference cleared first, then every correlated transaction removed
 * (`transaction_tags` cascades via its own `ON DELETE CASCADE`, not a `Persistable`), then every
 * bill, then the card, then its internal liability account. `resolveCardRef`'s `CreditCard`/
 * `resolveAccountRef`'s `Account` carry no `version`; `findRawById` re-reads supply what the
 * `Persistable`s need.
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
            account: internalAccountNameFor(card.name),
            transactions: counts.transactions,
            bills: counts.bills,
          },
          hint: DELETE_CREDIT_CARD_CONFIRM_HINT,
        },
      });

    const rawCard = yield* okOr(await deps.creditCards.findRawById(card.id), notFound('card', card.id, []));
    const rawAccount = yield* okOr(
      await deps.accounts.findRawById(card.accountId),
      notFound('account', card.accountId, []),
    );
    const correlatedBills = await deps.bills.findAllByCard(card.id);
    const correlatedTransactions = await deps.transactions.findAllCorrelatedToCard(card.id, card.accountId);

    const persist: Persistable[] = [
      ...correlatedBills.flatMap(billClearFor),
      ...correlatedTransactions.map((tx) =>
        persistence.remove({ entity: TRANSACTION_ENTITY_TAG, id: tx.id, version: tx.version }),
      ),
      ...correlatedBills.map(billRemovalFor),
      persistence.remove({ entity: CREDIT_CARD_ENTITY_TAG, id: rawCard.id, version: rawCard.version }),
      persistence.remove({ entity: ACCOUNT_ENTITY_TAG, id: rawAccount.id, version: rawAccount.version }),
    ];
    return ok({ persist, response: { deleted: true as const, card: card.name } });
  });

/**
 * Create a credit card with its internal liability account (ADR-010/ADR-021): a two-entity
 * insert batch — `[insert internal account, insert creditCard]`, account first since the card
 * row's `accountId` is a NOT NULL FK into it.
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

    const internalAccountName = internalAccountNameFor(input.name);
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

/**
 * Update a credit card (mirrors `updateAccount`, Feature Design 007): a rename cascades to the
 * card's internal account (`isCardRename` above) as a two-entity update batch. `paymentAccount`
 * reuses `createCreditCard`'s exact non-credit/currency guard (the #4 regression this design
 * closes). A `closingDay`/`dueDay` change applies to future bill cycles only — existing `bills`
 * rows keep their own already-computed `closeDate`/`dueDate`.
 */
export const updateCreditCard = (deps: Deps, input: UpdateCreditCard): ResultAsync<FlowOutcome<CreditCard>, AppError> =>
  safeTry(async function* () {
    const card = yield* resolveCardRef(deps, input.name);
    yield* guard(!R.isNonNullish(input.currency), cardErrors.currencyChangeRejected);

    if (isCardRename(card.name, input.newName)) {
      yield* guard(await assertCardNameAvailable(deps, input.newName), cardErrors.duplicateName(input.newName));
    }

    let paymentAccountId = card.paymentAccountId;
    if (input.paymentAccount) {
      const paymentAccount = yield* resolveAccountRef(deps, input.paymentAccount);
      yield* guard(assertNonCreditType(paymentAccount.type), accountErrors.creditPaymentRejected);
      yield* guard(
        assertCurrencyMatch({ currency: card.currency }, paymentAccount),
        cardErrors.currencyMismatch(card.currency, paymentAccount.currency),
      );
      paymentAccountId = paymentAccount.id;
    }

    const rawCard = yield* okOr(await deps.creditCards.findRawById(card.id), notFound('card', card.id, []));
    const cardEntity: CreditCardEntity = {
      ...rawCard,
      name: input.newName ?? rawCard.name,
      closingDay: input.closingDay ?? rawCard.closingDay,
      dueDay: input.dueDay ?? rawCard.dueDay,
      limit: input.limit ?? rawCard.limit,
      paymentAccountId,
    };

    const persist: Persistable[] = [];
    if (cardEntity.name !== rawCard.name) {
      const newInternalAccountName = internalAccountNameFor(cardEntity.name);
      if (isCardRename(rawCard.name, input.newName)) {
        yield* guard(
          await assertAccountNameAvailable(deps, newInternalAccountName),
          accountErrors.duplicateName(newInternalAccountName),
        );
      }
      const rawAccount = yield* okOr(
        await deps.accounts.findRawById(card.accountId),
        notFound('account', card.accountId, []),
      );
      persist.push(
        persistence.update({ entity: ACCOUNT_ENTITY_TAG, model: { ...rawAccount, name: newInternalAccountName } }),
      );
    }
    if (!R.isDeepEqual(cardEntity, rawCard)) {
      persist.push(persistence.update({ entity: CREDIT_CARD_ENTITY_TAG, model: cardEntity }));
    }

    return ok({ persist, response: R.omit(cardEntity, ['version']) });
  });
