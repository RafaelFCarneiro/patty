import { describe, expect, it, vi } from 'vitest';
import { deleteCardTransaction, updateCardTransaction } from '../../../../src/controllers/creditCard/transaction.js';
import type { Deps } from '../../../../src/controllers/deps.js';
import type { Account } from '../../../../src/models/account.js';
import { Locale } from '../../../../src/models/locale.js';
import { BillStatus } from '../../../../src/models/bill.js';
import type { TransactionView } from '../../../../src/models/transaction.js';

const account = (overrides: Partial<Account> = {}): Account => ({
  id: 'acc-checking',
  name: 'Checking',
  type: 'checking',
  currency: 'USD',
  initialBalance: 0,
  ...overrides,
});

const makeDeps = (overrides: Partial<Deps> = {}): Deps => ({
  accounts: { findById: async () => null } as unknown as Deps['accounts'],
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

const checkingAccountsById = { findById: async () => account({ type: 'checking' }) };

describe('updateCardTransaction / deleteCardTransaction — ownership by account type (ADR-020)', () => {
  it('updateCardTransaction rejects a tx with no credit leg, redirecting to update_account_transaction', async () => {
    const deps = makeDeps({
      transactions: {
        getById: async () => ({ ...baseTx, accountId: 'acc-checking' }),
      } as unknown as Deps['transactions'],
      accounts: checkingAccountsById as unknown as Deps['accounts'],
    });

    const result = await updateCardTransaction(deps, { id: 'tx-1', description: 'Changed' });

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.code).toBe('validation');
    expect(error.issues?.[0]).toContain('update_account_transaction');
  });

  it('deleteCardTransaction rejects a tx with no credit leg, redirecting to delete_account_transaction', async () => {
    const deps = makeDeps({
      transactions: {
        getById: async () => ({ ...baseTx, accountId: 'acc-checking' }),
      } as unknown as Deps['transactions'],
      accounts: checkingAccountsById as unknown as Deps['accounts'],
    });

    const result = await deleteCardTransaction(deps, { id: 'tx-1', confirm: true });

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.code).toBe('validation');
    expect(error.issues?.[0]).toContain('delete_account_transaction');
  });
});

describe('updateCardTransaction — account field (ADR-019 compose-up watchpoint)', () => {
  // UpdateCardTransactionSchema still accepts `account` (extended onto the minimal core, not
  // omitted) precisely so this dedicated, friendly error fires — a `.strict()` rejection of an
  // unrecognized key would replace it with a generic schema-validation error instead.
  it('rejects a present account with the dedicated accountChangeRejectedForCard message', async () => {
    const deps = makeDeps({
      transactions: {
        getById: async () => ({ ...baseTx, accountId: 'acc-card-internal', cardId: 'card-1' }),
      } as unknown as Deps['transactions'],
      accounts: {
        findById: async () => account({ id: 'acc-card-internal', type: 'credit' }),
      } as unknown as Deps['accounts'],
    });

    const result = await updateCardTransaction(deps, { id: 'tx-1', account: 'Nubank' });

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.code).toBe('validation');
    expect(error.issues?.[0]).toContain('cannot change the account of a card transaction');
  });
});

describe('updateCardTransaction / deleteCardTransaction — bill-payment transfer immutability (ADR-020 §3)', () => {
  // billId set, no cardId: definitionally the transfer pay_bill created — nothing else in the domain
  // has billId without cardId. Its toAccountId is the card's own internal (credit) account — the leg
  // that makes it card-owned under ADR-020's account-type rule.
  const paymentTransfer: TransactionView = {
    ...baseTx,
    cardId: undefined,
    billId: 'bill-1',
    accountId: 'acc-payer',
    toAccountId: 'acc-card-internal',
  };
  const accountsById: Record<string, Account> = {
    'acc-payer': account({ id: 'acc-payer', type: 'checking' }),
    'acc-card-internal': account({ id: 'acc-card-internal', type: 'credit' }),
  };
  const findById = async (id: string) => accountsById[id] ?? null;

  it('updateCardTransaction rejects any edit, not just reassignment — never via transfer-immutability', async () => {
    const deps = makeDeps({
      transactions: { getById: async () => paymentTransfer } as unknown as Deps['transactions'],
      accounts: { findById } as unknown as Deps['accounts'],
    });

    const result = await updateCardTransaction(deps, { id: 'tx-1', amount: 999 });

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.code).toBe('validation');
    // Rejected via the bill-process guard (paidBillImmutable), not transfer-type-immutable —
    // the card aggregate never runs guardTransferMutability (ADR-020 §3/§4).
    expect(error.issues?.[0]).toContain('revert_bill_payment');
    expect(error.issues?.[0]).not.toContain('cannot change the type of a transfer');
  });

  it('deleteCardTransaction rejects it via the paid-bill immutability guard', async () => {
    const deps = makeDeps({
      transactions: { getById: async () => paymentTransfer } as unknown as Deps['transactions'],
      accounts: { findById } as unknown as Deps['accounts'],
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
