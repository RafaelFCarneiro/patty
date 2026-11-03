import { describe, expect, it } from 'vitest';
import {
  addDays,
  assertExclusivePeriodOrRange,
  assertHasPeriodOrRange,
  baselineRange,
  daysBetween,
  hasPeriod,
  hasDateRange,
  lookbackFrom,
  periodBounds,
  periodRange,
  resolveDateRange,
} from '../../../src/logic/period.js';

describe('periodRange', () => {
  it('builds half-open month range', () => {
    expect(periodRange({ month: 6, year: 2026 })).toEqual({ from: '2026-06-01', to: '2026-07-01' });
  });

  it('rolls over December', () => {
    expect(periodRange({ month: 12, year: 2026 })).toEqual({ from: '2026-12-01', to: '2027-01-01' });
  });
});

describe('baselineRange', () => {
  it('chains directly into the reference period, no gap and no overlap', () => {
    expect(baselineRange({ month: 7, year: 2026 }, 3)).toEqual({ from: '2026-04-01', to: '2026-07-01' });
  });

  it('rolls back across a year boundary', () => {
    expect(baselineRange({ month: 2, year: 2026 }, 3)).toEqual({ from: '2025-11-01', to: '2026-02-01' });
  });

  it('rolls back multiple years for a large window', () => {
    expect(baselineRange({ month: 1, year: 2026 }, 24)).toEqual({ from: '2024-01-01', to: '2026-01-01' });
  });

  it('handles a one-month window', () => {
    expect(baselineRange({ month: 6, year: 2026 }, 1)).toEqual({ from: '2026-05-01', to: '2026-06-01' });
  });
});

describe('daysBetween', () => {
  it('counts whole days within the same month', () => {
    expect(daysBetween('2026-06-01', '2026-06-15')).toBe(14);
  });

  it('crosses a month boundary', () => {
    expect(daysBetween('2026-01-20', '2026-02-05')).toBe(16);
  });

  it('crosses a year boundary', () => {
    expect(daysBetween('2025-12-20', '2026-01-05')).toBe(16);
  });

  it('is negative when b precedes a', () => {
    expect(daysBetween('2026-06-15', '2026-06-01')).toBe(-14);
  });

  it('is zero for the same date', () => {
    expect(daysBetween('2026-06-01', '2026-06-01')).toBe(0);
  });
});

describe('lookbackFrom', () => {
  it("rolls back N months from today's own month, day 01", () => {
    expect(lookbackFrom('2026-07-15', 6)).toBe('2026-01-01');
  });

  it('rolls back across a year boundary', () => {
    expect(lookbackFrom('2026-02-10', 3)).toBe('2025-11-01');
  });

  it('rolls back multiple years for a large window', () => {
    expect(lookbackFrom('2026-01-10', 24)).toBe('2024-01-01');
  });
});

describe('hasPeriod', () => {
  it('true when month and year present', () => {
    expect(hasPeriod({ month: 6, year: 2026 })).toBe(true);
  });

  it('false when month missing', () => {
    expect(hasPeriod({ year: 2026 })).toBe(false);
  });

  it('false when both missing', () => {
    expect(hasPeriod({})).toBe(false);
  });
});

describe('hasDateRange', () => {
  it('true when from provided', () => {
    expect(hasDateRange({ from: '2026-01-01' })).toBe(true);
  });

  it('true when to provided', () => {
    expect(hasDateRange({ to: '2026-12-31' })).toBe(true);
  });

  it('false when neither', () => {
    expect(hasDateRange({})).toBe(false);
  });
});

describe('assertHasPeriodOrRange', () => {
  it('true with month+year', () => {
    expect(assertHasPeriodOrRange({ month: 6, year: 2026 })).toBe(true);
  });

  it('true with from/to', () => {
    expect(assertHasPeriodOrRange({ from: '2026-01-01', to: '2026-06-30' })).toBe(true);
  });

  it('false with nothing', () => {
    expect(assertHasPeriodOrRange({})).toBe(false);
  });

  it('false with null month and year', () => {
    expect(assertHasPeriodOrRange({ month: null, year: null })).toBe(false);
  });

  it('false with undefined month and year', () => {
    expect(assertHasPeriodOrRange({ month: undefined, year: undefined })).toBe(false);
  });

  it('true with from only (null to)', () => {
    expect(assertHasPeriodOrRange({ from: '2026-01-01', to: null })).toBe(true);
  });
});

describe('assertExclusivePeriodOrRange', () => {
  it('true with month+year only', () => {
    expect(assertExclusivePeriodOrRange({ month: 9, year: 2026 })).toBe(true);
  });

  it('true with from/to only', () => {
    expect(assertExclusivePeriodOrRange({ from: '2026-09-01', to: '2026-10-01' })).toBe(true);
  });

  it('true with neither', () => {
    expect(assertExclusivePeriodOrRange({})).toBe(true);
  });

  it('false with month+year and from', () => {
    expect(assertExclusivePeriodOrRange({ month: 9, year: 2026, from: '2026-09-01' })).toBe(false);
  });

  it('false with month+year and to', () => {
    expect(assertExclusivePeriodOrRange({ month: 9, year: 2026, to: '2026-10-01' })).toBe(false);
  });
});

describe('resolveDateRange', () => {
  it('uses month+year period when both provided', () => {
    const result = resolveDateRange({ month: 6, year: 2026 });
    expect(result).toEqual({ from: '2026-06-01', to: '2026-07-01' });
  });

  it('falls back to from/to when month+year absent', () => {
    const result = resolveDateRange({ from: '2026-03-01', to: '2026-03-31' });
    expect(result).toEqual({ from: '2026-03-01', to: '2026-03-31' });
  });

  it('returns null for both when nothing provided', () => {
    const result = resolveDateRange({});
    expect(result).toEqual({ from: null, to: null });
  });

  it('handles null from/to gracefully', () => {
    const result = resolveDateRange({ from: null, to: null });
    expect(result).toEqual({ from: null, to: null });
  });

  it('handles undefined from/to gracefully', () => {
    const result = resolveDateRange({ from: undefined, to: undefined });
    expect(result).toEqual({ from: null, to: null });
  });

  it('month+year takes priority over from/to', () => {
    const result = resolveDateRange({ month: 1, year: 2026, from: '2025-12-01', to: '2025-12-31' });
    expect(result).toEqual({ from: '2026-01-01', to: '2026-02-01' });
  });

  it('partial from without to returns from with null to', () => {
    const result = resolveDateRange({ from: '2026-06-01' });
    expect(result).toEqual({ from: '2026-06-01', to: null });
  });
});

describe('periodBounds', () => {
  it('is the month range when a month and year are given', () => {
    expect(periodBounds({ month: 6, year: 2026 })).toEqual({ from: '2026-06-01', to: '2026-07-01' });
  });

  it('is open on both sides without a period', () => {
    expect(periodBounds({})).toEqual({ from: null, to: null });
    expect(periodBounds({ month: 6 })).toEqual({ from: null, to: null });
  });

  it('ignores an explicit from/to — unlike resolveDateRange, which falls back to them', () => {
    expect(periodBounds({ from: '2026-01-01', to: '2026-02-01' })).toEqual({ from: null, to: null });
    expect(resolveDateRange({ from: '2026-01-01', to: '2026-02-01' })).toEqual({
      from: '2026-01-01',
      to: '2026-02-01',
    });
  });
});

describe('addDays', () => {
  it.each([
    ['2026-10-26', 1, '2026-10-27'],
    ['2026-10-31', 1, '2026-11-01'],
    ['2026-12-31', 1, '2027-01-01'],
    ['2026-03-01', -1, '2026-02-28'],
    ['2028-03-01', -1, '2028-02-29'],
    ['2026-11-02', -4, '2026-10-29'],
    ['2026-10-26', 0, '2026-10-26'],
  ])('%s %i days is %s', (date, days, expected) => {
    expect(addDays(date, days)).toBe(expected);
  });
});
