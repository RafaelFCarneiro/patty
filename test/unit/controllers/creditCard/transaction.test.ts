import { describe, expect, it, vi } from 'vitest';
import { deleteCardTransaction, updateCardTransaction } from '../../../../src/controllers/creditCard/transaction.js';
import type { Deps } from '../../../../src/controllers/deps.js';
import { Locale } from '../../../../src/models/locale.js';
import { BillStatus } from '../../../../src/models/bill.js';
import type { TransactionView } from '../../../../src/models/transaction.js';

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
  transactions: {} as Deps['transactions'],
  clock: () => new Date('2026-06-01'),
  newId: () => 'test-id',
  locale: async () => Locale.enum.en,
  resetLocale: vi.fn(),
  ...overrides,
});

const baseTx: TransactionView = {
  id: 'tx-1',
  description: 'Card purchase',
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

describe('updateCardTransaction / deleteCardTransaction — ownership guard (ADR-017)', () => {
  it('updateCardTransaction rejects an account-owned tx, redirecting to update_account_transaction', async () => {
    const deps = makeDeps({
      transactions: { getById: async () => baseTx } as unknown as Deps['transactions'],
    });

    const result = await updateCardTransaction(deps, { id: 'tx-1', description: 'Changed' });

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.code).toBe('validation');
    expect(error.issues?.[0]).toContain('update_account_transaction');
  });

  it('deleteCardTransaction rejects an account-owned tx, redirecting to delete_account_transaction', async () => {
    const deps = makeDeps({
      transactions: { getById: async () => baseTx } as unknown as Deps['transactions'],
    });

    const result = await deleteCardTransaction(deps, { id: 'tx-1', confirm: true });

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.code).toBe('validation');
    expect(error.issues?.[0]).toContain('delete_account_transaction');
  });
});

describe('updateCardTransaction / deleteCardTransaction — bill-payment transfer immutability (ADR-017.4)', () => {
  // billId set, no cardId: definitionally the transfer pay_bill created — nothing else in the domain
  // has billId without cardId.
  const paymentTransfer: TransactionView = { ...baseTx, cardId: undefined, billId: 'bill-1' };

  it('updateCardTransaction rejects any edit, not just reassignment, with no bills/cards lookup', async () => {
    const deps = makeDeps({
      transactions: { getById: async () => paymentTransfer } as unknown as Deps['transactions'],
    });

    const result = await updateCardTransaction(deps, { id: 'tx-1', amount: 999 });

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.code).toBe('validation');
    expect(error.issues?.[0]).toContain('revert_bill_payment');
  });

  it('deleteCardTransaction rejects it via the paid-bill immutability guard', async () => {
    const deps = makeDeps({
      transactions: { getById: async () => paymentTransfer } as unknown as Deps['transactions'],
      bills: {
        findById: async () => ({ id: 'bill-1', status: BillStatus.enum.paid }),
      } as unknown as Deps['bills'],
    });

    const result = await deleteCardTransaction(deps, { id: 'tx-1', confirm: true });

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.code).toBe('validation');
    expect(error.issues?.[0]).toContain('revert_bill_payment');
  });
});
