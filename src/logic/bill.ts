
import { purry } from 'remeda';
import * as R from 'remeda';
import { localizeBillStatus } from './localize.js';
import {
  BILL_PAYMENT_KEY_PREFIX,
  BillStatus,
  type Bill,
  type BillEntity,
  type BillPaymentFacts,
  type BillPaymentPlan,
  type BillPeriod,
  type RawBill,
} from '../models/bill.js';
import type { Locale } from '../models/locale.js';
import {
  ClassificationMethod,
  TransactionType,
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

export const assertBillPeriodPaired = (input: { billMonth?: number; billYear?: number }): boolean =>
  (input.billMonth === undefined) === (input.billYear === undefined);

export const withBillId = <T extends TransactionView>(tx: T, billId: string): T => ({ ...tx, billId });

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

const pad = (n: number): string => String(n).padStart(2, '0');

export const billPeriodKey = (period: Pick<BillPeriod, 'month' | 'year'>): string => `${period.month}-${period.year}`;

const nextMonth = (month: number, year: number): { month: number; year: number } =>
  month === 12 ? { month: 1, year: year + 1 } : { month: month + 1, year };

const periodFor = (month: number, year: number, closingDay: number, dueDay: number): BillPeriod => {
  const due = dueDay <= closingDay ? nextMonth(month, year) : { month, year };
  return {
    month,
    year,
    closeDate: `${year}-${pad(month)}-${pad(closingDay)}`,
    dueDate: `${due.year}-${pad(due.month)}-${pad(dueDay)}`,
  };
};

const signedBillAmount = (t: Pick<TransactionView, 'type' | 'amount'>): number => {
  if (t.type === TransactionType.enum.expense) return t.amount;
  if (t.type === TransactionType.enum.income) return -t.amount;
  return 0;
};

export const computeBillTotal = (transactions: TransactionView[]): number => R.sumBy(transactions, signedBillAmount);

export const billPeriodFor = (txDate: string, closingDay: number, dueDay: number): BillPeriod => {
  const [y, m, d] = txDate.split('-').map(Number) as [number, number, number];
  const bill = d >= closingDay ? nextMonth(m, y) : { month: m, year: y };
  return periodFor(bill.month, bill.year, closingDay, dueDay);
};

export const billPeriodForCycle = (month: number, year: number, closingDay: number, dueDay: number): BillPeriod =>
  periodFor(month, year, closingDay, dueDay);

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

export const billPaymentKey = (billId: string): string => `${BILL_PAYMENT_KEY_PREFIX}${billId}`;

export const billPaymentDescription = (cardName: string, month: number, year: number): string =>
  `Bill payment: ${cardName} ${pad(month)}/${year}`;

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
