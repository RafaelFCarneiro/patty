import { describe, expect, it, vi } from 'vitest';
import { createAccount } from '../../../../src/controllers/account/account.js';
import type { Deps } from '../../../../src/controllers/deps.js';
import { EntityTag } from '../../../../src/models/persistable.js';
import { AccountType, type Account } from '../../../../src/models/account.js';
import { CurrencyCode } from '../../../../src/models/money.js';
import { Locale } from '../../../../src/models/locale.js';

const makeDeps = (overrides: Partial<Deps> = {}): Deps => ({
  accounts: { findByName: async () => null } as unknown as Deps['accounts'],
  bills: {} as Deps['bills'],
  categories: {} as Deps['categories'],
  subCategories: {} as Deps['subCategories'],
  creditCards: {} as Deps['creditCards'],
  dashboards: {} as Deps['dashboards'],
  health: {} as Deps['health'],
  merchants: {} as Deps['merchants'],
  recurring: {} as Deps['recurring'],
  settings: {} as Deps['settings'],
  tags: {} as Deps['tags'],
  transactions: {} as Deps['transactions'],
  clock: () => new Date('2026-06-01'),
  newId: () => 'account-id-1',
  locale: async () => Locale.enum.en,
  resetLocale: vi.fn(),
  ...overrides,
});

const account = (overrides: Partial<Account> = {}): Account => ({
  id: 'acc-existing',
  name: 'Nubank',
  type: AccountType.enum.checking,
  currency: CurrencyCode.enum.BRL,
  initialBalance: 0,
  ...overrides,
});

describe('createAccount — functional core (ADR-021 phase 1)', () => {
  it('returns an insert Persistable for the account, versioned at 0, instead of writing', async () => {
    const deps = makeDeps();

    const result = await createAccount(deps, {
      name: 'Nubank',
      type: AccountType.enum.checking,
      currency: CurrencyCode.enum.BRL,
      initialBalance: 100,
    });

    expect(result.isOk()).toBe(true);
    const outcome = result._unsafeUnwrap();

    expect(outcome.persist).toEqual([
      {
        op: 'insert',
        entity: EntityTag.enum.account,
        model: {
          id: 'account-id-1',
          version: 0,
          name: 'Nubank',
          type: AccountType.enum.checking,
          currency: CurrencyCode.enum.BRL,
          initialBalance: 100,
        },
      },
    ]);
  });

  it('strips `version` from the response — the wire-shaped Account only', async () => {
    const deps = makeDeps();

    const result = await createAccount(deps, {
      name: 'Nubank',
      type: AccountType.enum.checking,
      currency: CurrencyCode.enum.BRL,
      initialBalance: 100,
    });

    const { response } = result._unsafeUnwrap();
    expect(response).toEqual({
      id: 'account-id-1',
      name: 'Nubank',
      type: AccountType.enum.checking,
      currency: CurrencyCode.enum.BRL,
      initialBalance: 100,
    });
    expect(response).not.toHaveProperty('version');
  });

  it('rejects a credit-type account without touching persist/newId', async () => {
    const deps = makeDeps();

    const result = await createAccount(deps, {
      name: 'Card account',
      type: AccountType.enum.credit,
      currency: CurrencyCode.enum.BRL,
      initialBalance: 0,
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('rejects a duplicate account name before building any Persistable', async () => {
    const deps = makeDeps({
      accounts: { findByName: async () => account() } as unknown as Deps['accounts'],
    });

    const result = await createAccount(deps, {
      name: 'Nubank',
      type: AccountType.enum.checking,
      currency: CurrencyCode.enum.BRL,
      initialBalance: 0,
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual({ code: 'duplicate_name', entity: 'account', name: 'Nubank' });
  });
});
