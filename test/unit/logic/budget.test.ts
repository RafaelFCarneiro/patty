import { describe, expect, it } from 'vitest';
import { hasExactlyOneTarget, isExpenseEligible, toView } from '../../../src/logic/budget.js';
import { CategoryKind } from '../../../src/models/category.js';
import { BudgetPeriod, type Budget } from '../../../src/models/budget.js';
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
