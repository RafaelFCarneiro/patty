import { describe, expect, it } from 'vitest';
import { shapeSpendingShifts } from '../../../src/logic/correlations.js';
import { Locale } from '../../../src/models/locale.js';
import { CurrencyCode } from '../../../src/models/money.js';
import type { SpendingShiftDbRow } from '../../../src/wire/db/correlations.js';

const row = (overrides: Partial<SpendingShiftDbRow> = {}): SpendingShiftDbRow => ({
  category: 'Food',
  categoryNames: null,
  currency: CurrencyCode.enum.BRL,
  current: 1000,
  baselineTotal: 900,
  ...overrides,
});

describe('shapeSpendingShifts', () => {
  it('computes baseline as the average over baselineMonths and deltaPct from it', () => {
    const [shift] = shapeSpendingShifts([row({ current: 1200, baselineTotal: 900 })], 3, 0, Locale.enum.en);
    // baseline = 900 / 3 = 300; deltaPct = (1200 - 300) / 300 * 100 = 300
    expect(shift).toMatchObject({ category: 'Food', current: 1200, baseline: 300, deltaPct: 300, direction: 'up' });
  });

  it('reports direction down when current is below baseline', () => {
    const [shift] = shapeSpendingShifts([row({ current: 150, baselineTotal: 900 })], 3, 0, Locale.enum.en);
    expect(shift).toMatchObject({ baseline: 300, deltaPct: -50, direction: 'down' });
  });

  it('reports a brand-new category (no baseline spend) as deltaPct: null, direction: up', () => {
    const [shift] = shapeSpendingShifts([row({ current: 500, baselineTotal: 0 })], 3, 20, Locale.enum.en);
    expect(shift).toMatchObject({ current: 500, baseline: 0, deltaPct: null, direction: 'up' });
  });

  it('filters out shifts below minDeltaPct', () => {
    // baseline = 900/3 = 300; current = 320 -> deltaPct ~ 6.67%, below a 20% threshold
    const shifts = shapeSpendingShifts([row({ current: 320, baselineTotal: 900 })], 3, 20, Locale.enum.en);
    expect(shifts).toEqual([]);
  });

  it('always includes a brand-new category regardless of minDeltaPct', () => {
    const shifts = shapeSpendingShifts([row({ current: 50, baselineTotal: 0 })], 3, 20, Locale.enum.en);
    expect(shifts).toHaveLength(1);
  });

  it('sorts by |deltaPct| descending, with brand-new categories (null) first', () => {
    const shifts = shapeSpendingShifts(
      [
        row({ category: 'Small move', current: 330, baselineTotal: 900 }), // baseline 300, deltaPct 10
        row({ category: 'Brand new', current: 100, baselineTotal: 0 }), // deltaPct null
        row({ category: 'Big move', current: 600, baselineTotal: 900 }), // baseline 300, deltaPct 100
      ],
      3,
      0,
      Locale.enum.en,
    );
    expect(shifts.map((s) => s.category)).toEqual(['Brand new', 'Big move', 'Small move']);
  });

  it('localizes the category name via the names map for the given locale', () => {
    const [shift] = shapeSpendingShifts(
      [row({ category: 'Food', categoryNames: { pt: 'Alimentação' } })],
      3,
      0,
      Locale.enum.pt,
    );
    expect(shift?.category).toBe('Alimentação');
  });

  it('returns an empty array for no rows (e.g. an empty reference month)', () => {
    expect(shapeSpendingShifts([], 3, 20, Locale.enum.en)).toEqual([]);
  });
});
