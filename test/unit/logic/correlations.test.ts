import { describe, expect, it } from 'vitest';
import { shapeBudgetFitLines, shapeSpendingShifts, shapeUnbudgetedSpend } from '../../../src/logic/correlations.js';
import type { BudgetFitLine } from '../../../src/models/correlations.js';
import { Locale } from '../../../src/models/locale.js';
import { CurrencyCode } from '../../../src/models/money.js';
import type { BudgetFitDbRow, SpendingShiftDbRow } from '../../../src/wire/db/correlations.js';

const row = (overrides: Partial<SpendingShiftDbRow> = {}): SpendingShiftDbRow => ({
  category: 'Food',
  categoryNames: null,
  currency: CurrencyCode.enum.BRL,
  current: 1000,
  baselineTotal: 900,
  ...overrides,
});

const budgetRow = (overrides: Partial<BudgetFitDbRow> = {}): BudgetFitDbRow => ({
  id: 'budget-1',
  currency: CurrencyCode.enum.BRL,
  nodeName: 'Food',
  nodeParentId: null,
  parentName: null,
  nodeNames: null,
  parentNames: null,
  current: 0,
  limit: 300,
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

  it('does not misclassify a tiny nonzero baseline as brand-new after rounding to 0.00', () => {
    // baselineTotal 0.01 over 3 months -> raw baseline ~0.00333, which *rounds* to 0.00 for display
    // but must not be treated as "no baseline spend" (deltaPct: null) — the divide-by-zero decision
    // has to use the unrounded value.
    const [shift] = shapeSpendingShifts([row({ current: 100, baselineTotal: 0.01 })], 3, 0, Locale.enum.en);
    expect(shift?.baseline).toBe(0);
    expect(shift?.deltaPct).not.toBeNull();
    expect(shift?.deltaPct).toBeGreaterThan(1000);
    expect(shift?.direction).toBe('up');
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

describe('shapeBudgetFitLines', () => {
  it('reports unrealistic and a suggestedLimit above baseline for a materially over-budget category', () => {
    // baseline = 900/3 = 300; ratio = 300/200 = 1.5, over the default 20% overPct band (> 1.2)
    const [line] = shapeBudgetFitLines([budgetRow({ limit: 200, baselineTotal: 900 })], 3, 20, 20, Locale.enum.en);
    expect(line).toMatchObject({ limit: 200, baseline: 300, verdict: 'unrealistic', suggestedLimit: 330 });
  });

  it('reports generous for a baseline well under the limit', () => {
    // ratio = 300/1000 = 0.3, under the default 20% slackPct band (< 0.8)
    const [line] = shapeBudgetFitLines([budgetRow({ limit: 1000, baselineTotal: 900 })], 3, 20, 20, Locale.enum.en);
    expect(line?.verdict).toBe('generous');
  });

  it('reports realistic when baseline is within tolerance of the limit', () => {
    const [line] = shapeBudgetFitLines([budgetRow({ limit: 300, baselineTotal: 900 })], 3, 20, 20, Locale.enum.en);
    expect(line?.verdict).toBe('realistic');
  });

  it('respects wider slackPct/overPct tolerances', () => {
    // ratio 1.5 is "unrealistic" at overPct 20 but "realistic" at overPct 60
    const rows = [budgetRow({ limit: 200, baselineTotal: 900 })];
    expect(shapeBudgetFitLines(rows, 3, 20, 20, Locale.enum.en)[0]?.verdict).toBe('unrealistic');
    expect(shapeBudgetFitLines(rows, 3, 20, 60, Locale.enum.en)[0]?.verdict).toBe('realistic');
  });

  it('handles a budget with no spend at all (baseline 0) as generous, not a divide-by-zero error', () => {
    const [line] = shapeBudgetFitLines(
      [budgetRow({ limit: 300, baselineTotal: 0, current: 0 })],
      3,
      20,
      20,
      Locale.enum.en,
    );
    expect(line).toMatchObject({ current: 0, baseline: 0, verdict: 'generous' });
  });

  it('reports a sub-category budget under its parent category name', () => {
    const [line] = shapeBudgetFitLines(
      [budgetRow({ nodeName: 'Restaurants', nodeParentId: 'cat-food', parentName: 'Food' })],
      3,
      20,
      20,
      Locale.enum.en,
    );
    expect(line).toMatchObject({ category: 'Food', subCategory: 'Restaurants' });
  });

  it('isolates verdicts per currency for the same category', () => {
    const lines = shapeBudgetFitLines(
      [
        budgetRow({ id: 'b-brl', currency: CurrencyCode.enum.BRL, limit: 200, baselineTotal: 900 }), // unrealistic
        budgetRow({ id: 'b-usd', currency: CurrencyCode.enum.USD, limit: 1000, baselineTotal: 900 }), // generous
      ],
      3,
      20,
      20,
      Locale.enum.en,
    );
    expect(lines.find((l) => l.currency === 'BRL')?.verdict).toBe('unrealistic');
    expect(lines.find((l) => l.currency === 'USD')?.verdict).toBe('generous');
  });

  it('localizes the category name via the names map for the given locale', () => {
    const [line] = shapeBudgetFitLines(
      [budgetRow({ nodeName: 'Food', nodeNames: { pt: 'Alimentação' } })],
      3,
      20,
      20,
      Locale.enum.pt,
    );
    expect(line?.category).toBe('Alimentação');
  });
});

describe('shapeUnbudgetedSpend', () => {
  const noBudgets: BudgetFitLine[] = [];

  it('surfaces a category with an established baseline and no budget', () => {
    const rows = [row({ category: 'Transport', baselineTotal: 900 })];
    const [entry] = shapeUnbudgetedSpend(rows, noBudgets, 3, Locale.enum.en);
    expect(entry).toMatchObject({ category: 'Transport', currency: 'BRL', baseline: 300, suggestedLimit: 330 });
  });

  it('excludes a category already covered by an existing budget', () => {
    const budgeted: BudgetFitLine[] = [
      {
        id: 'b-1',
        category: 'Food',
        currency: CurrencyCode.enum.BRL,
        limit: 300,
        current: 0,
        baseline: 300,
        verdict: 'realistic',
        suggestedLimit: 330,
      },
    ];
    const entries = shapeUnbudgetedSpend([row({ category: 'Food', baselineTotal: 900 })], budgeted, 3, Locale.enum.en);
    expect(entries).toEqual([]);
  });

  it('excludes a brand-new (zero-baseline) category — no established pattern to suggest a limit from', () => {
    const rows = [row({ category: 'Brand New', baselineTotal: 0 })];
    expect(shapeUnbudgetedSpend(rows, noBudgets, 3, Locale.enum.en)).toEqual([]);
  });

  it('does not cross-exclude the same category name in a different currency', () => {
    const budgeted: BudgetFitLine[] = [
      {
        id: 'b-1',
        category: 'Food',
        currency: CurrencyCode.enum.USD,
        limit: 300,
        current: 0,
        baseline: 300,
        verdict: 'realistic',
        suggestedLimit: 330,
      },
    ];
    const entries = shapeUnbudgetedSpend(
      [row({ category: 'Food', currency: CurrencyCode.enum.BRL, baselineTotal: 900 })],
      budgeted,
      3,
      Locale.enum.en,
    );
    expect(entries).toHaveLength(1);
  });

  it('returns an empty array when there are no shift rows', () => {
    expect(shapeUnbudgetedSpend([], noBudgets, 3, Locale.enum.en)).toEqual([]);
  });
});
