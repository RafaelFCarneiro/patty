import { purry } from 'remeda';
import { pickClassification, type MerchantMatch } from './classify.js';
import { localizeRecurringPeriod } from './localize.js';
import { normalizeMerchant } from './merchant.js';
import { resolveCurrency } from './money.js';
import type { Locale } from '../models/locale.js';
import type { CurrencyCode } from '../models/money.js';
import type { CreateRecurring, RecurringPeriod, RecurringRule, RecurringRuleView } from '../models/recurring.js';

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
  dates: readonly string[];
  next: string;
};

/** Occurrences owed through `through`, capped at `max`; `next` is the first date still owed. */
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

/** Explicit `merchant` is stored as-is (the user's own naming, no lookup). Otherwise mirror a
 *  transaction's precedence — an already-learned `merchant_category` key wins over a fresh
 *  normalize, so the rule matches the identity a transaction would. */
export const ruleMerchantKey = (
  input: Pick<CreateRecurring, 'description' | 'merchant'>,
  candidates: readonly MerchantMatch[],
): string | undefined => {
  if (input.merchant) return normalizeMerchant(input.merchant) || undefined;
  return pickClassification(candidates).merchantKey ?? (normalizeMerchant(input.description) || undefined);
};

export type RuleFacts = {
  /** Minted by the controller (`deps.newId()`) — logic never draws ids. */
  id: string;
  input: CreateRecurring;
  account: { id: string; currency: CurrencyCode } | null;
  category: { id: string } | null;
  /** Merchant candidates for the description; empty when the input names its merchant. */
  candidates: readonly MerchantMatch[];
};

/** Decides a new recurring rule from the values its controller gathered. */
export const newRule = (facts: RuleFacts): RecurringRule => ({
  id: facts.id,
  description: facts.input.description,
  amount: facts.input.amount,
  type: facts.input.type,
  period: facts.input.period,
  nextDue: facts.input.startDate,
  currency: resolveCurrency(facts.account, facts.input),
  accountId: facts.account?.id,
  categoryId: facts.category?.id,
  merchantKey: ruleMerchantKey(facts.input, facts.candidates),
});
