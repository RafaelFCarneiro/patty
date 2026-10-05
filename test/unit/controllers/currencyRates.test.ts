import { describe, expect, it } from 'vitest';
import { listExchangeRates, setExchangeRate } from '../../../src/controllers/currencyRates.js';
import type { Deps } from '../../../src/controllers/deps.js';
import { CURRENCY_RATE_ENTITY_TAG, type CurrencyRateEntity } from '../../../src/models/currencyRate.js';
import { CurrencyCode } from '../../../src/models/money.js';
import { PersistOp } from '@rafaelfcarneiro/effect-runner';

const { USD, BRL } = CurrencyCode.enum;

const makeDeps = (overrides?: Partial<Deps['currencyRates']>): Deps => ({
  currencyRates: {
    findByPair: async () => null,
    list: async () => [],
    ...overrides,
  },
  accounts: {} as Deps['accounts'],
  bills: {} as Deps['bills'],
  budgets: {} as Deps['budgets'],
  categories: {} as Deps['categories'],
  subCategories: {} as Deps['subCategories'],
  correlations: {} as Deps['correlations'],
  creditCards: {} as Deps['creditCards'],
  currencies: {} as Deps['currencies'],
  dashboards: {} as Deps['dashboards'],
  health: {} as Deps['health'],
  merchants: {} as Deps['merchants'],
  recurring: {} as Deps['recurring'],
  settings: {} as Deps['settings'],
  tags: {} as Deps['tags'],
  transactions: {} as Deps['transactions'],
  clock: () => new Date('2026-08-10T12:00:00.000Z'),
  newId: () => 'rate-new',
  locale: async () => 'en',
  rateStaleness: { fiatHours: 24, cryptoHours: 1 },
});

const existingRate = (overrides: Partial<CurrencyRateEntity> = {}): CurrencyRateEntity => ({
  id: 'rate-existing',
  fromCode: USD,
  toCode: BRL,
  rate: 5,
  asOf: '2026-08-09T00:00:00.000Z',
  source: null,
  version: 2,
  ...overrides,
});

describe('setExchangeRate', () => {
  it('rejects from === to without touching the repo', async () => {
    const result = await setExchangeRate(makeDeps(), { from: USD, to: USD, rate: 1, asOf: '2026-08-10T00:00:00.000Z' });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toMatchObject({ code: 'validation' });
  });

  it('emits an insert with a fresh id when no rate exists for the pair yet', async () => {
    const deps = makeDeps({ findByPair: async () => null });
    const result = await setExchangeRate(deps, {
      from: USD,
      to: BRL,
      rate: 5.25,
      asOf: '2026-08-10T10:00:00.000Z',
      source: 'PTAX',
    });
    const outcome = result._unsafeUnwrap();
    expect(outcome.response).toEqual({
      from: USD,
      to: BRL,
      rate: 5.25,
      asOf: '2026-08-10T10:00:00.000Z',
      source: 'PTAX',
    });
    expect(outcome.persist).toEqual([
      {
        op: PersistOp.enum.insert,
        entity: CURRENCY_RATE_ENTITY_TAG,
        model: {
          id: 'rate-new',
          fromCode: USD,
          toCode: BRL,
          rate: 5.25,
          asOf: '2026-08-10T10:00:00.000Z',
          source: 'PTAX',
        },
      },
    ]);
  });

  it('omits source from the response when not supplied', async () => {
    const deps = makeDeps({ findByPair: async () => null });
    const result = await setExchangeRate(deps, { from: USD, to: BRL, rate: 5, asOf: '2026-08-10T10:00:00.000Z' });
    expect(result._unsafeUnwrap().response).toEqual({ from: USD, to: BRL, rate: 5, asOf: '2026-08-10T10:00:00.000Z' });
  });

  it('emits a version-guarded update reusing the existing id when a rate already exists (upsert-latest)', async () => {
    const deps = makeDeps({ findByPair: async () => existingRate() });
    const result = await setExchangeRate(deps, { from: USD, to: BRL, rate: 5.5, asOf: '2026-08-10T11:00:00.000Z' });
    const outcome = result._unsafeUnwrap();
    expect(outcome.response).toEqual({ from: USD, to: BRL, rate: 5.5, asOf: '2026-08-10T11:00:00.000Z' });
    expect(outcome.persist).toEqual([
      {
        op: PersistOp.enum.update,
        entity: CURRENCY_RATE_ENTITY_TAG,
        model: {
          id: 'rate-existing',
          fromCode: USD,
          toCode: BRL,
          rate: 5.5,
          asOf: '2026-08-10T11:00:00.000Z',
          source: null,
          version: 2,
        },
      },
    ]);
  });
});

describe('listExchangeRates', () => {
  it('maps stored entities to the from/to view shape', async () => {
    const deps = makeDeps({ list: async () => [existingRate({ source: 'PTAX' })] });
    const rates = await listExchangeRates(deps);
    expect(rates).toEqual([{ from: USD, to: BRL, rate: 5, asOf: '2026-08-09T00:00:00.000Z', source: 'PTAX' }]);
  });

  it('returns an empty array when no rates are stored', async () => {
    const rates = await listExchangeRates(makeDeps());
    expect(rates).toEqual([]);
  });
});
