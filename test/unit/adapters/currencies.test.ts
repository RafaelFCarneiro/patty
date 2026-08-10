import { describe, expect, it } from 'vitest';
import * as currencyAdapters from '../../../src/adapters/currencies.js';

describe('dbToModel', () => {
  it('maps a db row to a Currency model', () => {
    expect(currencyAdapters.dbToModel({ code: 'BTC', symbol: '₿', name: 'Bitcoin', decimals: 8 })).toEqual({
      code: 'BTC',
      symbol: '₿',
      name: 'Bitcoin',
      decimals: 8,
    });
  });

  it('throws on an unknown currency code', () => {
    expect(() =>
      currencyAdapters.dbToModel({ code: 'EUR', symbol: '€', name: 'Euro', decimals: 2 }),
    ).toThrow();
  });
});
