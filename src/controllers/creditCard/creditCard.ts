import { ok, safeTry, type ResultAsync } from 'neverthrow';
import type { AppError } from '../../common/errors.js';
import { guard, okOr } from '../../common/result.js';
import { assertCurrencyMatch, assertNonCreditType } from '../../logic/account.js';
import { billEntityFrom } from '../../logic/bill.js';
import * as persistence from '../../logic/persistence.js';
import { accountErrors, ACCOUNT_ENTITY_TAG, AccountType, type Account } from '../../models/account.js';
import { BILL_ENTITY_TAG, type RawBill } from '../../models/bill.js';
import { cardErrors, CREDIT_CARD_ENTITY_TAG, type CreateCreditCard, type CreditCard } from '../../models/creditCard.js';
import { notFound } from '../../models/error.js';
import type { FlowOutcome, Persistable } from '../../models/persistable.js';
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

/**
 * A bill with a payment transfer has a circular reference with it: `bills
 * .payment_transaction_id` points at the transfer, and the transfer's own `bill_id` points back at
 * the bill — and libsql enforces foreign keys, with no `ON DELETE` action declared on either
 * column. Deleting both therefore needs the reference broken first: `payment_transaction_id`
 * cleared (an `update`) before the transfer can be removed, and the bill's own removal ordered
 * after that. Returns just the `update` when there's a transfer to unlink, nothing for a bill that
 * never had one — the version-guarded `remove` for the bill itself lives in `billRemovalFor` below,
 * not here, since it must always run last regardless.
 */
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
 * Delete a credit card (ADR-021): the dry-run preview (no writes — an empty `persist` batch,
 * mirroring `deleteAccountTransaction`) is unchanged. On confirm, the domain reads every bill and
 * transaction correlated to the card (`findAllByCard`/`findAllCorrelatedToCard`) and decides their
 * removal itself, rather than leaving "what does deleting a card cascade to" as a repo-side
 * decision (the exact ADR-015/018 smell ADR-021 exists to remove) — an earlier version of this
 * flow left that cascade to `creditCardApplier`; it's `versionedTableApplier(creditCards)` now,
 * with nothing left to decide once the domain owns the batch. FK-safe order, matching the
 * pre-ADR-021 `deleteCard` repo method's own reasoning: every bill's payment-transfer reference
 * cleared first, then every correlated transaction removed (transaction_tags cascades via its own
 * `ON DELETE CASCADE` — a genuine DB mechanic, not a business decision, so it stays declarative
 * schema, never a `Persistable`), then every bill removed, then the card, then its internal
 * liability account. `resolveCardRef`'s `CreditCard`/`resolveAccountRef`'s `Account` carry no
 * `version`; version-carrying re-reads (`findRawById`) supply what the `Persistable`s need.
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
