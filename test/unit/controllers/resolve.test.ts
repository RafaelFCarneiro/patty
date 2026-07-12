import { describe, expect, it } from 'vitest';
import { resolveLegAccounts } from '../../../src/controllers/resolve.js';
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

describe('resolveLegAccounts (ADR-020 — neutral leg resolution, no ownership judgment)', () => {
  it('resolves the source account when only accountId is set', async () => {
    const deps = makeDeps({ 'acc-bank': account({ id: 'acc-bank' }) });
    const legs = await resolveLegAccounts(deps, { accountId: 'acc-bank', toAccountId: undefined });
    expect(legs).toEqual([account({ id: 'acc-bank' })]);
  });

  it('resolves both legs when accountId and toAccountId are both set (a transfer)', async () => {
    const deps = makeDeps({
      'acc-bank': account({ id: 'acc-bank', type: 'checking' }),
      'acc-card': account({ id: 'acc-card', type: 'credit' }),
    });
    const legs = await resolveLegAccounts(deps, { accountId: 'acc-bank', toAccountId: 'acc-card' });
    expect(legs.map((a) => a.id)).toEqual(['acc-bank', 'acc-card']);
  });

  it('returns an empty array when no leg is set (unattached movement)', async () => {
    const deps = makeDeps({});
    const legs = await resolveLegAccounts(deps, { accountId: undefined, toAccountId: undefined });
    expect(legs).toEqual([]);
  });

  it('skips a leg id that no longer resolves to an account', async () => {
    const deps = makeDeps({});
    const legs = await resolveLegAccounts(deps, { accountId: 'missing', toAccountId: undefined });
    expect(legs).toEqual([]);
  });
});
