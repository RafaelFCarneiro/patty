import { describe, expect, it } from 'vitest';
import { topMerchants } from '../../../src/controllers/merchants.js';
import type { Deps } from '../../../src/controllers/deps.js';
import { DEFAULT_TOP_MERCHANTS_LIMIT } from '../../../src/models/merchant.js';
import { Locale } from '../../../src/models/locale.js';
import type { MerchantTopDbRow } from '../../../src/wire/db/merchants.js';

const makeDeps = (overrides: Partial<Deps> = {}): Deps => ({
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
  clock: () => new Date('2026-06-01'),
  newId: () => 'id-1',
  locale: async () => Locale.enum.en,
  ...overrides,
});

const row = (overrides: Partial<MerchantTopDbRow> = {}): MerchantTopDbRow => ({
  merchant: 'uber',
  transactionCount: 5,
  categoryName: 'Transporte',
  categoryNames: null,
  ...overrides,
});

describe('topMerchants', () => {
  it('defaults to DEFAULT_TOP_MERCHANTS_LIMIT when no limit is given', async () => {
    let calledWith: number | undefined;
    const deps = makeDeps({
      merchants: {
        top: async (limit: number) => {
          calledWith = limit;
          return [];
        },
      } as unknown as Deps['merchants'],
    });

    await topMerchants(deps);

    expect(calledWith).toBe(DEFAULT_TOP_MERCHANTS_LIMIT);
  });

  it('shapes each repo row into a merchant/transactionCount/categoryName summary', async () => {
    const deps = makeDeps({
      merchants: { top: async () => [row()] } as unknown as Deps['merchants'],
    });

    const result = await topMerchants(deps);

    expect(result).toEqual([{ merchant: 'uber', transactionCount: 5, categoryName: 'Transporte' }]);
  });

  it('locale-resolves categoryName via the localized names map', async () => {
    const deps = makeDeps({
      locale: async () => Locale.enum.pt,
      merchants: {
        top: async () => [row({ categoryName: 'Transport', categoryNames: { pt: 'Transporte' } })],
      } as unknown as Deps['merchants'],
    });

    const result = await topMerchants(deps);

    expect(result[0]?.categoryName).toBe('Transporte');
  });

  it('resolves categoryName to null, not a locale label, for a merchant with no classified category', async () => {
    const deps = makeDeps({
      merchants: {
        top: async () => [row({ categoryName: null, categoryNames: null })],
      } as unknown as Deps['merchants'],
    });

    const result = await topMerchants(deps);

    expect(result[0]?.categoryName).toBeNull();
  });
});
