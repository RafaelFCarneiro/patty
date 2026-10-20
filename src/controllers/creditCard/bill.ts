import { ok, safeTry, type ResultAsync } from 'neverthrow';
import type { AppError } from '../../common/errors.js';
import { guard, okOr } from '../../common/result.js';
import { assertCurrencyMatch, assertNonCreditType } from '../../logic/account.js';
import {
  billEntityFrom,
  computeBillTotal,
  planBillPayment,
  toBillView,
  withStatusLabel,
} from '../../logic/bill.js';
import * as persistence from '../../logic/persistence.js';
import { toIsoDate } from '../../logic/period.js';
import { addLocalizedLabels } from '../../logic/transaction.js';
import { accountErrors, type Account } from '../../models/account.js';
import { billErrors, BILL_ENTITY_TAG, BillStatus, type Bill, type BillPaymentPlan, type BillQuery, type BillView, type RawBill } from '../../models/bill.js';
import type { CreditCard } from '../../models/creditCard.js';
import type { FlowOutcome, Persistable } from '@rfc0/effect-runner';
import { TRANSACTION_ENTITY_TAG, type RawTransactionView } from '../../models/transaction.js';
import type { Deps } from '../deps.js';
import { resolveAccountRef, resolveCardRef } from '../resolve.js';
import { PayBillInput } from '../../models/bill.js';

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

const resolvePayer = (deps: Deps, card: CreditCard, accountRef: string | undefined): ResultAsync<Account, AppError> =>
  safeTry(async function* () {
    const payer = accountRef
      ? yield* resolveAccountRef(deps, accountRef)
      : yield* okOr(
          card.paymentAccountId ? await deps.accounts.findById(card.paymentAccountId) : null,
          billErrors.noPayingAccount,
        );
    yield* guard(assertNonCreditType(payer.type), accountErrors.creditPaymentRejected);
    yield* guard(assertCurrencyMatch(payer, card), accountErrors.currencyMismatch(card.currency, payer.currency));
    return ok(payer);
  });

const settleWithoutTransfer = (rawBill: RawBill): FlowOutcome<Bill> => {
  const { persistable, response } = buildPaidBillWrite(rawBill);
  return { persist: [persistable], response };
};

const settleWithTransfer = (rawBill: RawBill, plan: BillPaymentPlan): FlowOutcome<Bill> => {
  const { persistable: billUpdate, response } = buildPaidBillWrite(rawBill, plan.transferEntity.id);
  // The transfer is inserted before the bill update that points paymentTransactionId at it.
  const transfer = persistence.insert({
    entity: TRANSACTION_ENTITY_TAG,
    model: plan.transferEntity,
    idempotencyKey: plan.idempotencyKey,
  });
  return { persist: [transfer, billUpdate], response };
};

export const payBill = (deps: Deps, input: PayBillInput): ResultAsync<FlowOutcome<Bill>, AppError> =>
  safeTry(async function* () {
    const card = yield* resolveCardRef(deps, input.card);
    const billNotFound = billErrors.notFound(card.name, input.month, input.year);
    const existing = yield* okOr(await deps.bills.get(card.id, input.month, input.year), billNotFound);
    if (existing.bill.status === BillStatus.enum.paid) return ok({ persist: [], response: existing.bill });

    const today = toIsoDate(deps.clock());
    const date = input.paymentDate ?? today;
    yield* guard(date <= today, billErrors.futurePaymentDate(date));

    const total = computeBillTotal(existing.transactions);
    const rawBill = yield* okOr(await deps.bills.findById(existing.bill.id), billNotFound);
    if (total <= 0) return ok(settleWithoutTransfer(rawBill));

    const payer = yield* resolvePayer(deps, card, input.account);
    const plan = planBillPayment({
      id: deps.newId(),
      card,
      payer,
      bill: rawBill,
      total,
      date,
      today,
      source: input.source,
    });
    return ok(settleWithTransfer(rawBill, plan));
  });

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

    const paymentTx = await tryFindPaymentTransaction(deps, rawBill);
    const persist: Persistable[] = [
      billUpdate,
      ...(paymentTx
        ? [persistence.remove({ entity: TRANSACTION_ENTITY_TAG, id: paymentTx.id, version: paymentTx.version })]
        : []),
    ];
    return ok({ persist, response });
  });
