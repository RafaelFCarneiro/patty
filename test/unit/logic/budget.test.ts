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
import { BudgetPeriod, type Budget, type BudgetStatusInput, type BudgetViewInput } from '../../../src/models/budget.js';
import { Locale } from '../../../src/models/locale.js';
import { CurrencyCode } from '../../../src/models/money.js';

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
  const statusRow = (overrides: Partial<BudgetStatusInput> = {}): BudgetStatusInput => ({
    id: 'budget-1',
    currency: CurrencyCode.enum.BRL,
    limit: 500,
    period: BudgetPeriod.enum.monthly,
    nodeName: 'Food',
    nodeNames: null,
    nodeParentId: null,
    parentName: null,
    parentNames: null,
    spent: 200,
    ...overrides,
  });

  it('computes remaining and pct for a single entry', () => {
    expect(groupStatusByCategory([statusRow()], Locale.enum.en)).toEqual([
      {
        category: 'Food',
        lines: [
          {
            id: 'budget-1',
            currency: CurrencyCode.enum.BRL,
            limit: 500,
            period: BudgetPeriod.enum.monthly,
            subCategory: undefined,
            spent: 200,
            remaining: 300,
            pct: 0.4,
          },
        ],
      },
    ]);
  });

  it('localizes the category name for the given locale', () => {
    const [group] = groupStatusByCategory([statusRow({ nodeNames: { pt: 'Comida' } })], Locale.enum.pt);
    expect(group?.category).toBe('Comida');
  });

  it('localizes the parent category name for a sub-category budget', () => {
    const [group] = groupStatusByCategory(
      [
        statusRow({
          id: 'budget-restaurants',
          nodeName: 'Restaurants',
          nodeParentId: 'cat-food',
          parentName: 'Food',
          parentNames: { pt: 'Comida' },
        }),
      ],
      Locale.enum.pt,
    );
    expect(group?.category).toBe('Comida');
    expect(group?.lines[0]).toMatchObject({ subCategory: 'Restaurants' });
  });

  it('falls back to the raw name when no names or no match for the locale', () => {
    const [group] = groupStatusByCategory([statusRow({ nodeNames: { es: 'Comida' } })], Locale.enum.pt);
    expect(group?.category).toBe('Food');
  });

  it('reports over-budget as negative remaining and pct > 1, never an error', () => {
    const [group] = groupStatusByCategory([statusRow({ spent: 600 })], Locale.enum.en);
    expect(group?.lines[0]).toMatchObject({ remaining: -100, pct: 1.2 });
  });

  it('reports spent: 0 for an empty month', () => {
    const [group] = groupStatusByCategory([statusRow({ spent: 0 })], Locale.enum.en);
    expect(group?.lines[0]).toMatchObject({ spent: 0, remaining: 500, pct: 0 });
  });

  it('groups a category budget and its sub-category budget under the same category', () => {
    const [group] = groupStatusByCategory(
      [
        statusRow({ id: 'budget-food', spent: 200 }),
        statusRow({
          id: 'budget-restaurants',
          nodeName: 'Restaurants',
          nodeParentId: 'cat-food',
          parentName: 'Food',
          limit: 100,
          spent: 50,
        }),
      ],
      Locale.enum.en,
    );
    expect(group?.category).toBe('Food');
    expect(group?.lines).toHaveLength(2);
    expect(group?.lines.map((l) => l.subCategory)).toEqual([undefined, 'Restaurants']);
  });

  it('keeps per-currency lines separate under one category group — never combined', () => {
    const [group] = groupStatusByCategory(
      [
        statusRow({ id: 'budget-brl', currency: CurrencyCode.enum.BRL, spent: 200 }),
        statusRow({ id: 'budget-usd', currency: CurrencyCode.enum.USD, limit: 100, spent: 30 }),
      ],
      Locale.enum.en,
    );
    expect(group?.lines).toHaveLength(2);
    expect(group?.lines.map((l) => l.currency)).toEqual([CurrencyCode.enum.BRL, CurrencyCode.enum.USD]);
  });

  it('splits entries into separate groups by category', () => {
    const groups = groupStatusByCategory(
      [statusRow({ nodeName: 'Food' }), statusRow({ id: 'budget-2', nodeName: 'Transport' })],
      Locale.enum.en,
    );
    expect(groups.map((g) => g.category)).toEqual(['Food', 'Transport']);
  });

  it('returns an empty array for no budgets', () => {
    expect(groupStatusByCategory([], Locale.enum.en)).toEqual([]);
  });

  it('sorts groups by category name regardless of input order', () => {
    const groups = groupStatusByCategory(
      [
        statusRow({ id: 'budget-transport', nodeName: 'Transport' }),
        statusRow({ id: 'budget-food', nodeName: 'Food' }),
      ],
      Locale.enum.en,
    );
    expect(groups.map((g) => g.category)).toEqual(['Food', 'Transport']);
  });

  it("sorts a category's own line before its sub-categories', regardless of input order", () => {
    const [group] = groupStatusByCategory(
      [
        statusRow({
          id: 'budget-restaurants',
          nodeName: 'Restaurants',
          nodeParentId: 'cat-food',
          parentName: 'Food',
          limit: 100,
          spent: 50,
        }),
        statusRow({ id: 'budget-food' }),
      ],
      Locale.enum.en,
    );
    expect(group?.lines.map((l) => l.subCategory)).toEqual([undefined, 'Restaurants']);
  });

  it('sorts same-target lines by currency, regardless of input order', () => {
    const [group] = groupStatusByCategory(
      [
        statusRow({ id: 'budget-usd', currency: CurrencyCode.enum.USD, limit: 100, spent: 30 }),
        statusRow({ id: 'budget-brl', currency: CurrencyCode.enum.BRL, spent: 200 }),
      ],
      Locale.enum.en,
    );
    expect(group?.lines.map((l) => l.currency)).toEqual([CurrencyCode.enum.BRL, CurrencyCode.enum.USD]);
  });
});
