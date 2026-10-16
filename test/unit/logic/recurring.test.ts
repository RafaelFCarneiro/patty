import { describe, expect, it } from 'vitest';
import { CurrencyCode } from '../../../src/models/money.js';
import { Locale } from '../../../src/models/locale.js';
import { RecurringPeriod, type RecurringRuleView } from '../../../src/models/recurring.js';
import { MovementType } from '../../../src/models/transaction.js';
import {
  dueSchedule,
  MAX_RECURRING_OCCURRENCES_PER_RUN,
  nextDue,
  recurringIdempotencyKey,
  withPeriodLabel,
} from '../../../src/logic/recurring.js';

describe('nextDue', () => {
  it('advances monthly, clamping short months', () => {
    expect(nextDue('2026-06-15', 'monthly')).toBe('2026-07-15');
    expect(nextDue('2026-01-31', 'monthly')).toBe('2026-02-28');
    expect(nextDue('2026-12-10', 'monthly')).toBe('2027-01-10');
  });

  it('advances weekly across month boundaries', () => {
    expect(nextDue('2026-06-28', 'weekly')).toBe('2026-07-05');
  });

  it('advances yearly, clamping Feb 29', () => {
    expect(nextDue('2028-02-29', 'yearly')).toBe('2029-02-28');
    expect(nextDue('2026-03-01', 'yearly')).toBe('2027-03-01');
  });
});

describe('recurringIdempotencyKey', () => {
  it('is stable per rule + due date', () => {
    expect(recurringIdempotencyKey('r1', '2026-06-01')).toBe('rec-r1-2026-06-01');
  });
});

const rule: RecurringRuleView = {
  id: 'rec-1',
  description: 'Rent',
  amount: 2000,
  type: MovementType.enum.expense,
  period: RecurringPeriod.enum.monthly,
  nextDue: '2026-07-01',
  currency: CurrencyCode.enum.BRL,
};

describe('withPeriodLabel', () => {
  it('adds periodLabel for the given locale (data-first)', () => {
    expect(withPeriodLabel(rule, Locale.enum.pt).periodLabel).toBe('Mensal');
  });

  it('works as data-last for pipes', () => {
    expect(withPeriodLabel(Locale.enum.es)(rule).periodLabel).toBe('Mensual');
  });

  it('preserves original period value', () => {
    expect(withPeriodLabel(rule, Locale.enum.pt).period).toBe(RecurringPeriod.enum.monthly);
  });

  it('labels weekly period', () => {
    const weekly: RecurringRuleView = { ...rule, period: RecurringPeriod.enum.weekly };
    expect(withPeriodLabel(weekly, Locale.enum.en).periodLabel).toBe('Weekly');
  });
});

describe('dueSchedule', () => {
  it('lists every due date through the cutoff, inclusive, and the next one owed after them', () => {
    expect(dueSchedule('2026-07-01', '2026-09-15', 'monthly')).toEqual({
      dates: ['2026-07-01', '2026-08-01', '2026-09-01'],
      next: '2026-10-01',
    });
    expect(dueSchedule('2026-07-01', '2026-09-01', 'monthly').dates).toEqual([
      '2026-07-01',
      '2026-08-01',
      '2026-09-01',
    ]);
  });

  it('owes nothing when the first date is after the cutoff: no dates, next is the start itself', () => {
    expect(dueSchedule('2026-10-01', '2026-09-30', 'monthly')).toEqual({ dates: [], next: '2026-10-01' });
  });

  it('steps by the rule’s own period (weekly, yearly), clamping month ends like nextDue', () => {
    expect(dueSchedule('2026-06-28', '2026-07-12', 'weekly')).toEqual({
      dates: ['2026-06-28', '2026-07-05', '2026-07-12'],
      next: '2026-07-19',
    });
    expect(dueSchedule('2024-02-29', '2026-03-01', 'yearly')).toEqual({
      dates: ['2024-02-29', '2025-02-28', '2026-02-28'],
      next: '2027-02-28',
    });
    expect(dueSchedule('2026-01-31', '2026-03-31', 'monthly').dates).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-28',
    ]);
  });

  it('caps a catch-up at the per-run maximum and leaves next at the first date still owed', () => {
    const result = dueSchedule('2000-01-01', '2026-10-01', 'monthly');
    expect(result.dates).toHaveLength(MAX_RECURRING_OCCURRENCES_PER_RUN);
    expect(result.dates[0]).toBe('2000-01-01');
    expect(result.next).toBe(nextDue(result.dates.at(-1)!, 'monthly'));
  });

  it('honours an explicit cap, including zero', () => {
    expect(dueSchedule('2026-01-01', '2026-12-31', 'monthly', 2)).toEqual({
      dates: ['2026-01-01', '2026-02-01'],
      next: '2026-03-01',
    });
    expect(dueSchedule('2026-01-01', '2026-12-31', 'monthly', 0)).toEqual({ dates: [], next: '2026-01-01' });
  });
});
