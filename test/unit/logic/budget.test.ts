import { describe, expect, it } from 'vitest';
import { hasExactlyOneTarget, isExpenseEligible } from '../../../src/logic/budget.js';
import { CategoryKind } from '../../../src/models/category.js';

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
