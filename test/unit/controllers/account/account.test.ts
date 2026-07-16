import { describe, expect, it, vi } from 'vitest';
import { createAccount, deleteAccount, updateAccount } from '../../../../src/controllers/account/account.js';
import type { Deps } from '../../../../src/controllers/deps.js';
import { PersistOp } from '../../../../src/models/persistable.js';
import { ACCOUNT_ENTITY_TAG, AccountType, type Account, type AccountEntity } from '../../../../src/models/account.js';
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
  it("returns an insert Persistable for the account — no version, that is the shell's to decide", async () => {
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
        op: PersistOp.enum.insert,
        entity: ACCOUNT_ENTITY_TAG,
        model: {
          id: 'account-id-1',
          name: 'Nubank',
          type: AccountType.enum.checking,
          currency: CurrencyCode.enum.BRL,
          initialBalance: 100,
        },
      },
    ]);
    expect(outcome.persist[0]).not.toHaveProperty('model.version');
  });

  it('the response is the same plain Account the persist batch already carries', async () => {
    const deps = makeDeps();

    const result = await createAccount(deps, {
      name: 'Nubank',
      type: AccountType.enum.checking,
      currency: CurrencyCode.enum.BRL,
      initialBalance: 100,
    });

    expect(result.isOk()).toBe(true);
    const outcome = result._unsafeUnwrap();
    expect(outcome.response).toEqual({
      id: 'account-id-1',
      name: 'Nubank',
      type: AccountType.enum.checking,
      currency: CurrencyCode.enum.BRL,
      initialBalance: 100,
    });
    expect(outcome.response).not.toHaveProperty('version');
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

const accountEntity = (overrides: Partial<AccountEntity> = {}): AccountEntity => ({
  ...account(),
  version: 2,
  ...overrides,
});

const makeAccountsRepo = (overrides: Partial<Deps['accounts']> = {}): Deps['accounts'] =>
  ({
    list: async () => [account()],
    findByName: async () => null,
    countReferences: async () => ({ transactions: 0, recurring: 0, cards: 0 }),
    findRawById: async () => accountEntity(),
    ...overrides,
  }) as unknown as Deps['accounts'];

describe('deleteAccount — functional core (ADR-021 phase 3a)', () => {
  it('returns a version-guarded remove Persistable for an unreferenced account', async () => {
    const deps = makeDeps({ accounts: makeAccountsRepo() });

    const result = await deleteAccount(deps, 'Nubank');

    expect(result.isOk()).toBe(true);
    const outcome = result._unsafeUnwrap();
    expect(outcome.persist).toEqual([
      { op: PersistOp.enum.delete, entity: ACCOUNT_ENTITY_TAG, id: 'acc-existing', version: 2 },
    ]);
    expect(outcome.response).toEqual({ deleted: true });
  });

  it('rejects a credit account without reading a raw version', async () => {
    const findRawById = vi.fn();
    const deps = makeDeps({
      accounts: makeAccountsRepo({
        list: async () => [account({ type: AccountType.enum.credit })],
        findRawById,
      }),
    });

    const result = await deleteAccount(deps, 'Nubank');

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('validation');
    expect(findRawById).not.toHaveBeenCalled();
  });

  it('rejects when the account is still referenced (in_use), building no Persistable', async () => {
    const deps = makeDeps({
      accounts: makeAccountsRepo({ countReferences: async () => ({ transactions: 2, recurring: 0, cards: 0 }) }),
    });

    const result = await deleteAccount(deps, 'Nubank');

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual({
      code: 'in_use',
      entity: 'account',
      name: 'Nubank',
      references: { transactions: 2, recurring: 0, cards: 0 },
    });
  });
});

describe('updateAccount — functional core (ADR-021 phase 3a)', () => {
  it('returns a version-guarded update Persistable merging only the changed fields', async () => {
    const deps = makeDeps({ accounts: makeAccountsRepo() });

    const result = await updateAccount(deps, { name: 'Nubank', newName: 'Nubank Ultravioleta', initialBalance: 500 });

    expect(result.isOk()).toBe(true);
    const outcome = result._unsafeUnwrap();
    expect(outcome.persist).toEqual([
      {
        op: PersistOp.enum.update,
        entity: ACCOUNT_ENTITY_TAG,
        model: { ...accountEntity(), name: 'Nubank Ultravioleta', initialBalance: 500 },
      },
    ]);
  });

  it('the response omits version and carries a localized typeLabel', async () => {
    const deps = makeDeps({ accounts: makeAccountsRepo() });

    const result = await updateAccount(deps, { name: 'Nubank', newName: 'Renamed' });

    expect(result.isOk()).toBe(true);
    const outcome = result._unsafeUnwrap();
    expect(outcome.response).not.toHaveProperty('version');
    expect(outcome.response).toMatchObject({ name: 'Renamed', typeLabel: 'Checking' });
  });

  it('a no-field update returns the account unchanged', async () => {
    const deps = makeDeps({ accounts: makeAccountsRepo() });

    const result = await updateAccount(deps, { name: 'Nubank' });

    expect(result.isOk()).toBe(true);
    const outcome = result._unsafeUnwrap();
    expect(outcome.persist).toEqual([
      { op: PersistOp.enum.update, entity: ACCOUNT_ENTITY_TAG, model: accountEntity() },
    ]);
  });

  it('rejects setting type to credit', async () => {
    const deps = makeDeps({ accounts: makeAccountsRepo() });

    const result = await updateAccount(deps, { name: 'Nubank', type: AccountType.enum.credit });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('rejects a type change when transactions exist, before reading a raw version', async () => {
    const findRawById = vi.fn();
    const deps = makeDeps({
      accounts: makeAccountsRepo({
        countReferences: async () => ({ transactions: 1, recurring: 0, cards: 0 }),
        findRawById,
      }),
    });

    const result = await updateAccount(deps, { name: 'Nubank', type: AccountType.enum.savings });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual({
      code: 'validation',
      issues: ['type cannot be changed — account has 1 transaction(s)'],
    });
    expect(findRawById).not.toHaveBeenCalled();
  });

  it('rejects renaming to an already-taken name', async () => {
    const deps = makeDeps({
      accounts: makeAccountsRepo({ findByName: async () => account({ id: 'acc-other', name: 'Taken' }) }),
    });

    const result = await updateAccount(deps, { name: 'Nubank', newName: 'Taken' });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual({ code: 'duplicate_name', entity: 'account', name: 'Taken' });
  });
});
