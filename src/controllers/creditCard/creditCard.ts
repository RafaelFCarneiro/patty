import { ok, safeTry, type ResultAsync } from 'neverthrow';
import type { CurrencyCode } from '../../models/money.js';
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
  type DeleteCreditCardResult,
} from '../../models/creditCard.js';
import { notFound } from '../../models/error.js';
import type { FlowOutcome, Persistable } from '@rfc0/effect-runner';
import { TRANSACTION_ENTITY_TAG } from '../../models/transaction.js';
import type { Deps } from '../deps.js';
import { resolveAccountRef, resolveCardRef } from '../resolve.js';

export const listCreditCards = (deps: Deps): Promise<CreditCard[]> => deps.creditCards.list();

const assertCardNameAvailable = async (deps: Deps, name: string): Promise<boolean> =>
  !(await deps.creditCards.findByName(name));

const assertAccountNameAvailable = async (deps: Deps, name: string): Promise<boolean> =>
  !(await deps.accounts.findByName(name));

const billClearFor = (bill: RawBill): Persistable[] =>
  bill.paymentTransactionId
    ? [persistence.update({ entity: BILL_ENTITY_TAG, model: { ...billEntityFrom(bill), paymentTransactionId: null } })]
    : [];

const billRemovalFor = (bill: RawBill): Persistable =>
  persistence.remove({
    entity: BILL_ENTITY_TAG,
    id: bill.id,
    version: bill.paymentTransactionId ? bill.version + 1 : bill.version,
  });

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

const resolvePaymentAccount = (deps: Deps, name: string, cardCurrency: CurrencyCode): ResultAsync<Account, AppError> =>
  safeTry(async function* () {
    const paymentAccount = yield* resolveAccountRef(deps, name);
    yield* guard(assertNonCreditType(paymentAccount.type), accountErrors.creditPaymentRejected);
    yield* guard(
      assertCurrencyMatch({ currency: cardCurrency }, paymentAccount),
      cardErrors.currencyMismatch(cardCurrency, paymentAccount.currency),
    );
    return ok(paymentAccount);
  });

const renameInternalAccount = (
  deps: Deps,
  card: CreditCard,
  newCardName: string,
  isRename: boolean,
): ResultAsync<Persistable, AppError> =>
  safeTry(async function* () {
    const newInternalAccountName = internalAccountNameFor(newCardName);
    if (isRename) {
      yield* guard(
        await assertAccountNameAvailable(deps, newInternalAccountName),
        accountErrors.duplicateName(newInternalAccountName),
      );
    }
    const rawAccount = yield* okOr(
      await deps.accounts.findRawById(card.accountId),
      notFound('account', card.accountId, []),
    );
    return ok(
      persistence.update({ entity: ACCOUNT_ENTITY_TAG, model: { ...rawAccount, name: newInternalAccountName } }),
    );
  });

export const createCreditCard = (deps: Deps, input: CreateCreditCard): ResultAsync<FlowOutcome<CreditCard>, AppError> =>
  safeTry(async function* () {
    yield* guard(await assertCardNameAvailable(deps, input.name), cardErrors.duplicateName(input.name));

    const paymentAccountId = input.paymentAccount
      ? (yield* resolvePaymentAccount(deps, input.paymentAccount, input.currency)).id
      : undefined;

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

export const updateCreditCard = (deps: Deps, input: UpdateCreditCard): ResultAsync<FlowOutcome<CreditCard>, AppError> =>
  safeTry(async function* () {
    const card = yield* resolveCardRef(deps, input.name);
    yield* guard(!R.isNonNullish(input.currency), cardErrors.currencyChangeRejected);

    if (isCardRename(card.name, input.newName)) {
      yield* guard(await assertCardNameAvailable(deps, input.newName), cardErrors.duplicateName(input.newName));
    }

    const paymentAccountId = input.paymentAccount
      ? (yield* resolvePaymentAccount(deps, input.paymentAccount, card.currency)).id
      : card.paymentAccountId;

    const rawCard = yield* okOr(await deps.creditCards.findRawById(card.id), notFound('card', card.id, []));
    const cardEntity: CreditCardEntity = {
      ...rawCard,
      name: input.newName ?? rawCard.name,
      closingDay: input.closingDay ?? rawCard.closingDay,
      dueDay: input.dueDay ?? rawCard.dueDay,
      limit: input.limit ?? rawCard.limit,
      paymentAccountId,
    };

    const accountRename: Persistable[] =
      cardEntity.name !== rawCard.name
        ? [yield* renameInternalAccount(deps, card, cardEntity.name, isCardRename(rawCard.name, input.newName))]
        : [];
    const persist: Persistable[] = [
      ...accountRename,
      ...(R.isDeepEqual(cardEntity, rawCard)
        ? []
        : [persistence.update({ entity: CREDIT_CARD_ENTITY_TAG, model: cardEntity })]),
    ];

    return ok({ persist, response: R.omit(cardEntity, ['version']) });
  });
