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

export const assertExclusivePeriodOrRange = (input: PeriodInput): boolean => !(hasPeriod(input) && hasDateRange(input));

/** `[from, to)` for the `baselineMonths` immediately preceding `period`, chaining directly into
 *  `periodRange(period).from` with no gap or overlap. Month-index arithmetic avoids `Date`/timezone. */
export const baselineRange = (period: Period, baselineMonths: number): DateRange => {
  const { from: to } = periodRange(period);
  const monthIndex = period.year * 12 + (period.month - 1) - baselineMonths;
  const year = Math.floor(monthIndex / 12);
  const month = monthIndex - year * 12 + 1;
  return { from: `${year}-${pad(month)}-01`, to };
};

// UTC-based like `logic/recurring.ts`'s `nextDue` — no timezone traps.
export const daysBetween = (a: string, b: string): number => {
  const [ay, am, ad] = a.split('-').map(Number) as [number, number, number];
  const [by, bm, bd] = b.split('-').map(Number) as [number, number, number];
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
};

// Month-index arithmetic mirroring `baselineRange`, anchored at "today" instead of a reference period.
export const lookbackFrom = (today: string, lookbackMonths: number): string => {
  const [year, month] = today.split('-').map(Number) as [number, number];
  const monthIndex = year * 12 + (month - 1) - lookbackMonths;
  const fromYear = Math.floor(monthIndex / 12);
  const fromMonth = monthIndex - fromYear * 12 + 1;
  return `${fromYear}-${pad(fromMonth)}-01`;
};

export const resolveDateRange = (input: PeriodInput): NullableDateRange => {
  const range = hasPeriod(input) ? periodRange({ month: input.month!, year: input.year! }) : null;
  return {
    from: range?.from ?? input.from ?? null,
    to: range?.to ?? input.to ?? null,
  };
};
