import { describe, expect, it, vi } from 'vitest';
import {
  createAccount,
  deleteAccount,
  getAccountBalances,
  updateAccount,
} from '../../../../src/controllers/account/account.js';
import type { Deps } from '../../../../src/controllers/deps.js';
import { PersistOp } from '@rfc0/effect-runner';
import { ACCOUNT_ENTITY_TAG, AccountType, type Account, type AccountEntity } from '../../../../src/models/account.js';
import { Remedy } from '../../../../src/models/remedy.js';
import type { CurrencyRateEntity } from '../../../../src/models/currency-rate.js';
import { CurrencyCode, type Currency } from '../../../../src/models/money.js';
import { Locale } from '../../../../src/models/locale.js';

const makeDeps = (overrides: Partial<Deps> = {}): Deps => ({
  accounts: { findByName: async () => null } as unknown as Deps['accounts'],
  bills: {} as Deps['bills'],
  budgets: {} as Deps['budgets'],
  categories: {} as Deps['categories'],
  subCategories: {} as Deps['subCategories'],
  correlations: {} as Deps['correlations'],
  creditCards: {} as Deps['creditCards'],
  currencies: {} as Deps['currencies'],
  currencyRates: {} as Deps['currencyRates'],
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
  rateStaleness: { fiatHours: 24, cryptoHours: 1 },
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

  it('a no-field update returns the account unchanged and writes nothing', async () => {
    const deps = makeDeps({ accounts: makeAccountsRepo() });

    const result = await updateAccount(deps, { name: 'Nubank' });

    expect(result.isOk()).toBe(true);
    const outcome = result._unsafeUnwrap();
    expect(outcome.persist).toEqual([]);
    expect(outcome.response).toMatchObject({ name: 'Nubank' });
  });

  it('rejects setting type to credit', async () => {
    const deps = makeDeps({ accounts: makeAccountsRepo() });

    const result = await updateAccount(deps, { name: 'Nubank', type: AccountType.enum.credit });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toMatchObject({ code: 'validation', remedy: Remedy.enum.create_credit_card });
  });

  it('rejects updating an existing credit account, pointing at the card update', async () => {
    const deps = makeDeps({
      accounts: makeAccountsRepo({ list: async () => [account({ type: AccountType.enum.credit })] }),
    });

    const result = await updateAccount(deps, { name: 'Nubank' });

    expect(result._unsafeUnwrapErr()).toMatchObject({ code: 'validation', remedy: Remedy.enum.update_credit_card });
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

describe('getAccountBalances — valuation (ADR-026 Phase 3, controller-orchestrated per ADR-028)', () => {
  const NOW = new Date('2026-08-10T12:00:00.000Z');
  const ZERO_PARTS = { income: 0, expenses: 0, transfersIn: 0, transfersOut: 0 };
  const CURRENCIES: Currency[] = [
    { code: CurrencyCode.enum.BRL, symbol: 'R$', name: 'Real', decimals: 2 },
    { code: CurrencyCode.enum.USD, symbol: '$', name: 'Dollar', decimals: 2 },
    { code: CurrencyCode.enum.USDC, symbol: 'USDC', name: 'USD Coin', decimals: 6 },
    { code: CurrencyCode.enum.BTC, symbol: '₿', name: 'Bitcoin', decimals: 8 },
  ];

  const usdRate = (overrides: Partial<CurrencyRateEntity> = {}): CurrencyRateEntity => ({
    id: 'rate-usd-brl',
    fromCode: CurrencyCode.enum.USD,
    toCode: CurrencyCode.enum.BRL,
    rate: 5,
    asOf: NOW.toISOString(),
    source: null,
    version: 0,
    ...overrides,
  });

  const balanceDeps = (opts: {
    accounts: Account[];
    rates?: CurrencyRateEntity[];
    baseCurrency?: CurrencyCode | null;
  }): Deps =>
    makeDeps({
      clock: () => NOW,
      accounts: {
        list: async () => opts.accounts,
        findByName: async (name: string) => opts.accounts.find((a) => a.name === name) ?? null,
        balanceParts: async () => ZERO_PARTS,
      } as unknown as Deps['accounts'],
      currencies: { list: async () => CURRENCIES } as Deps['currencies'],
      currencyRates: { list: async () => opts.rates ?? [] } as unknown as Deps['currencyRates'],
      settings: {
        getLocale: async () => ({
          id: 'singleton',
          locale: Locale.enum.en,
          localeSource: 'default',
          baseCurrency: opts.baseCurrency ?? null,
          version: 0,
        }),
      } as unknown as Deps['settings'],
    });

  it('base-currency account: identity conversion, included in the net total, no rate lookup needed', async () => {
    const usdAccount = account({
      id: 'acc-usd',
      name: 'USD Checking',
      currency: CurrencyCode.enum.USD,
      initialBalance: 100,
    });
    const deps = balanceDeps({ accounts: [usdAccount], baseCurrency: CurrencyCode.enum.USD });

    const result = await getAccountBalances(deps);

    expect(result.isOk()).toBe(true);
    const { balances, consolidatedNetWorth } = result._unsafeUnwrap();
    expect(balances[0]!.converted).toEqual({
      baseCurrency: CurrencyCode.enum.USD,
      value: 100,
      rate: 1,
      asOf: NOW.toISOString(),
      stale: false,
    });
    expect(consolidatedNetWorth).toEqual({ baseCurrency: CurrencyCode.enum.USD, total: 100, excluded: [] });
  });

  it('cross-currency account with a fresh rate: converts and rounds to the base currency decimals', async () => {
    const brlAccount = account({
      id: 'acc-brl',
      name: 'BRL Wallet',
      currency: CurrencyCode.enum.BRL,
      initialBalance: 100,
    });
    const deps = balanceDeps({
      accounts: [brlAccount],
      baseCurrency: CurrencyCode.enum.USD,
      rates: [usdRate({ fromCode: CurrencyCode.enum.BRL, toCode: CurrencyCode.enum.USD, rate: 0.2 })],
    });

    const result = await getAccountBalances(deps);

    expect(result.isOk()).toBe(true);
    const { balances, consolidatedNetWorth } = result._unsafeUnwrap();
    expect(balances[0]!.converted).toEqual({
      baseCurrency: CurrencyCode.enum.USD,
      value: 20,
      rate: 0.2,
      asOf: NOW.toISOString(),
      stale: false,
    });
    expect(consolidatedNetWorth.total).toBe(20);
  });

  it('a rate older than the class threshold is flagged stale, but still valued and included', async () => {
    const usdAccount = account({
      id: 'acc-usd',
      name: 'USD Checking',
      currency: CurrencyCode.enum.USD,
      initialBalance: 100,
    });
    const staleAsOf = new Date(NOW.getTime() - 25 * 60 * 60 * 1000).toISOString(); // > 24h fiat threshold
    const deps = balanceDeps({
      accounts: [usdAccount],
      baseCurrency: CurrencyCode.enum.BRL,
      rates: [usdRate({ asOf: staleAsOf })],
    });

    const result = await getAccountBalances(deps);

    const { balances, consolidatedNetWorth } = result._unsafeUnwrap();
    expect(balances[0]!.converted?.stale).toBe(true);
    expect(consolidatedNetWorth.excluded).toEqual([]);
  });

  it('a missing rate excludes the account from the net total, without dropping it from balances', async () => {
    const btcAccount = account({
      id: 'acc-btc',
      name: 'BTC Wallet',
      currency: CurrencyCode.enum.BTC,
      initialBalance: 1,
    });
    const usdAccount = account({
      id: 'acc-usd',
      name: 'USD Checking',
      currency: CurrencyCode.enum.USD,
      initialBalance: 100,
    });
    const deps = balanceDeps({
      accounts: [btcAccount, usdAccount],
      baseCurrency: CurrencyCode.enum.USD,
      rates: [],
    });

    const result = await getAccountBalances(deps);

    const { balances, consolidatedNetWorth } = result._unsafeUnwrap();
    expect(balances).toHaveLength(2);
    expect(balances.find((b) => b.id === 'acc-btc')!.converted).toBeUndefined();
    expect(consolidatedNetWorth).toEqual({ baseCurrency: CurrencyCode.enum.USD, total: 100, excluded: ['acc-btc'] });
  });

  it('sums multiple convertible balances into one net total', async () => {
    const usdAccount = account({
      id: 'acc-usd',
      name: 'USD Checking',
      currency: CurrencyCode.enum.USD,
      initialBalance: 100,
    });
    const brlAccount = account({
      id: 'acc-brl',
      name: 'BRL Wallet',
      currency: CurrencyCode.enum.BRL,
      initialBalance: 500,
    });
    const deps = balanceDeps({
      accounts: [usdAccount, brlAccount],
      baseCurrency: CurrencyCode.enum.USD,
      rates: [usdRate({ fromCode: CurrencyCode.enum.BRL, toCode: CurrencyCode.enum.USD, rate: 0.2 })],
    });

    const result = await getAccountBalances(deps);

    const { consolidatedNetWorth } = result._unsafeUnwrap();
    expect(consolidatedNetWorth).toEqual({ baseCurrency: CurrencyCode.enum.USD, total: 200, excluded: [] });
  });
});
