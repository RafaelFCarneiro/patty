import { describe, expect, it } from 'vitest';
import * as wireInRecurring from '../../../src/wire/in/recurring.js';
import * as recurringAdapters from '../../../src/adapters/recurring.js';

const sqlRow = (overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> => ({
  id: 'rec-1',
  description: 'Rent',
  amount: 1000,
  type: 'expense',
  period: 'monthly',
  next_due: '2026-07-01',
  currency: 'BRL',
  account_id: 'acc-1',
  account_name: 'Nubank',
  category_id: 'cat-1',
  category_name: 'Housing',
  merchant_key: 'landlord',
  version: 2,
  ...overrides,
});

describe('dbToModel', () => {
  it('decodes the raw SQL row into a RecurringRuleView, joined names included', () => {
    const rule = recurringAdapters.dbToModel(sqlRow());
    expect(rule).toEqual({
      id: 'rec-1',
      description: 'Rent',
      amount: 1000,
      type: 'expense',
      period: 'monthly',
      nextDue: '2026-07-01',
      currency: 'BRL',
      accountId: 'acc-1',
      accountName: 'Nubank',
      categoryId: 'cat-1',
      categoryName: 'Housing',
      merchantKey: 'landlord',
    });
  });

  it('maps null relation columns to undefined optionals, not version', () => {
    const rule = recurringAdapters.dbToModel(
      sqlRow({ account_id: null, account_name: null, category_id: null, category_name: null, merchant_key: null }),
    );
    expect(rule.accountId).toBeUndefined();
    expect(rule.categoryId).toBeUndefined();
    expect(rule.merchantKey).toBeUndefined();
    expect(rule).not.toHaveProperty('version');
  });

  it('rejects invalid records (decode at the boundary)', () => {
    expect(() => recurringAdapters.dbToModel(sqlRow({ next_due: 123 }))).toThrow();
  });
});

describe('dbToEntity', () => {
  it('carries version, no joined display names', () => {
    const rule = recurringAdapters.dbToEntity(sqlRow());
    expect(rule).toEqual({
      id: 'rec-1',
      description: 'Rent',
      amount: 1000,
      type: 'expense',
      period: 'monthly',
      nextDue: '2026-07-01',
      currency: 'BRL',
      accountId: 'acc-1',
      categoryId: 'cat-1',
      merchantKey: 'landlord',
      version: 2,
    });
  });

  it('maps null relation columns to undefined optionals', () => {
    const rule = recurringAdapters.dbToEntity(
      sqlRow({ account_id: null, category_id: null, merchant_key: null }),
    );
    expect(rule.accountId).toBeUndefined();
    expect(rule.categoryId).toBeUndefined();
    expect(rule.merchantKey).toBeUndefined();
  });
});

describe('wireInToModel', () => {
  it('passes all required fields through unchanged', () => {
    const parsed = wireInRecurring.CreateRecurringSchema.parse({
      description: 'Spotify',
      amount: 21.9,
      type: 'expense',
      period: 'monthly',
      startDate: '2026-01-01',
    });
    expect(recurringAdapters.wireInToModel(parsed)).toMatchObject({
      description: 'Spotify',
      amount: 21.9,
      type: 'expense',
      period: 'monthly',
      startDate: '2026-01-01',
    });
  });

  it('preserves optional fields when provided', () => {
    const parsed = wireInRecurring.CreateRecurringSchema.parse({
      description: 'Salário',
      amount: 5000,
      type: 'income',
      period: 'monthly',
      startDate: '2026-06-01',
      account: 'acc-nubank',
      category: 'cat-salario',
      currency: 'USD',
      merchant: 'Employer Inc',
    });
    expect(recurringAdapters.wireInToModel(parsed)).toMatchObject({
      account: 'acc-nubank',
      category: 'cat-salario',
      currency: 'USD',
      merchant: 'Employer Inc',
    });
  });
});
