import { describe, expect, it } from 'vitest';
import { resolveLegAccounts } from '../../../src/controllers/resolve.js';
import type { Deps } from '../../../src/controllers/deps.js';
import { AccountType, type Account } from '../../../src/models/account.js';
import { CurrencyCode } from '../../../src/models/money.js';

const account = (overrides: Partial<Account> = {}): Account => ({
  id: 'acc-1',
  name: 'Nubank',
  type: AccountType.enum.checking,
  currency: CurrencyCode.enum.BRL,
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
    const result = await resolveLegAccounts(deps, { accountId: 'acc-bank', toAccountId: undefined });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual([account({ id: 'acc-bank' })]);
  });

  it('resolves both legs when accountId and toAccountId are both set (a transfer)', async () => {
    const deps = makeDeps({
      'acc-bank': account({ id: 'acc-bank', type: AccountType.enum.checking }),
      'acc-card': account({ id: 'acc-card', type: AccountType.enum.credit }),
    });
    const result = await resolveLegAccounts(deps, { accountId: 'acc-bank', toAccountId: 'acc-card' });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().map((a) => a.id)).toEqual(['acc-bank', 'acc-card']);
  });

  it('returns an empty array when no leg is set (unattached movement)', async () => {
    const deps = makeDeps({});
    const result = await resolveLegAccounts(deps, { accountId: undefined, toAccountId: undefined });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual([]);
  });

  it('fails on the Result track (unknown_account) when a leg account no longer exists', async () => {
    const deps = makeDeps({});
    const result = await resolveLegAccounts(deps, { accountId: 'missing', toAccountId: undefined });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toMatchObject({ code: 'unknown_account', query: 'missing' });
  });

  it('dedupes a leg id shared by accountId and toAccountId, fetching and returning it once', async () => {
    let callCount = 0;
    const deps = {
      accounts: {
        findById: async (id: string) => {
          callCount++;
          return account({ id });
        },
      },
    } as unknown as Deps;

    const result = await resolveLegAccounts(deps, { accountId: 'acc-1', toAccountId: 'acc-1' });

    expect(callCount).toBe(1);
    expect(result._unsafeUnwrap()).toEqual([account({ id: 'acc-1' })]);
  });
});
