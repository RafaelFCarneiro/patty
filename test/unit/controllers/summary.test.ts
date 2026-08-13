import { describe, expect, it } from 'vitest';
import { getSpendingSummary } from '../../../src/controllers/summary.js';
import type { Deps } from '../../../src/controllers/deps.js';
import type { CurrencyRateEntity } from '../../../src/models/currencyRate.js';
import { CurrencyCode, type Currency } from '../../../src/models/money.js';
import { Locale } from '../../../src/models/locale.js';
import type { SummaryRow } from '../../../src/models/summary.js';

const { BRL, USD, BTC } = CurrencyCode.enum;
const NOW = new Date('2026-08-10T12:00:00.000Z');
const PERIOD = { month: 8, year: 2026 };

const CURRENCIES: Currency[] = [
  { code: BRL, symbol: 'R$', name: 'Real', decimals: 2 },
  { code: USD, symbol: '$', name: 'Dollar', decimals: 2 },
  { code: BTC, symbol: '₿', name: 'Bitcoin', decimals: 8 },
];

const row = (overrides: Partial<SummaryRow> = {}): SummaryRow => ({
  currency: USD,
  type: 'expense',
  category: null,
  categoryNames: null,
  total: 0,
  count: 1,
  ...overrides,
});

const rate = (overrides: Partial<CurrencyRateEntity> = {}): CurrencyRateEntity => ({
  id: 'rate-1',
  fromCode: BRL,
  toCode: USD,
  rate: 0.2,
  asOf: NOW.toISOString(),
  source: null,
  version: 0,
  ...overrides,
});

const makeDeps = (opts: { rows?: SummaryRow[]; rates?: CurrencyRateEntity[] } = {}): Deps =>
  ({
    accounts: {} as Deps['accounts'],
    bills: {} as Deps['bills'],
    budgets: {} as Deps['budgets'],
    categories: {} as Deps['categories'],
    subCategories: {} as Deps['subCategories'],
    correlations: {} as Deps['correlations'],
    creditCards: {} as Deps['creditCards'],
    currencies: { list: async () => CURRENCIES } as Deps['currencies'],
    currencyRates: { list: async () => opts.rates ?? [] } as unknown as Deps['currencyRates'],
    dashboards: {} as Deps['dashboards'],
    health: {} as Deps['health'],
    merchants: {} as Deps['merchants'],
    recurring: {} as Deps['recurring'],
    settings: {} as Deps['settings'],
    tags: {} as Deps['tags'],
    transactions: {
      summaryRows: async () => opts.rows ?? [],
    } as unknown as Deps['transactions'],
    clock: () => NOW,
    newId: () => 'id-1',
    locale: async () => Locale.enum.en,
    rateStaleness: { fiatHours: 24, cryptoHours: 1 },
  }) as Deps;

describe('getSpendingSummary — displayCurrency', () => {
  it('omitting displayCurrency returns a response with no converted block (regression pin)', async () => {
    const deps = makeDeps({ rows: [row({ currency: USD, total: 100 })] });

    const result = await getSpendingSummary(deps, PERIOD);

    expect(result).toEqual({
      period: PERIOD,
      currencies: [{ currency: USD, income: 0, expenses: 100, balance: -100, byCategory: expect.any(Array) }],
    });
    expect(result).not.toHaveProperty('converted');
  });

  it('displayCurrency provided: converts and sums expenses into the top-level converted block', async () => {
    const deps = makeDeps({
      rows: [row({ currency: USD, total: 100 }), row({ currency: BRL, total: 500 })],
      rates: [rate({ fromCode: BRL, toCode: USD, rate: 0.2 })],
    });

    const result = await getSpendingSummary(deps, PERIOD, USD);

    // USD identity 100 + BRL 500 * 0.2 = 100 → 200
    expect(result.converted).toEqual({
      displayCurrency: USD,
      total: 200,
      stale: false,
      asOf: NOW.toISOString(),
      excluded: [],
    });
  });

  it('displayCurrency provided leaves per-currency lines unchanged', async () => {
    const deps = makeDeps({
      rows: [row({ currency: USD, total: 100 })],
    });

    const omitted = await getSpendingSummary(deps, PERIOD);
    const provided = await getSpendingSummary(deps, PERIOD, USD);

    expect(provided.currencies).toEqual(omitted.currencies);
  });

  it('a currency with no rate to displayCurrency is excluded from the total and listed', async () => {
    const deps = makeDeps({
      rows: [row({ currency: USD, total: 100 }), row({ currency: BTC, total: 1 })],
    });

    const result = await getSpendingSummary(deps, PERIOD, USD);

    expect(result.converted).toEqual({
      displayCurrency: USD,
      total: 100,
      stale: false,
      asOf: NOW.toISOString(),
      excluded: [{ currency: BTC, reason: 'no_rate' }],
    });
  });

  it('an income-only currency (zero expenses, no rate on file) is not excluded and does not flip stale', async () => {
    const deps = makeDeps({
      rows: [row({ currency: USD, total: 100 }), row({ currency: BTC, type: 'income', total: 5 })],
    });

    const result = await getSpendingSummary(deps, PERIOD, USD);

    expect(result.converted).toEqual({
      displayCurrency: USD,
      total: 100,
      stale: false,
      asOf: NOW.toISOString(),
      excluded: [],
    });
  });

  it('rebuilds period from its declared fields — both diplomat callers pass their whole args object, ' +
    'which also carries displayCurrency', async () => {
    const deps = makeDeps({ rows: [row({ currency: USD, total: 100 })] });
    const periodWithExtraField = { ...PERIOD, displayCurrency: USD } as unknown as typeof PERIOD;

    const result = await getSpendingSummary(deps, periodWithExtraField, USD);

    expect(result.period).toEqual(PERIOD);
    expect(result.period).not.toHaveProperty('displayCurrency');
  });
});
