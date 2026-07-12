import { describe, expect, it } from 'vitest';
import { involvesCreditAccount } from '../../../src/controllers/resolve.js';
import type { Deps } from '../../../src/controllers/deps.js';
import type { Account } from '../../../src/models/account.js';

const account = (overrides: Partial<Account> = {}): Account => ({
  id: 'acc-1',
  name: 'Nubank',
  type: 'checking',
  currency: 'BRL',
  initialBalance: 0,
  ...overrides,
});

const makeDeps = (accountsById: Record<string, Account>): Deps =>
  ({
    accounts: { findById: async (id: string) => accountsById[id] ?? null } as unknown as Deps['accounts'],
  }) as Deps;

describe('involvesCreditAccount (ADR-020 ownership by account type)', () => {
  it('is true when the source account (accountId) is a credit account', async () => {
    const deps = makeDeps({ 'acc-card': account({ id: 'acc-card', type: 'credit' }) });
    expect(await involvesCreditAccount(deps, { accountId: 'acc-card', toAccountId: undefined })).toBe(true);
  });

  it('is true when the destination account (toAccountId) is a credit account (bill-payment transfer)', async () => {
    const deps = makeDeps({
      'acc-bank': account({ id: 'acc-bank', type: 'checking' }),
      'acc-card': account({ id: 'acc-card', type: 'credit' }),
    });
    expect(await involvesCreditAccount(deps, { accountId: 'acc-bank', toAccountId: 'acc-card' })).toBe(true);
  });

  it('is false when neither leg is a credit account (regular transfer or account movement)', async () => {
    const deps = makeDeps({
      'acc-bank': account({ id: 'acc-bank', type: 'checking' }),
      'acc-savings': account({ id: 'acc-savings', type: 'savings' }),
    });
    expect(await involvesCreditAccount(deps, { accountId: 'acc-bank', toAccountId: 'acc-savings' })).toBe(false);
  });

  it('is false when no leg is set (unattached movement)', async () => {
    const deps = makeDeps({});
    expect(await involvesCreditAccount(deps, { accountId: undefined, toAccountId: undefined })).toBe(false);
  });
});
