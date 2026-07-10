import { describe, expect, it, vi } from 'vitest';
import { addAccountExpense, addAccountIncome } from '../../../../src/controllers/account/accountTransaction.js';
import type { Deps } from '../../../../src/controllers/deps.js';
import type { Account } from '../../../../src/models/account.js';
import { TransactionSource } from '../../../../src/models/transaction.js';
import { Locale } from '../../../../src/models/locale.js';

const makeDeps = (overrides: Partial<Deps> = {}): Deps => ({
  accounts: { list: async () => [] } as unknown as Deps['accounts'],
  bills: {} as Deps['bills'],
  categories: {} as Deps['categories'],
  subCategories: {} as Deps['subCategories'],
  creditCards: {} as Deps['creditCards'],
  dashboards: {} as Deps['dashboards'],
  health: {} as Deps['health'],
  merchants: { matchCandidates: async () => [] } as unknown as Deps['merchants'],
  recurring: {} as Deps['recurring'],
  settings: {} as Deps['settings'],
  tags: {} as Deps['tags'],
  transactions: {
    create: async (entity) => ({
      transaction: { ...entity, accountId: entity.refs.accountId, categoryId: entity.refs.categoryId },
      created: true,
    }),
  } as unknown as Deps['transactions'],
  clock: () => new Date('2026-06-01'),
  newId: () => 'test-id',
  locale: async () => Locale.enum.en,
  resetLocale: vi.fn(),
  ...overrides,
});

const account = (overrides: Partial<Account> = {}): Account => ({
  id: 'acc-1',
  name: 'Nubank',
  type: 'checking',
  currency: 'BRL',
  initialBalance: 0,
  ...overrides,
});

describe('addAccountExpense — account resolution is value-based, not truthy', () => {
  it('rejects a present-but-empty account with unknown_account, not silently ignoring it', async () => {
    const deps = makeDeps();

    const result = await addAccountExpense(
      deps,
      { description: 'Test', amount: 10, account: '', idempotencyKey: 'account-empty-account' },
      TransactionSource.enum.mcp,
    );

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('unknown_account');
  });
});

describe('addAccountExpense / addAccountIncome — credit account rejection', () => {
  it('rejects posting directly to a credit account', async () => {
    const deps = makeDeps({
      accounts: { list: async () => [account({ type: 'credit' })] } as unknown as Deps['accounts'],
    });

    const result = await addAccountExpense(
      deps,
      { description: 'Card fee', amount: 5, account: 'Nubank', idempotencyKey: 'credit-post-rejected' },
      TransactionSource.enum.mcp,
    );

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });
});

describe('addAccountExpense / addAccountIncome — category/sub-category exclusivity', () => {
  it('rejects when both category and subCategory are provided', async () => {
    const deps = makeDeps();

    const result = await addAccountIncome(
      deps,
      {
        description: 'Salary',
        amount: 100,
        category: 'Income',
        subCategory: 'Salary',
        idempotencyKey: 'exclusive-category',
      },
      TransactionSource.enum.mcp,
    );

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toMatchObject({
      code: 'validation',
      issues: ['provide category OR subCategory, not both — subCategory implies its parent category'],
    });
  });
});

describe('addAccountExpense — currency resolution', () => {
  it('uses the account currency, ignoring the input currency field', async () => {
    const deps = makeDeps({
      accounts: { list: async () => [account({ currency: 'BRL' })] } as unknown as Deps['accounts'],
    });

    const result = await addAccountExpense(
      deps,
      { description: 'Lunch', amount: 20, account: 'Nubank', currency: 'USD', idempotencyKey: 'currency-account' },
      TransactionSource.enum.mcp,
    );

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().transaction.currency).toBe('BRL');
  });

  it('falls back to the input currency (default USD) when no account is given', async () => {
    const deps = makeDeps();

    const result = await addAccountExpense(
      deps,
      { description: 'Cash lunch', amount: 20, idempotencyKey: 'currency-no-account' },
      TransactionSource.enum.mcp,
    );

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().transaction.currency).toBe('USD');
  });
});

describe('addAccountExpense — classification', () => {
  it('auto-classifies via merchant matches when no category is given', async () => {
    const deps = makeDeps({
      merchants: {
        matchCandidates: async () => [
          { merchantKey: 'uber', categoryId: 'cat-transport', categoryName: 'Transport', weight: 3, origin: 'rule' },
        ],
      } as unknown as Deps['merchants'],
    });

    const result = await addAccountExpense(
      deps,
      { description: 'Uber ride', amount: 15, idempotencyKey: 'classify-auto' },
      TransactionSource.enum.mcp,
    );

    expect(result.isOk()).toBe(true);
    const { classification } = result._unsafeUnwrap();
    expect(classification.method).toBe('rule');
    expect(classification.categoryId).toBe('cat-transport');
  });

  it('sets type to income for addAccountIncome and expense for addAccountExpense', async () => {
    const deps = makeDeps();

    const expenseResult = await addAccountExpense(
      deps,
      { description: 'Groceries', amount: 30, idempotencyKey: 'type-expense' },
      TransactionSource.enum.mcp,
    );
    const incomeResult = await addAccountIncome(
      deps,
      { description: 'Salary', amount: 3000, idempotencyKey: 'type-income' },
      TransactionSource.enum.mcp,
    );

    expect(expenseResult._unsafeUnwrap().transaction.type).toBe('expense');
    expect(incomeResult._unsafeUnwrap().transaction.type).toBe('income');
  });
});
