import { describe, expect, it, vi } from 'vitest';
import { createTransaction } from '../../../../src/controllers/transaction/movement.js';
import type { Deps } from '../../../../src/controllers/deps.js';
import { TransactionSource } from '../../../../src/models/transaction.js';
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

describe('createTransaction — account resolution is value-based, not truthy', () => {
  it('rejects a present-but-empty account with unknown_account, not silently ignoring it', async () => {
    const deps = makeDeps();

    const result = await createTransaction(
      deps,
      {
        description: 'Test',
        amount: 10,
        type: 'expense',
        account: '',
        idempotencyKey: 'movement-empty-account',
      },
      TransactionSource.enum.mcp,
    );

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('unknown_account');
  });
});
