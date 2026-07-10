import { describe, expect, it, vi } from 'vitest';
import { assertOwnership, updateTransaction } from '../../../../src/controllers/transaction/core.js';
import type { Deps } from '../../../../src/controllers/deps.js';
import { TransactionTool, type TransactionView } from '../../../../src/models/transaction.js';
import { Locale } from '../../../../src/models/locale.js';

const makeDeps = (): Deps => ({
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
  transactions: {} as Deps['transactions'],
  clock: () => new Date('2026-06-01'),
  newId: () => 'test-id',
  locale: async () => Locale.enum.en,
  resetLocale: vi.fn(),
});

const existingTransaction: TransactionView = {
  id: 'tx-1',
  description: 'Original',
  amount: 40,
  type: 'expense',
  status: 'effective',
  date: '2026-06-01',
  currency: 'USD',
  source: 'mcp',
  idempotencyKey: 'existing-key',
  classification: { method: 'none', confidence: 0 },
  tags: [],
};

describe('updateTransaction — account resolution is value-based, not truthy', () => {
  it('rejects a present-but-empty account with unknown_account, not silently ignoring it', async () => {
    const deps = makeDeps();

    const result = await updateTransaction(deps, { id: 'tx-1', account: '' }, existingTransaction);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('unknown_account');
  });
});

describe('assertOwnership (ADR-017 ownership guard)', () => {
  it('passes when the transaction is card-owned and the caller wants card-owned', () => {
    const result = assertOwnership(
      { ...existingTransaction, cardId: 'card-1' },
      true,
      TransactionTool.updateAccountTransaction,
    );
    expect(result.isOk()).toBe(true);
  });

  it('passes when the transaction is account-owned and the caller wants account-owned', () => {
    const result = assertOwnership(existingTransaction, false, TransactionTool.updateCardTransaction);
    expect(result.isOk()).toBe(true);
  });

  it('rejects with a validation error naming the correct tool when card-owned but account-owned expected', () => {
    const result = assertOwnership(
      { ...existingTransaction, billId: 'bill-1' },
      false,
      TransactionTool.updateCardTransaction,
    );
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.code).toBe('validation');
    expect(error.issues?.[0]).toContain('update_card_transaction');
  });

  it('rejects with a validation error naming the correct tool when account-owned but card-owned expected', () => {
    const result = assertOwnership(existingTransaction, true, TransactionTool.updateAccountTransaction);
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.code).toBe('validation');
    expect(error.issues?.[0]).toContain('update_account_transaction');
  });
});
