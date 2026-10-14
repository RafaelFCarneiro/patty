import { purry } from 'remeda';
import { localizeRecurringPeriod } from './localize.js';
import type { Locale } from '../models/locale.js';
import type { RecurringPeriod, RecurringRuleView } from '../models/recurring.js';

const _withPeriodLabel = (rule: RecurringRuleView, locale: Locale): RecurringRuleView => ({
  ...rule,
  periodLabel: localizeRecurringPeriod(rule.period, locale),
});

export function withPeriodLabel(rule: RecurringRuleView, locale: Locale): RecurringRuleView;
export function withPeriodLabel(locale: Locale): (rule: RecurringRuleView) => RecurringRuleView;
export function withPeriodLabel(...args: readonly unknown[]) {
  return purry(_withPeriodLabel, args);
}

/** Pure date math on YYYY-MM-DD strings — no Date timezone traps for month/year. */

const pad = (n: number): string => String(n).padStart(2, '0');

const daysInMonth = (month: number, year: number): number => new Date(Date.UTC(year, month, 0)).getUTCDate();

const clampDay = (day: number, month: number, year: number): number => Math.min(day, daysInMonth(month, year));

export const nextDue = (current: string, period: RecurringPeriod): string => {
  const [y, m, d] = current.split('-').map(Number) as [number, number, number];
  if (period === 'weekly') {
    const dt = new Date(Date.UTC(y, m - 1, d + 7));
    return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
  }
  if (period === 'monthly') {
    const nm = m === 12 ? 1 : m + 1;
    const ny = m === 12 ? y + 1 : y;
    return `${ny}-${pad(nm)}-${pad(clampDay(d, nm, ny))}`;
  }
  return `${y + 1}-${pad(m)}-${pad(clampDay(d, m, y + 1))}`;
};

/** Stable idempotency key so re-applying a due rule never duplicates. */
export const recurringIdempotencyKey = (ruleId: string, due: string): string => `rec-${ruleId}-${due}`;

/** Bounds `applyDueRecurring`'s per-rule materialization loop to prevent runaway on ancient rules. */
export const MAX_RECURRING_OCCURRENCES_PER_RUN = 36;

export type DueSchedule = {
  /** Every due date on or before `through`, oldest first, at most `max` of them. */
  dates: readonly string[];
  /** The first due date NOT materialized: after the last of `dates`, or `start` itself when none is due. */
  next: string;
};

/** The occurrences a rule owes through `through`, and where it stands afterwards — pure, so the controller only maps
 *  dates to writes. Capped at `max` (default `MAX_RECURRING_OCCURRENCES_PER_RUN`): an ancient rule catches up over
 *  several runs rather than all at once, and `next` then names the first date still owed. */
export const dueSchedule = (
  start: string,
  through: string,
  period: RecurringPeriod,
  max: number = MAX_RECURRING_OCCURRENCES_PER_RUN,
): DueSchedule => {
  const advance = (due: string, taken: readonly string[]): DueSchedule =>
    taken.length < max && due <= through ? advance(nextDue(due, period), [...taken, due]) : { dates: taken, next: due };
  return advance(start, []);
};
