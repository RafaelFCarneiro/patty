import { describe, expect, it } from 'vitest';
import { listCurrencies } from '../../../src/controllers/currencies.js';
import type { Deps } from '../../../src/controllers/deps.js';
import { Locale } from '../../../src/models/locale.js';
import type { Currency } from '../../../src/models/money.js';

const makeDeps = (overrides: Partial<Deps> = {}): Deps => ({
  accounts: {} as Deps['accounts'],
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
  newId: () => 'id-1',
  locale: async () => Locale.enum.en,
  rateStaleness: { fiatHours: 24, cryptoHours: 1 },
  ...overrides,
});

describe('listCurrencies', () => {
  it('delegates to the currencies repo', async () => {
    const currencies: Currency[] = [{ code: 'BTC', symbol: '₿', name: 'Bitcoin', decimals: 8 }];
    const deps = makeDeps({ currencies: { list: async () => currencies } as unknown as Deps['currencies'] });
    expect(await listCurrencies(deps)).toBe(currencies);
  });
});
