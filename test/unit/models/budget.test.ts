import { describe, expect, it } from 'vitest';
import {
  budgetErrors,
  BudgetPeriod,
  BudgetSchema,
  BudgetViewSchema,
  CreateBudgetSchema,
  UpdateBudgetSchema,
} from '../../../src/models/budget.js';
import { CurrencyCode } from '../../../src/models/money.js';

describe('BudgetSchema', () => {
  it('accepts a valid budget', () => {
    const result = BudgetSchema.safeParse({
      id: 'budget-1',
      categoryId: 'cat-food',
      currency: CurrencyCode.enum.BRL,
      limit: 500,
      period: BudgetPeriod.enum.monthly,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a non-positive limit', () => {
    expect(
      BudgetSchema.safeParse({
        id: 'budget-1',
        categoryId: 'cat-food',
        currency: CurrencyCode.enum.BRL,
        limit: 0,
        period: BudgetPeriod.enum.monthly,
      }).success,
    ).toBe(false);
  });

  it('rejects an unknown period', () => {
    expect(
      BudgetSchema.safeParse({
        id: 'budget-1',
        categoryId: 'cat-food',
        currency: CurrencyCode.enum.BRL,
        limit: 500,
        period: 'weekly',
      }).success,
    ).toBe(false);
  });
});

describe('BudgetViewSchema', () => {
  it('accepts a top-level category budget with no subCategory', () => {
    const result = BudgetViewSchema.safeParse({
      id: 'budget-1',
      category: 'Food',
      currency: CurrencyCode.enum.BRL,
      limit: 500,
      period: BudgetPeriod.enum.monthly,
    });
    expect(result.success).toBe(true);
  });

  it('accepts a sub-category budget', () => {
    const result = BudgetViewSchema.safeParse({
      id: 'budget-1',
      category: 'Food',
      subCategory: 'Restaurants',
      currency: CurrencyCode.enum.BRL,
      limit: 500,
      period: BudgetPeriod.enum.monthly,
    });
    expect(result.success).toBe(true);
  });

  it('has no categoryId field', () => {
    const parsed = BudgetViewSchema.parse({
      id: 'budget-1',
      category: 'Food',
      currency: CurrencyCode.enum.BRL,
      limit: 500,
      period: BudgetPeriod.enum.monthly,
    });
    expect('categoryId' in parsed).toBe(false);
  });
});

describe('CreateBudgetSchema', () => {
  it('accepts a category target', () => {
    expect(
      CreateBudgetSchema.safeParse({
        category: 'Food',
        currency: CurrencyCode.enum.BRL,
        limit: 500,
        period: BudgetPeriod.enum.monthly,
      }).success,
    ).toBe(true);
  });

  it('accepts a subCategory target', () => {
    expect(
      CreateBudgetSchema.safeParse({
        subCategory: 'Restaurants',
        currency: CurrencyCode.enum.BRL,
        limit: 500,
        period: BudgetPeriod.enum.monthly,
      }).success,
    ).toBe(true);
  });

  it('rejects a non-positive limit', () => {
    const result = CreateBudgetSchema.safeParse({
      category: 'Food',
      currency: CurrencyCode.enum.BRL,
      limit: 0,
      period: BudgetPeriod.enum.monthly,
    });
    expect(result.success).toBe(false);
  });
});

describe('UpdateBudgetSchema', () => {
  it('accepts an id-only patch (no-op update)', () => {
    expect(UpdateBudgetSchema.safeParse({ id: 'budget-1' }).success).toBe(true);
  });

  it('rejects a non-positive limit', () => {
    expect(UpdateBudgetSchema.safeParse({ id: 'budget-1', limit: -5 }).success).toBe(false);
  });
});

describe('budgetErrors.notExpenseCategory', () => {
  it('builds a not_expense_category error carrying the category name', () => {
    expect(budgetErrors.notExpenseCategory('Salary')).toEqual({ code: 'not_expense_category', category: 'Salary' });
  });
});

describe('budgetErrors.duplicate', () => {
  it('builds a duplicate_budget error carrying target/currency/period', () => {
    expect(
      budgetErrors.duplicate(
        { category: 'Food', subCategory: 'Restaurants' },
        CurrencyCode.enum.BRL,
        BudgetPeriod.enum.monthly,
      ),
    ).toEqual({
      code: 'duplicate_budget',
      category: 'Food',
      subCategory: 'Restaurants',
      currency: CurrencyCode.enum.BRL,
      period: BudgetPeriod.enum.monthly,
    });
  });

  it('omits subCategory for a top-level-category target', () => {
    expect(budgetErrors.duplicate({ category: 'Food' }, CurrencyCode.enum.BRL, BudgetPeriod.enum.monthly)).toEqual({
      code: 'duplicate_budget',
      category: 'Food',
      subCategory: undefined,
      currency: CurrencyCode.enum.BRL,
      period: BudgetPeriod.enum.monthly,
    });
  });
});
