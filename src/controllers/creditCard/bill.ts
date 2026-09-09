import { ok, safeTry, type ResultAsync } from 'neverthrow';
import type { AppError } from '../../common/errors.js';
import { guard, okOr } from '../../common/result.js';
import { assertCurrencyMatch, assertNonCreditType } from '../../logic/account.js';
import { billEntityFrom, computeBillTotal, toBillView, withStatusLabel } from '../../logic/bill.js';
import * as persistence from '../../logic/persistence.js';
import { toIsoDate } from '../../logic/period.js';
import { addLocalizedLabels, defaultStatusFor } from '../../logic/transaction.js';
import { accountErrors } from '../../models/account.js';
import {
  billErrors,
  BILL_ENTITY_TAG,
  BillStatus,
  type Bill,
  type BillQuery,
  type BillView,
  type PayBill,
  type RawBill,
} from '../../models/bill.js';
import type { FlowOutcome, Persistable } from '../../models/persistable.js';
import {
  ClassificationMethod,
  TRANSACTION_ENTITY_TAG,
  type RawTransactionView,
  type TransactionEntity,
  type TransactionSource as TransactionSourceType,
  TransactionType,
} from '../../models/transaction.js';
import type { Deps } from '../deps.js';
import { resolveAccountRef, resolveCardRef } from '../resolve.js';

export const getBill = (deps: Deps, input: BillQuery): ResultAsync<BillView, AppError> =>
  safeTry(async function* () {
    const card = yield* resolveCardRef(deps, input.card);
    const bill = yield* okOr(
      await deps.bills.get(card.id, input.month, input.year),
      billErrors.notFound(card.name, input.month, input.year),
    );
    const locale = await deps.locale();
    return ok({
      ...bill,
      bill: withStatusLabel(bill.bill, locale),
      transactions: bill.transactions.map(addLocalizedLabels(locale)),
      total: computeBillTotal(bill.transactions),
    });
  });

export type PayBillInput = PayBill & { source: TransactionSourceType };

const buildPaidBillWrite = (
  rawBill: RawBill,
  paymentTransactionId?: string,
): { persistable: Persistable; response: Bill } => {
  const status = BillStatus.enum.paid;
  return {
    persistable: persistence.update({
      entity: BILL_ENTITY_TAG,
      model: { ...billEntityFrom(rawBill), status, paymentTransactionId },
    }),
    response: { ...toBillView(rawBill), status, paymentTransactionId },
  };
};

export const payBill = (deps: Deps, input: PayBillInput): ResultAsync<FlowOutcome<Bill>, AppError> =>
  safeTry(async function* () {
    const card = yield* resolveCardRef(deps, input.card);
    const existing = yield* okOr(
      await deps.bills.get(card.id, input.month, input.year),
      billErrors.notFound(card.name, input.month, input.year),
    );

    if (existing.bill.status === BillStatus.enum.paid) {
      return ok({ persist: [], response: existing.bill });
    }

    const today = toIsoDate(deps.clock());
    const date = input.paymentDate ?? today;
    yield* guard(date <= today, billErrors.futurePaymentDate(date));

    const total = computeBillTotal(existing.transactions);
    const rawBill = yield* okOr(
      await deps.bills.findById(existing.bill.id),
      billErrors.notFound(card.name, input.month, input.year),
    );

    if (total <= 0) {
      const { persistable, response } = buildPaidBillWrite(rawBill);
      return ok({ persist: [persistable], response });
    }

    // Resolve the paying account: explicit > card default > error
    const payer = input.account
      ? yield* resolveAccountRef(deps, input.account)
      : yield* okOr(
          card.paymentAccountId ? await deps.accounts.findById(card.paymentAccountId) : null,
          billErrors.noPayingAccount,
        );

    yield* guard(assertNonCreditType(payer.type), accountErrors.creditPaymentRejected);
    yield* guard(assertCurrencyMatch(payer, card), accountErrors.currencyMismatch(card.currency, payer.currency));

    const txId = deps.newId();
    const transferEntity: TransactionEntity = {
      id: txId,
      description: `Bill payment: ${card.name} ${String(input.month).padStart(2, '0')}/${input.year}`,
      amount: total,
      type: TransactionType.enum.transfer,
      status: defaultStatusFor(date, today),
      date,
      currency: card.currency,
      source: input.source,
      classification: { method: ClassificationMethod.enum.none, confidence: 0 },
      refs: { accountId: payer.id, toAccountId: card.accountId, billId: rawBill.id },
    };

    // Transfer must be inserted before the bill update that points paymentTransactionId at its id.
    const { persistable: billUpdate, response } = buildPaidBillWrite(rawBill, txId);
    const persist: Persistable[] = [
      persistence.insert({
        entity: TRANSACTION_ENTITY_TAG,
        model: transferEntity,
        idempotencyKey: `billpay-${rawBill.id}`,
      }),
      billUpdate,
    ];
    return ok({ persist, response });
  });

// paymentTransactionId: null, not undefined — undefined would leave the column unchanged.
const buildClosedBillWrite = (rawBill: RawBill): { persistable: Persistable; response: Bill } => ({
  persistable: persistence.update({
    entity: BILL_ENTITY_TAG,
    model: { ...billEntityFrom(rawBill), status: BillStatus.enum.closed, paymentTransactionId: null },
  }),
  response: { ...toBillView(rawBill), status: BillStatus.enum.closed, paymentTransactionId: undefined },
});

const tryFindPaymentTransaction = (deps: Deps, rawBill: RawBill): Promise<RawTransactionView | null> =>
  rawBill.paymentTransactionId ? deps.transactions.getById(rawBill.paymentTransactionId) : Promise.resolve(null);

export const revertBillPayment = (deps: Deps, input: BillQuery): ResultAsync<FlowOutcome<Bill>, AppError> =>
  safeTry(async function* () {
    const card = yield* resolveCardRef(deps, input.card);
    const existing = yield* okOr(
      await deps.bills.get(card.id, input.month, input.year),
      billErrors.notFound(card.name, input.month, input.year),
    );

    if (existing.bill.status !== BillStatus.enum.paid) {
      return ok({ persist: [], response: existing.bill });
    }

    const rawBill = yield* okOr(
      await deps.bills.findById(existing.bill.id),
      billErrors.notFound(card.name, input.month, input.year),
    );

    const { persistable: billUpdate, response } = buildClosedBillWrite(rawBill);
    const persist: Persistable[] = [billUpdate];

    const paymentTx = await tryFindPaymentTransaction(deps, rawBill);
    if (paymentTx) {
      persist.push(
        persistence.remove({ entity: TRANSACTION_ENTITY_TAG, id: paymentTx.id, version: paymentTx.version }),
      );
    }
    return ok({ persist, response });
  });
