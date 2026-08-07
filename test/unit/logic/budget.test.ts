import { describe, expect, it } from 'vitest';
import {
  groupStatusByCategory,
  hasExactlyOneTarget,
  isExpenseEligible,
  rowToView,
  rowsToViews,
  toView,
} from '../../../src/logic/budget.js';
import { CategoryKind } from '../../../src/models/category.js';
import { BudgetPeriod, type Budget, type BudgetViewInput } from '../../../src/models/budget.js';
import { Locale } from '../../../src/models/locale.js';
import { CurrencyCode } from '../../../src/models/money.js';
import type { CategorySpend } from '../../../src/models/transaction.js';

describe('hasExactlyOneTarget', () => {
  it('is true when only category is given', () => {
    expect(hasExactlyOneTarget({ category: 'Food' })).toBe(true);
  });

  it('is true when only subCategory is given', () => {
    expect(hasExactlyOneTarget({ subCategory: 'Restaurants' })).toBe(true);
  });

  it('is false when neither is given', () => {
    expect(hasExactlyOneTarget({})).toBe(false);
  });

  it('is false when both are given', () => {
    expect(hasExactlyOneTarget({ category: 'Food', subCategory: 'Restaurants' })).toBe(false);
  });
});

describe('isExpenseEligible', () => {
  it('accepts an expense-kind category', () => {
    expect(isExpenseEligible(CategoryKind.enum.expense)).toBe(true);
  });

  it('accepts a both-kind category — it can carry expense transactions too', () => {
    expect(isExpenseEligible(CategoryKind.enum.both)).toBe(true);
  });

  it('rejects a pure income-kind category', () => {
    expect(isExpenseEligible(CategoryKind.enum.income)).toBe(false);
  });
});

describe('toView', () => {
  const budget: Budget = {
    id: 'budget-1',
    categoryId: 'cat-food',
    currency: CurrencyCode.enum.BRL,
    limit: 500,
    period: BudgetPeriod.enum.monthly,
  };

  it('combines the budget with a top-level category target, omitting subCategory', () => {
    expect(toView(budget, { category: 'Food' })).toEqual({
      id: 'budget-1',
      currency: CurrencyCode.enum.BRL,
      limit: 500,
      period: BudgetPeriod.enum.monthly,
      category: 'Food',
      subCategory: undefined,
    });
  });

  it('combines the budget with a sub-category target', () => {
    expect(toView(budget, { category: 'Food', subCategory: 'Restaurants' })).toEqual({
      id: 'budget-1',
      currency: CurrencyCode.enum.BRL,
      limit: 500,
      period: BudgetPeriod.enum.monthly,
      category: 'Food',
      subCategory: 'Restaurants',
    });
  });
});

describe('rowToView', () => {
  const viewRow = (overrides: Partial<BudgetViewInput> = {}): BudgetViewInput => ({
    id: 'budget-1',
    currency: CurrencyCode.enum.BRL,
    limit: 500,
    period: BudgetPeriod.enum.monthly,
    targetId: 'cat-food',
    nodeName: 'Food',
    nodeNames: { pt: 'Comida', es: 'Comida' },
    nodeParentId: null,
    parentName: null,
    parentNames: null,
    ...overrides,
  });

  it('shows the top-level category, localized for the given locale', () => {
    expect(rowToView(viewRow(), Locale.enum.pt)).toEqual({
      id: 'budget-1',
      currency: CurrencyCode.enum.BRL,
      limit: 500,
      period: BudgetPeriod.enum.monthly,
      category: 'Comida',
      subCategory: undefined,
    });
  });

  it('falls back to the raw name when no translation exists for the locale', () => {
    const row = viewRow({ nodeNames: { es: 'Comida' } });
    expect(rowToView(row, Locale.enum.pt).category).toBe('Food');
  });

  it('falls back to the raw name when the node has no names at all (user-created category)', () => {
    expect(rowToView(viewRow({ nodeNames: null }), Locale.enum.pt).category).toBe('Food');
  });

  it('shows category+subCategory when node_parent_id is set, localizing the parent via parentNames', () => {
    const row = viewRow({
      nodeName: 'Restaurants',
      nodeNames: null,
      nodeParentId: 'cat-food',
      parentName: 'Food',
      parentNames: { pt: 'Comida' },
    });
    expect(rowToView(row, Locale.enum.pt)).toEqual({
      id: 'budget-1',
      currency: CurrencyCode.enum.BRL,
      limit: 500,
      period: BudgetPeriod.enum.monthly,
      category: 'Comida',
      subCategory: 'Restaurants',
    });
  });

  it('leaves the raw name untouched for the default locale', () => {
    expect(rowToView(viewRow(), Locale.enum.en).category).toBe('Food');
  });
});

describe('rowsToViews', () => {
  it('sorts by the localized category, not the raw repo order', () => {
    const rows: BudgetViewInput[] = [
      {
        id: 'budget-transport',
        currency: CurrencyCode.enum.BRL,
        limit: 100,
        period: BudgetPeriod.enum.monthly,
        targetId: 'cat-transport',
        nodeName: 'Transport',
        nodeNames: { pt: 'Alimentação' },
        nodeParentId: null,
        parentName: null,
        parentNames: null,
      },
      {
        id: 'budget-food',
        currency: CurrencyCode.enum.BRL,
        limit: 500,
        period: BudgetPeriod.enum.monthly,
        targetId: 'cat-food',
        nodeName: 'Food',
        nodeNames: { pt: 'Zoológico' },
        nodeParentId: null,
        parentName: null,
        parentNames: null,
      },
    ];
    // Raw-name order would be Food, Transport; pt-localized order flips it.
    expect(rowsToViews(rows, Locale.enum.pt).map((v) => v.category)).toEqual(['Alimentação', 'Zoológico']);
  });
});

describe('groupStatusByCategory', () => {
  // A top-level target: `targetId` matches a spend row's `categoryId` (ADR-028's rollup rule).
  const budgetRow = (overrides: Partial<BudgetViewInput> = {}): BudgetViewInput => ({
    id: 'budget-1',
    currency: CurrencyCode.enum.BRL,
    limit: 500,
    period: BudgetPeriod.enum.monthly,
    targetId: 'cat-food',
    nodeName: 'Food',
    nodeNames: null,
    nodeParentId: null,
    parentName: null,
    parentNames: null,
    ...overrides,
  });

  const spendRow = (overrides: Partial<CategorySpend> = {}): CategorySpend => ({
    currency: CurrencyCode.enum.BRL,
    categoryId: 'cat-food',
    subCategoryId: null,
    effective: 0,
    pending: 0,
    ...overrides,
  });

  describe('target matching (ADR-028 — the budgetTargetMatch rule as pure code)', () => {
    it('a top-level target rolls up every spend row sharing its categoryId, sub-category or not', () => {
      const [group] = groupStatusByCategory(
        [budgetRow()],
        [
          spendRow({ subCategoryId: null, effective: 100 }),
          spendRow({ subCategoryId: 'sub-restaurants', effective: 50 }),
        ],
        Locale.enum.en,
      );
      expect(group?.lines[0]).toMatchObject({ effective: { amount: 150 } });
    });

    it('a sub-category target matches only rows sharing its own id as subCategoryId', () => {
      const [group] = groupStatusByCategory(
        [
          budgetRow({
            targetId: 'sub-restaurants',
            nodeName: 'Restaurants',
            nodeParentId: 'cat-food',
            parentName: 'Food',
          }),
        ],
        [
          spendRow({ subCategoryId: 'sub-restaurants', effective: 50 }),
          spendRow({ subCategoryId: null, effective: 100 }), // the parent's own direct spend — excluded
        ],
        Locale.enum.en,
      );
      expect(group?.lines[0]).toMatchObject({ effective: { amount: 50 } });
    });

    it('ignores spend in a different currency than the budget', () => {
      const [group] = groupStatusByCategory(
        [budgetRow({ currency: CurrencyCode.enum.BRL })],
        [spendRow({ currency: CurrencyCode.enum.USD, effective: 999 })],
        Locale.enum.en,
      );
      expect(group?.lines[0]).toMatchObject({ effective: { amount: 0 } });
    });

    it('ignores spend under an unrelated category id', () => {
      const [group] = groupStatusByCategory(
        [budgetRow({ targetId: 'cat-food' })],
        [spendRow({ categoryId: 'cat-transport', effective: 999 })],
        Locale.enum.en,
      );
      expect(group?.lines[0]).toMatchObject({ effective: { amount: 0 } });
    });
  });

  describe('two-measure derivation (FD-020)', () => {
    it('computes remaining and pct for a single entry, effective-only (no pending)', () => {
      expect(groupStatusByCategory([budgetRow()], [spendRow({ effective: 200 })], Locale.enum.en)).toEqual([
        {
          category: 'Food',
          lines: [
            {
              id: 'budget-1',
              currency: CurrencyCode.enum.BRL,
              limit: 500,
              period: BudgetPeriod.enum.monthly,
              subCategory: undefined,
              effective: { amount: 200, pct: 0.4 },
              committed: { amount: 200, pct: 0.4 },
              pending: { amount: 0, pct: 0 },
              remaining: 300,
            },
          ],
        },
      ]);
    });

    it('mixes effective and pending: committed adds them, remaining is committed-relative', () => {
      const [group] = groupStatusByCategory(
        [budgetRow()],
        [spendRow({ effective: 150, pending: 100 })],
        Locale.enum.en,
      );
      expect(group?.lines[0]).toMatchObject({
        effective: { amount: 150, pct: 0.3 },
        committed: { amount: 250, pct: 0.5 },
        pending: { amount: 100, pct: 0.2 },
        remaining: 250,
      });
    });

    it('is over budget on committed while still under on effective — both reported, no clamp', () => {
      const [group] = groupStatusByCategory(
        [budgetRow()],
        [spendRow({ effective: 300, pending: 300 })],
        Locale.enum.en,
      );
      expect(group?.lines[0]).toMatchObject({
        effective: { amount: 300, pct: 0.6 },
        committed: { amount: 600, pct: 1.2 },
        remaining: -100,
      });
    });

    it('divides by a zero limit the same way for every measure — Infinity/NaN, not a guard', () => {
      const [group] = groupStatusByCategory([budgetRow({ limit: 0 })], [], Locale.enum.en);
      expect(group?.lines[0]).toMatchObject({
        effective: { amount: 0, pct: NaN },
        committed: { amount: 0, pct: NaN },
        pending: { amount: 0, pct: NaN },
        remaining: 0,
      });
    });

    it('reports over-budget as negative remaining and pct > 1, never an error', () => {
      const [group] = groupStatusByCategory([budgetRow()], [spendRow({ effective: 600 })], Locale.enum.en);
      expect(group?.lines[0]).toMatchObject({ remaining: -100, effective: { pct: 1.2 }, committed: { pct: 1.2 } });
    });

    it('reports amount: 0 for an empty month (no matching spend rows at all)', () => {
      const [group] = groupStatusByCategory([budgetRow()], [], Locale.enum.en);
      expect(group?.lines[0]).toMatchObject({
        effective: { amount: 0, pct: 0 },
        committed: { amount: 0, pct: 0 },
        remaining: 500,
      });
    });
  });

  describe('grouping/localization/sorting', () => {
    it('localizes the category name for the given locale', () => {
      const [group] = groupStatusByCategory([budgetRow({ nodeNames: { pt: 'Comida' } })], [], Locale.enum.pt);
      expect(group?.category).toBe('Comida');
    });

    it('localizes the parent category name for a sub-category budget', () => {
      const [group] = groupStatusByCategory(
        [
          budgetRow({
            id: 'budget-restaurants',
            targetId: 'sub-restaurants',
            nodeName: 'Restaurants',
            nodeParentId: 'cat-food',
            parentName: 'Food',
            parentNames: { pt: 'Comida' },
          }),
        ],
        [],
        Locale.enum.pt,
      );
      expect(group?.category).toBe('Comida');
      expect(group?.lines[0]).toMatchObject({ subCategory: 'Restaurants' });
    });

    it('falls back to the raw name when no names or no match for the locale', () => {
      const [group] = groupStatusByCategory([budgetRow({ nodeNames: { es: 'Comida' } })], [], Locale.enum.pt);
      expect(group?.category).toBe('Food');
    });

    it('groups a category budget and its sub-category budget under the same category', () => {
      const [group] = groupStatusByCategory(
        [
          budgetRow({ id: 'budget-food' }),
          budgetRow({
            id: 'budget-restaurants',
            targetId: 'sub-restaurants',
            nodeName: 'Restaurants',
            nodeParentId: 'cat-food',
            parentName: 'Food',
            limit: 100,
          }),
        ],
        [],
        Locale.enum.en,
      );
      expect(group?.category).toBe('Food');
      expect(group?.lines).toHaveLength(2);
      expect(group?.lines.map((l) => l.subCategory)).toEqual([undefined, 'Restaurants']);
    });

    it('keeps per-currency lines separate under one category group — never combined', () => {
      const [group] = groupStatusByCategory(
        [
          budgetRow({ id: 'budget-brl', currency: CurrencyCode.enum.BRL }),
          budgetRow({ id: 'budget-usd', currency: CurrencyCode.enum.USD, limit: 100 }),
        ],
        [],
        Locale.enum.en,
      );
      expect(group?.lines).toHaveLength(2);
      expect(group?.lines.map((l) => l.currency)).toEqual([CurrencyCode.enum.BRL, CurrencyCode.enum.USD]);
    });

    it('splits entries into separate groups by category', () => {
      const groups = groupStatusByCategory(
        [
          budgetRow({ nodeName: 'Food' }),
          budgetRow({ id: 'budget-2', targetId: 'cat-transport', nodeName: 'Transport' }),
        ],
        [],
        Locale.enum.en,
      );
      expect(groups.map((g) => g.category)).toEqual(['Food', 'Transport']);
    });

    it('returns an empty array for no budgets', () => {
      expect(groupStatusByCategory([], [], Locale.enum.en)).toEqual([]);
    });

    it('sorts groups by category name regardless of input order', () => {
      const groups = groupStatusByCategory(
        [
          budgetRow({ id: 'budget-transport', targetId: 'cat-transport', nodeName: 'Transport' }),
          budgetRow({ id: 'budget-food', nodeName: 'Food' }),
        ],
        [],
        Locale.enum.en,
      );
      expect(groups.map((g) => g.category)).toEqual(['Food', 'Transport']);
    });

    it("sorts a category's own line before its sub-categories', regardless of input order", () => {
      const [group] = groupStatusByCategory(
        [
          budgetRow({
            id: 'budget-restaurants',
            targetId: 'sub-restaurants',
            nodeName: 'Restaurants',
            nodeParentId: 'cat-food',
            parentName: 'Food',
            limit: 100,
          }),
          budgetRow({ id: 'budget-food' }),
        ],
        [],
        Locale.enum.en,
      );
      expect(group?.lines.map((l) => l.subCategory)).toEqual([undefined, 'Restaurants']);
    });

    it('sorts same-target lines by currency, regardless of input order', () => {
      const [group] = groupStatusByCategory(
        [
          budgetRow({ id: 'budget-usd', currency: CurrencyCode.enum.USD, limit: 100 }),
          budgetRow({ id: 'budget-brl', currency: CurrencyCode.enum.BRL }),
        ],
        [],
        Locale.enum.en,
      );
      expect(group?.lines.map((l) => l.currency)).toEqual([CurrencyCode.enum.BRL, CurrencyCode.enum.USD]);
    });
  });
});
