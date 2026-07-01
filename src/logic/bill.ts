/** Pure fatura-cycle math: which bill a card transaction belongs to. */

import { purry } from 'remeda';
import { localizeBillStatus } from './localize.js';
import type { Bill } from '../models/bill.js';
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

export type BillPeriod = { month: number; year: number; closeDate: string; dueDate: string };

const pad = (n: number): string => String(n).padStart(2, '0');

const nextMonth = (month: number, year: number): { month: number; year: number } =>
  month === 12 ? { month: 1, year: year + 1 } : { month: month + 1, year };

/** Bill amount due: expenses increase the total, income (refunds/credits) decrease it, transfers are excluded. */
export const computeBillTotal = (transactions: TransactionView[]): number =>
  transactions.reduce((acc, t) => {
    if (t.type === TransactionType.enum.expense) return acc + t.amount;
    if (t.type === TransactionType.enum.income) return acc - t.amount;
    return acc;
  }, 0);

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
  const due = dueDay <= closingDay ? nextMonth(bill.month, bill.year) : bill;
  return {
    month: bill.month,
    year: bill.year,
    closeDate: `${bill.year}-${pad(bill.month)}-${pad(closingDay)}`,
    dueDate: `${due.year}-${pad(due.month)}-${pad(dueDay)}`,
  };
};
