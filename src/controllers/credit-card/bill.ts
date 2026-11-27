import { ok, safeTry, type Result, type ResultAsync } from 'neverthrow';
import * as R from 'remeda';
import type { AppError } from '../../common/errors.js';
import { guard, okOr } from '../../common/result.js';
import { assertCurrencyMatch, assertNonCreditType } from '../../logic/account.js';
import {
  billEntityFrom,
  billPaymentKey,
  changesBillTotal,
  computeBillTotal,
  coversPaid,
  hasIdempotencyKey,
  isBillPaid,
  paymentsOf,
  planBillPayment,
  settlement,
  toBillView,
  toSettledBill,
  totalAfterChange,
  withStatusLabel,
} from '../../logic/bill.js';
import { roundToDecimals } from '../../logic/money.js';
import * as persistence from '../../logic/persistence.js';
import { toIsoDate } from '../../logic/period.js';
import { addLocalizedLabels } from '../../logic/transaction.js';
import { accountErrors, type Account } from '../../models/account.js';
import {
  billErrors,
  BILL_ENTITY_TAG,
  BillStatus,
  type Bill,
  type BillContext,
  type BillPayment,
  type BillQuery,
  type BillTotalChange,
  type BillView,
  type PayBillInput,
  type RawBill,
  type RevertBillPayment,
  type SettledBill,
} from '../../models/bill.js';
import { cardErrors, type CreditCard } from '../../models/credit-card.js';
import { notFound } from '../../models/error.js';
import type { FlowOutcome, Persistable } from '@rfc0/effect-runner';
import {
  TRANSACTION_ENTITY_TAG,
  transactionErrors,
  type RawTransactionView,
  type TransactionEntity,
} from '../../models/transaction.js';
import type { Deps } from '../deps.js';
import { resolveAccountRef, resolveCardRef, resolveDecimals } from '../resolve.js';

const settledBillOf = (bill: Bill, items: RawTransactionView[], card: CreditCard, decimals: number): SettledBill => {
  const payments = paymentsOf(items, card.accountId);
  return toSettledBill(bill, payments, settlement(computeBillTotal(items), payments, decimals));
};

export const getBill = (deps: Deps, input: BillQuery): ResultAsync<BillView, AppError> =>
  safeTry(async function* () {
    const card = yield* resolveCardRef(deps, input.card);
    const bill = yield* okOr(
      await deps.bills.get(card.id, input.month, input.year),
      billErrors.notFound(card.name, input.month, input.year),
    );
    const locale = await deps.locale();
    const decimals = await resolveDecimals(deps, card.currency);
    return ok({
      ...bill,
      bill: settledBillOf(withStatusLabel(bill.bill, locale), bill.transactions, card, decimals),
      transactions: bill.transactions.map(addLocalizedLabels(locale)),
      total: computeBillTotal(bill.transactions),
    });
  });

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

const withStatus = (rawBill: RawBill, status: BillStatus): Persistable =>
  persistence.update({ entity: BILL_ENTITY_TAG, model: { ...billEntityFrom(rawBill), status } });

const settledAfter = (
  rawBill: RawBill,
  status: BillStatus,
  total: number,
  payments: BillPayment[],
  decimals: number,
): SettledBill => toSettledBill({ ...toBillView(rawBill), status }, payments, settlement(total, payments, decimals));

const guardPaymentAmount = (amount: number, remaining: number): Result<void, AppError> =>
  safeTry(function* () {
    yield* guard(amount > 0, billErrors.amountBelowPrecision);
    yield* guard(amount <= remaining, billErrors.amountExceedsRemaining(remaining));
    return ok();
  });

const unchanged = (bill: SettledBill): FlowOutcome<SettledBill> => ({ persist: [], response: bill });

const settleWithoutTransfer = (
  rawBill: RawBill,
  total: number,
  payments: BillPayment[],
  decimals: number,
): FlowOutcome<SettledBill> => ({
  persist: [withStatus(rawBill, BillStatus.enum.paid)],
  response: settledAfter(rawBill, BillStatus.enum.paid, total, payments, decimals),
});

const loadBillContext = (deps: Deps, input: BillQuery): ResultAsync<BillContext, AppError> =>
  safeTry(async function* () {
    const card = yield* resolveCardRef(deps, input.card);
    const billNotFound = billErrors.notFound(card.name, input.month, input.year);
    // The version is read before the payments: a payment landing in between then makes the write conflict
    // instead of passing the amount guard on stale data.
    const rawBill = yield* okOr(await deps.bills.findByCycle(card.id, input.month, input.year), billNotFound);
    const existing = yield* okOr(await deps.bills.get(card.id, input.month, input.year), billNotFound);
    const decimals = await resolveDecimals(deps, card.currency);
    const current = settledBillOf(existing.bill, existing.transactions, card, decimals);
    return ok({ card, existing, decimals, current, total: computeBillTotal(existing.transactions), rawBill });
  });

const planPayment = (
  deps: Deps,
  input: PayBillInput,
  context: BillContext,
  dates: { date: string; today: string },
): ResultAsync<FlowOutcome<SettledBill>, AppError> =>
  safeTry(async function* () {
    const { card, existing, current, decimals, total, rawBill } = context;
    const amount = roundToDecimals(input.amount ?? current.remaining, decimals);
    const facts = { bill: rawBill, date: dates.date, amount, decimals, discriminator: input.discriminator };
    if (hasIdempotencyKey(existing.transactions, billPaymentKey(facts))) return ok(unchanged(current));
    yield* guardPaymentAmount(amount, current.remaining);

    const payer = yield* resolvePayer(deps, card, input.account);
    const plan = planBillPayment({ ...facts, id: deps.newId(), card, payer, today: dates.today, source: input.source });
    const payment = { id: plan.transferEntity.id, date: dates.date, amount, account: payer.name };
    const status = amount === current.remaining ? BillStatus.enum.paid : rawBill.status;
    const transfer = persistence.insert({
      entity: TRANSACTION_ENTITY_TAG,
      model: plan.transferEntity,
      idempotencyKey: plan.idempotencyKey,
    });
    return ok({
      persist: [transfer, withStatus(rawBill, status)],
      response: settledAfter(
        rawBill,
        status,
        total,
        R.sortBy([...current.payments, payment], (p) => p.date),
        decimals,
      ),
    });
  });

export const payBill = (deps: Deps, input: PayBillInput): ResultAsync<FlowOutcome<SettledBill>, AppError> =>
  safeTry(async function* () {
    const context = yield* loadBillContext(deps, input);
    const { existing, current, total, decimals, rawBill } = context;
    if (isBillPaid(existing.bill)) return ok(unchanged(current));

    const today = toIsoDate(deps.clock());
    const date = input.paymentDate ?? today;
    yield* guard(date <= today, billErrors.futurePaymentDate(date));

    if (current.remaining <= 0) return ok(settleWithoutTransfer(rawBill, total, current.payments, decimals));
    return ok(yield* planPayment(deps, input, context, { date, today }));
  });

const pickPayment = (
  payments: BillPayment[],
  paymentId: string | undefined,
): Result<BillPayment | undefined, AppError> =>
  safeTry(function* () {
    if (paymentId) return ok(R.find(payments, (p) => p.id === paymentId));
    yield* guard(payments.length <= 1, billErrors.paymentIdRequired(R.map(payments, (p) => p.id)));
    return ok(R.first(payments));
  });

const buildRevert = (
  rawBill: RawBill,
  transfer: RawTransactionView | undefined,
  total: number,
  payments: BillPayment[],
  decimals: number,
): FlowOutcome<SettledBill> => {
  const status = rawBill.status === BillStatus.enum.paid ? BillStatus.enum.closed : rawBill.status;
  const removal = transfer
    ? [persistence.remove({ entity: TRANSACTION_ENTITY_TAG, id: transfer.id, version: transfer.version })]
    : [];
  return {
    persist: [withStatus(rawBill, status), ...removal],
    response: settledAfter(rawBill, status, total, payments, decimals),
  };
};

export const revertBillPayment = (
  deps: Deps,
  input: RevertBillPayment,
): ResultAsync<FlowOutcome<SettledBill>, AppError> =>
  safeTry(async function* () {
    const { existing, current, total, decimals, rawBill } = yield* loadBillContext(deps, input);
    const settledWithoutPayment = !input.paymentId && R.isEmpty(current.payments) && isBillPaid(existing.bill);
    if (settledWithoutPayment) return ok(buildRevert(rawBill, undefined, total, [], decimals));

    const payment = yield* pickPayment(current.payments, input.paymentId);
    if (!payment) return ok(unchanged(current));
    const transfer = yield* okOr(
      R.find(existing.transactions, (tx) => tx.id === payment.id),
      transactionErrors.notFound(payment.id),
    );
    const remaining = R.filter(current.payments, (p) => p.id !== payment.id);
    return ok(buildRevert(rawBill, transfer, total, remaining, decimals));
  });

export const guardTotalCoversPaid = (
  deps: Deps,
  bill: Pick<RawBill, 'creditCardId' | 'month' | 'year'>,
  change: BillTotalChange,
): ResultAsync<void, AppError> =>
  safeTry(async function* () {
    const card = yield* okOr(
      await deps.creditCards.findById(bill.creditCardId),
      notFound('card', bill.creditCardId, []),
    );
    const items = (await deps.bills.get(card.id, bill.month, bill.year))?.transactions ?? [];
    if (change.addedKey && hasIdempotencyKey(items, change.addedKey)) return ok();
    const decimals = await resolveDecimals(deps, card.currency);
    const { paidAmount } = settlement(computeBillTotal(items), paymentsOf(items, card.accountId), decimals);
    yield* guard(
      coversPaid(totalAfterChange(items, change), paidAmount, decimals),
      billErrors.totalBelowPaid(paidAmount),
    );
    return ok();
  });

export const touchBill = (bill: RawBill): Persistable =>
  persistence.update({ entity: BILL_ENTITY_TAG, model: billEntityFrom(bill) });

const guardBillChange = (
  deps: Deps,
  billId: string | undefined,
  change: BillTotalChange,
): ResultAsync<void, AppError> =>
  safeTry(async function* () {
    const bill = billId ? await deps.bills.findById(billId) : null;
    if (bill) yield* guardTotalCoversPaid(deps, bill, change);
    return ok();
  });

/** Refuses a total-changing edit of a paid bill's transaction, or one that leaves the bill's payments uncovered.
 *  Returns the bill read before its payments, for the caller to write back under its version. */
export const guardBillTotalEdit = (
  deps: Deps,
  existing: Pick<RawTransactionView, 'id' | 'type' | 'amount' | 'billId'>,
  entity: Pick<TransactionEntity, 'type' | 'amount' | 'refs'>,
): ResultAsync<RawBill | null, AppError> =>
  safeTry(async function* () {
    if (!changesBillTotal(existing, entity)) return ok(null);
    const currentBill = existing.billId ? await deps.bills.findById(existing.billId) : null;
    yield* guard(!currentBill || !isBillPaid(currentBill), cardErrors.paidBillImmutable);
    const sameBill = entity.refs.billId === existing.billId;
    yield* guardBillChange(deps, existing.billId, { removedId: existing.id, added: sameBill ? entity : undefined });
    if (!sameBill) yield* guardBillChange(deps, entity.refs.billId, { added: entity });
    return ok(currentBill);
  });
