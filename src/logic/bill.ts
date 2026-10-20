/** Pure fatura-cycle math: which bill a card transaction belongs to. */

import { purry } from 'remeda';
import * as R from 'remeda';
import { localizeBillStatus } from './localize.js';
import { BillStatus, type Bill, type BillEntity, type RawBill } from '../models/bill.js';
import type { Locale } from '../models/locale.js';
import type { CurrencyCode } from '../models/money.js';
import {
  ClassificationMethod,
  TransactionType,
  type TransactionEntity,
  type TransactionSource,
  type TransactionView,
} from '../models/transaction.js';
import { defaultStatusFor } from './transaction.js';

const _withStatusLabel = (bill: Bill, locale: Locale): Bill => ({
  ...bill,
  statusLabel: localizeBillStatus(bill.status, locale),
});

export function withStatusLabel(bill: Bill, locale: Locale): Bill;
export function withStatusLabel(locale: Locale): (bill: Bill) => Bill;
export function withStatusLabel(...args: readonly unknown[]) {
  return purry(_withStatusLabel, args);
}

export const isBillPaid = (bill: Pick<Bill, 'status'>): boolean => bill.status === BillStatus.enum.paid;

/** billMonth/billYear (bill assignment) must be provided together, or not at all (ADR-019 PR-2). */
export const assertBillPeriodPaired = (input: { billMonth?: number; billYear?: number }): boolean =>
  (input.billMonth === undefined) === (input.billYear === undefined);

/** Reports a transaction's (new) bill assignment — used after create/update attaches or reassigns
 *  it, on either the raw (pre-`addLocalizedLabels`) or already-localized view, hence generic over
 *  either `TransactionView` shape rather than fixed to one. */
export const withBillId = <T extends TransactionView>(tx: T, billId: string): T => ({ ...tx, billId });

/** Builds a bill `Persistable` model from an already-read `RawBill` — used for a version-guarded
 *  "touch" (same fields, guarding only `version`). */
export const billEntityFrom = (bill: RawBill): BillEntity & { version: number } => ({
  id: bill.id,
  creditCardId: bill.creditCardId,
  month: bill.month,
  year: bill.year,
  closeDate: bill.closeDate,
  dueDate: bill.dueDate,
  status: bill.status,
  paymentTransactionId: bill.paymentTransactionId,
  version: bill.version,
});

export const toBillView = (bill: RawBill): Bill => R.omit(bill, ['creditCardId', 'version']);

export type BillPeriod = { month: number; year: number; closeDate: string; dueDate: string };

const pad = (n: number): string => String(n).padStart(2, '0');

/** Identity of a bill cycle inside an idempotency key — the one place its `month-year` form is built. */
export const billPeriodKey = (period: Pick<BillPeriod, 'month' | 'year'>): string => `${period.month}-${period.year}`;

const nextMonth = (month: number, year: number): { month: number; year: number } =>
  month === 12 ? { month: 1, year: year + 1 } : { month: month + 1, year };

/** Close/due-date math for a known bill cycle — shared by billPeriodFor and billPeriodForCycle. */
const periodFor = (month: number, year: number, closingDay: number, dueDay: number): BillPeriod => {
  const due = dueDay <= closingDay ? nextMonth(month, year) : { month, year };
  return {
    month,
    year,
    closeDate: `${year}-${pad(month)}-${pad(closingDay)}`,
    dueDate: `${due.year}-${pad(due.month)}-${pad(dueDay)}`,
  };
};

/** Signed contribution to a bill's total: expenses add, income (refunds/credits) subtracts, transfers don't count. */
const signedBillAmount = (t: Pick<TransactionView, 'type' | 'amount'>): number => {
  if (t.type === TransactionType.enum.expense) return t.amount;
  if (t.type === TransactionType.enum.income) return -t.amount;
  return 0;
};

/** Bill amount due: expenses increase the total, income (refunds/credits) decrease it, transfers are excluded. */
export const computeBillTotal = (transactions: TransactionView[]): number => R.sumBy(transactions, signedBillAmount);

/**
 * Transactions on or after the closing day belong to the NEXT month's bill.
 * The closing day marks the end of a billing cycle — any transaction dated on
 * that day is already part of the new cycle.
 * The due date falls in the month after close when dueDay <= closingDay
 * (e.g. closes on the 28th, due on the 5th of the following month).
 */
export const billPeriodFor = (txDate: string, closingDay: number, dueDay: number): BillPeriod => {
  const [y, m, d] = txDate.split('-').map(Number) as [number, number, number];
  const bill = d >= closingDay ? nextMonth(m, y) : { month: m, year: y };
  return periodFor(bill.month, bill.year, closingDay, dueDay);
};

/**
 * Explicit-cycle variant of billPeriodFor: the target month/year is already known (a manual bill
 * assignment) rather than derived from a transaction date. Same close/due-date math.
 */
export const billPeriodForCycle = (month: number, year: number, closingDay: number, dueDay: number): BillPeriod =>
  periodFor(month, year, closingDay, dueDay);

/** Target bill cycle for a card purchase: an explicit `billMonth`/`billYear` override when given
 *  (assumed already paired — see `assertBillPeriodPaired`), else derived from the transaction date. */
export const resolveBillPeriod = (
  billMonth: number | undefined,
  billYear: number | undefined,
  date: string,
  closingDay: number,
  dueDay: number,
): BillPeriod =>
  R.isNonNullish(billMonth) && R.isNonNullish(billYear)
    ? billPeriodForCycle(billMonth, billYear, closingDay, dueDay)
    : billPeriodFor(date, closingDay, dueDay);

// ─── Bill payment ────────────────────────────────────────────────────────────

const BILL_PAYMENT_KEY_PREFIX = 'billpay-';

/** One payment transfer per bill: re-paying the same bill derives the same key. */
export const billPaymentKey = (billId: string): string => `${BILL_PAYMENT_KEY_PREFIX}${billId}`;

export const billPaymentDescription = (cardName: string, month: number, year: number): string =>
  `Bill payment: ${cardName} ${pad(month)}/${year}`;

export type BillPaymentFacts = {
  /** The id the payment transfer is minted with — the bill update points `paymentTransactionId` at it. */
  id: string;
  card: { name: string; currency: CurrencyCode; accountId: string };
  payer: { id: string };
  bill: Pick<RawBill, 'id' | 'month' | 'year'>;
  total: number;
  date: string;
  today: string;
  source: TransactionSource;
};

export type BillPaymentPlan = { transferEntity: TransactionEntity; idempotencyKey: string };

/** The transfer that settles a bill: payer account → the card's internal account, linked to the bill. */
export const planBillPayment = (facts: BillPaymentFacts): BillPaymentPlan => ({
  transferEntity: {
    id: facts.id,
    description: billPaymentDescription(facts.card.name, facts.bill.month, facts.bill.year),
    amount: facts.total,
    type: TransactionType.enum.transfer,
    status: defaultStatusFor(facts.date, facts.today),
    date: facts.date,
    currency: facts.card.currency,
    source: facts.source,
    classification: { method: ClassificationMethod.enum.none, confidence: 0 },
    refs: { accountId: facts.payer.id, toAccountId: facts.card.accountId, billId: facts.bill.id },
  },
  idempotencyKey: billPaymentKey(facts.bill.id),
});
