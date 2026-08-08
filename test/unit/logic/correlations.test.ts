import { describe, expect, it } from 'vitest';
import {
  detectRecurringCadence,
  shapeBudgetFitLines,
  shapeMerchantConcentration,
  shapeRecurringCandidates,
  shapeSpendingShifts,
  shapeUnbudgetedSpend,
} from '../../../src/logic/correlations.js';
import { BudgetPeriod, type BudgetViewInput } from '../../../src/models/budget.js';
import type { BudgetFitLine, RecurringCandidateInput } from '../../../src/models/correlations.js';
import { Locale } from '../../../src/models/locale.js';
import { CurrencyCode } from '../../../src/models/money.js';
import type { CategoryWindowedSpend } from '../../../src/models/transaction.js';
import type { MerchantSpendDbRow, SpendingShiftDbRow } from '../../../src/wire/db/correlations.js';

const row = (overrides: Partial<SpendingShiftDbRow> = {}): SpendingShiftDbRow => ({
  category: 'Food',
  categoryNames: null,
  currency: CurrencyCode.enum.BRL,
  current: 1000,
  baselineTotal: 900,
  ...overrides,
});

const budget = (overrides: Partial<BudgetViewInput> = {}): BudgetViewInput => ({
  id: 'budget-1',
  currency: CurrencyCode.enum.BRL,
  limit: 300,
  period: BudgetPeriod.enum.monthly,
  targetId: 'cat-food',
  nodeName: 'Food',
  nodeParentId: null,
  parentName: null,
  nodeNames: null,
  parentNames: null,
  ...overrides,
});

const windowedSpend = (overrides: Partial<CategoryWindowedSpend> = {}): CategoryWindowedSpend => ({
  currency: CurrencyCode.enum.BRL,
  categoryId: 'cat-food',
  subCategoryId: null,
  current: 0,
  baselineTotal: 900,
  ...overrides,
});

const merchantRow = (overrides: Partial<MerchantSpendDbRow> = {}): MerchantSpendDbRow => ({
  category: 'Food',
  categoryNames: null,
  currency: CurrencyCode.enum.BRL,
  merchantKey: 'ifood',
  spent: 100,
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
    const [line] = shapeBudgetFitLines(
      [budget({ limit: 200 })],
      [windowedSpend({ baselineTotal: 900 })],
      3,
      20,
      20,
      Locale.enum.en,
    );
    expect(line).toMatchObject({ limit: 200, baseline: 300, verdict: 'unrealistic', suggestedLimit: 330 });
  });

  it('reports generous for a baseline well under the limit', () => {
    // ratio = 300/1000 = 0.3, under the default 20% slackPct band (< 0.8)
    const [line] = shapeBudgetFitLines(
      [budget({ limit: 1000 })],
      [windowedSpend({ baselineTotal: 900 })],
      3,
      20,
      20,
      Locale.enum.en,
    );
    expect(line?.verdict).toBe('generous');
  });

  it('reports realistic when baseline is within tolerance of the limit', () => {
    const [line] = shapeBudgetFitLines(
      [budget({ limit: 300 })],
      [windowedSpend({ baselineTotal: 900 })],
      3,
      20,
      20,
      Locale.enum.en,
    );
    expect(line?.verdict).toBe('realistic');
  });

  it('respects wider slackPct/overPct tolerances', () => {
    // ratio 1.5 is "unrealistic" at overPct 20 but "realistic" at overPct 60
    const budgets = [budget({ limit: 200 })];
    const spend = [windowedSpend({ baselineTotal: 900 })];
    expect(shapeBudgetFitLines(budgets, spend, 3, 20, 20, Locale.enum.en)[0]?.verdict).toBe('unrealistic');
    expect(shapeBudgetFitLines(budgets, spend, 3, 20, 60, Locale.enum.en)[0]?.verdict).toBe('realistic');
  });

  it('handles a budget with no spend at all (baseline 0) as generous, not a divide-by-zero error', () => {
    const [line] = shapeBudgetFitLines([budget({ limit: 300 })], [], 3, 20, 20, Locale.enum.en);
    expect(line).toMatchObject({ current: 0, baseline: 0, verdict: 'generous' });
  });

  it('reports a sub-category budget under its parent category name', () => {
    const [line] = shapeBudgetFitLines(
      [budget({ targetId: 'sub-restaurants', nodeName: 'Restaurants', nodeParentId: 'cat-food', parentName: 'Food' })],
      [],
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
        budget({ id: 'b-brl', currency: CurrencyCode.enum.BRL, limit: 200 }), // unrealistic
        budget({ id: 'b-usd', currency: CurrencyCode.enum.USD, limit: 1000 }), // generous
      ],
      [
        windowedSpend({ currency: CurrencyCode.enum.BRL, baselineTotal: 900 }),
        windowedSpend({ currency: CurrencyCode.enum.USD, baselineTotal: 900 }),
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
      [budget({ nodeName: 'Food', nodeNames: { pt: 'Alimentação' } })],
      [],
      3,
      20,
      20,
      Locale.enum.pt,
    );
    expect(line?.category).toBe('Alimentação');
  });

  it('sorts deterministically by category, then currency, then sub-category', () => {
    const lines = shapeBudgetFitLines(
      [
        budget({ id: 'usd', nodeName: 'Food', currency: CurrencyCode.enum.USD }),
        budget({
          id: 'brl-sub',
          targetId: 'sub-restaurants',
          nodeName: 'Restaurants',
          nodeParentId: 'cat-food',
          parentName: 'Food',
        }),
        budget({ id: 'brl', nodeName: 'Food' }),
      ],
      [],
      3,
      20,
      20,
      Locale.enum.en,
    );
    expect(lines.map((l) => l.id)).toEqual(['brl', 'brl-sub', 'usd']);
  });

  it('matches a top-level budget target against every spend row sharing its categoryId, sub-category or not', () => {
    const [line] = shapeBudgetFitLines(
      [budget({ targetId: 'cat-food', limit: 300 })],
      [
        windowedSpend({ categoryId: 'cat-food', subCategoryId: null, baselineTotal: 600 }),
        windowedSpend({ categoryId: 'cat-food', subCategoryId: 'sub-restaurants', baselineTotal: 300 }),
      ],
      3,
      20,
      20,
      Locale.enum.en,
    );
    expect(line?.baseline).toBe(300); // (600 + 300) / 3
  });

  it('matches a sub-category budget target only against rows sharing its own id as subCategoryId', () => {
    const [line] = shapeBudgetFitLines(
      [budget({ targetId: 'sub-restaurants', nodeName: 'Restaurants', nodeParentId: 'cat-food', parentName: 'Food' })],
      [
        windowedSpend({ categoryId: 'cat-food', subCategoryId: 'sub-restaurants', baselineTotal: 300 }),
        // the parent's own direct spend — excluded
        windowedSpend({ categoryId: 'cat-food', subCategoryId: null, baselineTotal: 900 }),
      ],
      3,
      20,
      20,
      Locale.enum.en,
    );
    expect(line?.baseline).toBe(100); // 300 / 3, the parent's direct spend excluded
  });

  it('ignores spend in a different currency than the budget', () => {
    const [line] = shapeBudgetFitLines(
      [budget({ currency: CurrencyCode.enum.BRL })],
      [windowedSpend({ currency: CurrencyCode.enum.USD, baselineTotal: 999 })],
      3,
      20,
      20,
      Locale.enum.en,
    );
    expect(line).toMatchObject({ current: 0, baseline: 0 });
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

  it('breaks ties by currency for the same category name, deterministically', () => {
    const rows = [
      row({ category: 'Food', currency: CurrencyCode.enum.USD, baselineTotal: 900 }),
      row({ category: 'Food', currency: CurrencyCode.enum.BRL, baselineTotal: 900 }),
    ];
    const entries = shapeUnbudgetedSpend(rows, noBudgets, 3, Locale.enum.en);
    expect(entries.map((e) => e.currency)).toEqual(['BRL', 'USD']);
  });
});

describe('shapeMerchantConcentration', () => {
  it('reports 100% share and zero othersSpent for a single-merchant category', () => {
    const [group] = shapeMerchantConcentration([merchantRow({ spent: 100 })], 5, Locale.enum.en);
    expect(group).toEqual({
      category: 'Food',
      currency: 'BRL',
      categoryTotal: 100,
      merchants: [{ merchant: 'ifood', spent: 100, share: 1, cumulativeShare: 1 }],
      othersSpent: 0,
    });
  });

  it('cuts off at topN and rolls the remainder into othersSpent', () => {
    const rows = [
      merchantRow({ merchantKey: 'a', spent: 300 }),
      merchantRow({ merchantKey: 'b', spent: 200 }),
      merchantRow({ merchantKey: 'c', spent: 100 }),
    ];
    const [group] = shapeMerchantConcentration(rows, 2, Locale.enum.en);
    expect(group?.categoryTotal).toBe(600);
    expect(group?.merchants.map((m) => m.merchant)).toEqual(['a', 'b']);
    expect(group?.othersSpent).toBe(100);
  });

  it('sorts merchants by spend descending regardless of input order', () => {
    const rows = [
      merchantRow({ merchantKey: 'small', spent: 10 }),
      merchantRow({ merchantKey: 'big', spent: 90 }),
    ];
    const [group] = shapeMerchantConcentration(rows, 5, Locale.enum.en);
    expect(group?.merchants.map((m) => m.merchant)).toEqual(['big', 'small']);
  });

  it('accumulates cumulativeShare in descending-spend order', () => {
    const rows = [
      merchantRow({ merchantKey: 'a', spent: 60 }),
      merchantRow({ merchantKey: 'b', spent: 40 }),
    ];
    const [group] = shapeMerchantConcentration(rows, 5, Locale.enum.en);
    expect(group?.merchants).toEqual([
      { merchant: 'a', spent: 60, share: 0.6, cumulativeShare: 0.6 },
      { merchant: 'b', spent: 40, share: 0.4, cumulativeShare: 1 },
    ]);
  });

  it('shares (including othersSpent, as a share of categoryTotal) sum to 1 within a category', () => {
    const rows = [
      merchantRow({ merchantKey: 'a', spent: 50 }),
      merchantRow({ merchantKey: 'b', spent: 30 }),
      merchantRow({ merchantKey: 'c', spent: 15 }),
      merchantRow({ merchantKey: 'd', spent: 5 }),
    ];
    const [group] = shapeMerchantConcentration(rows, 2, Locale.enum.en);
    const merchantShareSum = group!.merchants.reduce((sum, m) => sum + m.share, 0);
    const othersShare = group!.othersSpent / group!.categoryTotal;
    expect(merchantShareSum + othersShare).toBeCloseTo(1, 4);
  });

  it('groups a null merchant_key under a localized "Unknown"', () => {
    const [group] = shapeMerchantConcentration([merchantRow({ merchantKey: null, spent: 50 })], 5, Locale.enum.pt);
    expect(group?.merchants[0]?.merchant).toBe('Desconhecido');
  });

  it('keeps categories separate per currency, even with the same name', () => {
    const rows = [
      merchantRow({ currency: CurrencyCode.enum.BRL, spent: 100 }),
      merchantRow({ currency: CurrencyCode.enum.USD, spent: 50 }),
    ];
    const groups = shapeMerchantConcentration(rows, 5, Locale.enum.en);
    expect(groups).toHaveLength(2);
    expect(groups.find((g) => g.currency === 'BRL')?.categoryTotal).toBe(100);
    expect(groups.find((g) => g.currency === 'USD')?.categoryTotal).toBe(50);
  });

  it('localizes the category name via the names map for the given locale', () => {
    const [group] = shapeMerchantConcentration(
      [merchantRow({ category: 'Food', categoryNames: { pt: 'Alimentação' } })],
      5,
      Locale.enum.pt,
    );
    expect(group?.category).toBe('Alimentação');
  });

  it('sorts the returned categories alphabetically', () => {
    const rows = [merchantRow({ category: 'Transport' }), merchantRow({ category: 'Food' })];
    const groups = shapeMerchantConcentration(rows, 5, Locale.enum.en);
    expect(groups.map((g) => g.category)).toEqual(['Food', 'Transport']);
  });

  it('breaks ties by currency for the same category name, deterministically', () => {
    const rows = [
      merchantRow({ category: 'Food', currency: CurrencyCode.enum.USD }),
      merchantRow({ category: 'Food', currency: CurrencyCode.enum.BRL }),
    ];
    const groups = shapeMerchantConcentration(rows, 5, Locale.enum.en);
    expect(groups.map((g) => g.currency)).toEqual(['BRL', 'USD']);
  });

  it('does not merge a category whose name contains the internal key delimiter with an unrelated one', () => {
    const rows = [
      merchantRow({ category: 'Food::Drinks', spent: 100 }),
      merchantRow({ category: 'Food', spent: 50 }),
    ];
    const groups = shapeMerchantConcentration(rows, 5, Locale.enum.en);
    expect(groups).toHaveLength(2);
    expect(groups.find((g) => g.category === 'Food::Drinks')?.categoryTotal).toBe(100);
    expect(groups.find((g) => g.category === 'Food')?.categoryTotal).toBe(50);
  });

  it('returns an empty array for no rows (e.g. an empty period)', () => {
    expect(shapeMerchantConcentration([], 5, Locale.enum.en)).toEqual([]);
  });
});

describe('detectRecurringCadence', () => {
  const monthlySeries = [
    { date: '2026-01-05', amount: 100 },
    { date: '2026-02-04', amount: 100 },
    { date: '2026-03-06', amount: 100 },
  ];

  it('flags a clean monthly series with the right typicalAmount/occurrences/lastDate/suggestedNextDue', () => {
    const result = detectRecurringCadence(monthlySeries, 3);
    expect(result).toEqual({
      typicalAmount: 100,
      occurrences: 3,
      lastDate: '2026-03-06',
      suggestedNextDue: '2026-04-06',
    });
  });

  it('sorts an out-of-order series internally before measuring gaps', () => {
    const shuffled = [monthlySeries[2]!, monthlySeries[0]!, monthlySeries[1]!];
    expect(detectRecurringCadence(shuffled, 3)).toEqual(detectRecurringCadence(monthlySeries, 3));
  });

  it('rejects a series below minOccurrences, regardless of cadence', () => {
    expect(detectRecurringCadence(monthlySeries.slice(0, 2), 3)).toBeNull();
  });

  it('rejects irregular gaps', () => {
    const irregular = [
      { date: '2026-01-01', amount: 100 },
      { date: '2026-01-15', amount: 100 }, // 14-day gap — too short
      { date: '2026-03-01', amount: 100 }, // 45-day gap — too long
    ];
    expect(detectRecurringCadence(irregular, 3)).toBeNull();
  });

  it('accepts a gap exactly at the tolerance boundary', () => {
    const boundary = [
      { date: '2026-01-01', amount: 100 },
      { date: '2026-02-05', amount: 100 }, // exactly 35 days
    ];
    expect(detectRecurringCadence(boundary, 2)).not.toBeNull();
  });

  it('rejects amount drift beyond tolerance', () => {
    const drifting = [
      { date: '2026-01-05', amount: 100 },
      { date: '2026-02-04', amount: 100 },
      { date: '2026-03-06', amount: 200 }, // far beyond ±10% of the ~133 average
    ];
    expect(detectRecurringCadence(drifting, 3)).toBeNull();
  });

  it('accepts amount drift within tolerance', () => {
    const withinDrift = [
      { date: '2026-01-05', amount: 95 },
      { date: '2026-02-04', amount: 100 },
      { date: '2026-03-06', amount: 105 },
    ];
    expect(detectRecurringCadence(withinDrift, 3)).not.toBeNull();
  });
});

describe('shapeRecurringCandidates', () => {
  const recurringRow = (overrides: Partial<RecurringCandidateInput> = {}): RecurringCandidateInput => ({
    merchantKey: 'netflix',
    currency: CurrencyCode.enum.BRL,
    category: 'Subscriptions',
    categoryNames: null,
    date: '2026-01-05',
    amount: 39.9,
    ...overrides,
  });

  it('flags a qualifying merchant as a candidate, ready for create_recurring', () => {
    const rows = [
      recurringRow({ date: '2026-01-05' }),
      recurringRow({ date: '2026-02-04' }),
      recurringRow({ date: '2026-03-06' }),
    ];
    const [candidate] = shapeRecurringCandidates(rows, 3, Locale.enum.en);
    expect(candidate).toEqual({
      merchant: 'netflix',
      currency: 'BRL',
      category: 'Subscriptions',
      typicalAmount: 39.9,
      occurrences: 3,
      lastDate: '2026-03-06',
      suggestedNextDue: '2026-04-06',
    });
  });

  it('excludes a merchant whose series does not qualify', () => {
    const rows = [
      recurringRow({ date: '2026-01-01' }),
      recurringRow({ date: '2026-01-15' }), // irregular gap
      recurringRow({ date: '2026-03-01' }),
    ];
    expect(shapeRecurringCandidates(rows, 3, Locale.enum.en)).toEqual([]);
  });

  it('keeps merchants separate per currency', () => {
    const rows = [
      recurringRow({ currency: CurrencyCode.enum.BRL, date: '2026-01-05' }),
      recurringRow({ currency: CurrencyCode.enum.BRL, date: '2026-02-04' }),
      recurringRow({ currency: CurrencyCode.enum.USD, date: '2026-01-05' }),
    ];
    const candidates = shapeRecurringCandidates(rows, 2, Locale.enum.en);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ currency: 'BRL', occurrences: 2 });
  });

  it("uses the merchant's most recent occurrence to decide category", () => {
    const rows = [
      recurringRow({ date: '2026-01-05', category: 'Streaming' }),
      recurringRow({ date: '2026-02-04', category: 'Streaming' }),
      recurringRow({ date: '2026-03-06', category: 'Subscriptions' }),
    ];
    const [candidate] = shapeRecurringCandidates(rows, 3, Locale.enum.en);
    expect(candidate?.category).toBe('Subscriptions');
  });

  it('localizes the category name via the names map for the given locale', () => {
    const rows = [
      recurringRow({ date: '2026-01-05', category: 'Food', categoryNames: { pt: 'Alimentação' } }),
      recurringRow({ date: '2026-02-04', category: 'Food', categoryNames: { pt: 'Alimentação' } }),
      recurringRow({ date: '2026-03-06', category: 'Food', categoryNames: { pt: 'Alimentação' } }),
    ];
    const [candidate] = shapeRecurringCandidates(rows, 3, Locale.enum.pt);
    expect(candidate?.category).toBe('Alimentação');
  });

  it('sorts by occurrences descending, then merchant ascending', () => {
    const rows = [
      // 'b' qualifies with 4 monthly occurrences
      recurringRow({ merchantKey: 'b', date: '2026-01-05' }),
      recurringRow({ merchantKey: 'b', date: '2026-02-04' }),
      recurringRow({ merchantKey: 'b', date: '2026-03-06' }),
      recurringRow({ merchantKey: 'b', date: '2026-04-05' }),
      // 'a' and 'c' both qualify with 3
      recurringRow({ merchantKey: 'a', date: '2026-01-05' }),
      recurringRow({ merchantKey: 'a', date: '2026-02-04' }),
      recurringRow({ merchantKey: 'a', date: '2026-03-06' }),
      recurringRow({ merchantKey: 'c', date: '2026-01-05' }),
      recurringRow({ merchantKey: 'c', date: '2026-02-04' }),
      recurringRow({ merchantKey: 'c', date: '2026-03-06' }),
    ];
    const candidates = shapeRecurringCandidates(rows, 3, Locale.enum.en);
    expect(candidates.map((c) => c.merchant)).toEqual(['b', 'a', 'c']);
  });

  it('returns an empty array for no rows', () => {
    expect(shapeRecurringCandidates([], 3, Locale.enum.en)).toEqual([]);
  });
});
