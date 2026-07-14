import { describe, expect, it, vi } from 'vitest';
import { updateTransaction } from '../../../../src/controllers/transaction/core.js';
import type { Deps } from '../../../../src/controllers/deps.js';
import type { RawTransactionView } from '../../../../src/models/transaction.js';
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

const existingTransaction: RawTransactionView = {
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
  version: 0,
};

describe('updateTransaction — account resolution is value-based, not truthy', () => {
  it('rejects a present-but-empty account with unknown_account, not silently ignoring it', async () => {
    const deps = makeDeps();

    const result = await updateTransaction(deps, { id: 'tx-1', account: '' }, existingTransaction);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('unknown_account');
  });
});

describe('updateTransaction — merchant-learning write-back (still repo-driven, phase 2b)', () => {
  it('strengthens the merchant association via incrementCategoryWeight on a category correction', async () => {
    const incrementCategoryWeight = vi.fn(async () => {});
    const deps = makeDeps();
    deps.merchants = { matchCandidates: async () => [], incrementCategoryWeight } as unknown as Deps['merchants'];
    deps.transactions = {
      update: async () => ({ ...existingTransaction, categoryId: 'cat-new' }),
    } as unknown as Deps['transactions'];
    deps.categories = {
      list: async () => [{ id: 'cat-new', name: 'Transporte', kind: 'both', names: null }],
    } as unknown as Deps['categories'];

    const existingWithMerchant = { ...existingTransaction, categoryId: 'cat-old', merchant: 'uber' };
    const result = await updateTransaction(deps, { id: 'tx-1', category: 'Transporte' }, existingWithMerchant);

    expect(result.isOk()).toBe(true);
    expect(incrementCategoryWeight).toHaveBeenCalledWith('uber', 'cat-new');
  });

  it('does not call incrementCategoryWeight when no category correction is given', async () => {
    const incrementCategoryWeight = vi.fn(async () => {});
    const deps = makeDeps();
    deps.merchants = { matchCandidates: async () => [], incrementCategoryWeight } as unknown as Deps['merchants'];
    deps.transactions = { update: async () => existingTransaction } as unknown as Deps['transactions'];

    const existingWithMerchant = { ...existingTransaction, merchant: 'uber' };
    const result = await updateTransaction(deps, { id: 'tx-1', description: 'Renamed' }, existingWithMerchant);

    expect(result.isOk()).toBe(true);
    expect(incrementCategoryWeight).not.toHaveBeenCalled();
  });
});
