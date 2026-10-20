import * as R from 'remeda';
import { purry } from 'remeda';
import { localizeCategoryName } from './category.js';
import { roundToDecimals } from './money.js';
import type { CurrencyCode, DecimalsFor } from '../models/money.js';
import type { Locale } from '../models/locale.js';
import type { CurrencySummary, SummaryRow } from '../models/summary.js';
import { TransactionType } from '../models/transaction.js';
import { uncategorizedLabels } from '../models/aggregate.js';

const sumOf = (rows: readonly SummaryRow[], type: TransactionType, decimals: number): number =>
  roundToDecimals(
    R.pipe(
      rows,
      R.filter((r) => r.type === type),
      R.sumBy((r) => r.total),
    ),
    decimals,
  );

const _toCurrencySummary = (
  [currency, rows]: [string, SummaryRow[]],
  locale: Locale,
  decimalsFor: DecimalsFor,
): CurrencySummary => {
  const code = currency as CurrencyCode;
  const decimals = decimalsFor(code);
  const income = sumOf(rows, TransactionType.enum.income, decimals);
  const expenses = sumOf(rows, TransactionType.enum.expense, decimals);
  return {
    currency: code,
    income,
    expenses,
    balance: roundToDecimals(income - expenses, decimals),
    byCategory: R.pipe(
      rows,
      R.map((r) => ({
        category: localizeCategoryName(r.category, r.categoryNames, locale) ?? uncategorizedLabels[locale],
        type: r.type,
        total: roundToDecimals(r.total, decimals),
        count: r.count,
      })),
      R.sortBy([(c) => c.total, 'desc']),
    ),
  };
};

function toCurrencySummary(entry: [string, SummaryRow[]], locale: Locale, decimalsFor: DecimalsFor): CurrencySummary;
function toCurrencySummary(
  locale: Locale,
  decimalsFor: DecimalsFor,
): (entry: [string, SummaryRow[]]) => CurrencySummary;
function toCurrencySummary(...args: readonly unknown[]) {
  return purry(_toCurrencySummary, args);
}

export const summarize = (rows: readonly SummaryRow[], locale: Locale, decimalsFor: DecimalsFor): CurrencySummary[] =>
  R.pipe(
    rows,
    R.groupBy((r) => r.currency),
    R.entries(),
    R.map(toCurrencySummary(locale, decimalsFor)),
    R.sortBy((s) => s.currency),
  );
