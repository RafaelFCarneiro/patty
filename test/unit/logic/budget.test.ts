import { describe, expect, it } from 'vitest';
import { groupStatusByCategory, hasExactlyOneTarget, isExpenseEligible, toView } from '../../../src/logic/budget.js';
import { CategoryKind } from '../../../src/models/category.js';
import { BudgetPeriod, type Budget, type BudgetStatusEntry } from '../../../src/models/budget.js';
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

describe('groupStatusByCategory', () => {
  const entry = (overrides: Partial<BudgetStatusEntry> = {}): BudgetStatusEntry => ({
    id: 'budget-1',
    currency: CurrencyCode.enum.BRL,
    limit: 500,
    period: BudgetPeriod.enum.monthly,
    category: 'Food',
    spent: 200,
    ...overrides,
  });

  it('computes remaining and pct for a single entry', () => {
    expect(groupStatusByCategory([entry()])).toEqual([
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

  it('reports over-budget as negative remaining and pct > 1, never an error', () => {
    const [group] = groupStatusByCategory([entry({ spent: 600 })]);
    expect(group?.lines[0]).toMatchObject({ remaining: -100, pct: 1.2 });
  });

  it('reports spent: 0 for an empty month', () => {
    const [group] = groupStatusByCategory([entry({ spent: 0 })]);
    expect(group?.lines[0]).toMatchObject({ spent: 0, remaining: 500, pct: 0 });
  });

  it('groups a category budget and its sub-category budget under the same category', () => {
    const [group] = groupStatusByCategory([
      entry({ id: 'budget-food', spent: 200 }),
      entry({ id: 'budget-restaurants', subCategory: 'Restaurants', limit: 100, spent: 50 }),
    ]);
    expect(group?.category).toBe('Food');
    expect(group?.lines).toHaveLength(2);
    expect(group?.lines.map((l) => l.subCategory)).toEqual([undefined, 'Restaurants']);
  });

  it('keeps per-currency lines separate under one category group — never combined', () => {
    const [group] = groupStatusByCategory([
      entry({ id: 'budget-brl', currency: CurrencyCode.enum.BRL, spent: 200 }),
      entry({ id: 'budget-usd', currency: CurrencyCode.enum.USD, limit: 100, spent: 30 }),
    ]);
    expect(group?.lines).toHaveLength(2);
    expect(group?.lines.map((l) => l.currency)).toEqual([CurrencyCode.enum.BRL, CurrencyCode.enum.USD]);
  });

  it('splits entries into separate groups by category', () => {
    const groups = groupStatusByCategory([
      entry({ category: 'Food' }),
      entry({ id: 'budget-2', category: 'Transport' }),
    ]);
    expect(groups.map((g) => g.category)).toEqual(['Food', 'Transport']);
  });

  it('returns an empty array for no budgets', () => {
    expect(groupStatusByCategory([])).toEqual([]);
  });
});
