import { isNonNullish } from 'remeda';
import type { DateRange, NullableDateRange, Period, PeriodInput } from '../models/date.js';

const pad = (n: number): string => String(n).padStart(2, '0');

/** Month period → half-open ISO date range [from, to). */
export const periodRange = ({ month, year }: Period): DateRange => {
  const from = `${year}-${pad(month)}-01`;
  const to = month === 12 ? `${year + 1}-01-01` : `${year}-${pad(month + 1)}-01`;
  return { from, to };
};

export const toIsoDate = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export const hasPeriod = (input: PeriodInput): boolean => isNonNullish(input.month) && isNonNullish(input.year);

export const hasDateRange = (input: PeriodInput): boolean => isNonNullish(input.from) || isNonNullish(input.to);

export const assertHasPeriodOrRange = (input: PeriodInput): boolean => hasPeriod(input) || hasDateRange(input);

export const resolveDateRange = (input: PeriodInput): NullableDateRange => {
  const range = hasPeriod(input) ? periodRange({ month: input.month!, year: input.year! }) : null;
  return {
    from: range?.from ?? input.from ?? null,
    to: range?.to ?? input.to ?? null,
  };
};
