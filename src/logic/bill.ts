/** Pure fatura-cycle math: which bill a card transaction belongs to. */

import { purry } from 'remeda';
import * as R from 'remeda';
import { localizeBillStatus } from './localize.js';
import { BillStatus, type Bill, type BillEntity, type RawBill } from '../models/bill.js';
import type { Locale } from '../models/locale.js';
import { TransactionType, type TransactionView } from '../models/transaction.js';

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

export type BillPeriod = { month: number; year: number; closeDate: string; dueDate: string };

const pad = (n: number): string => String(n).padStart(2, '0');

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
