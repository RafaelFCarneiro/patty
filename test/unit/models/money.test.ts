import { describe, expect, it } from 'vitest';
import { CurrencyCode, CurrencySchema, Money } from '../../../src/models/money.js';

describe('CurrencyCode', () => {
  it('accepts fiat and crypto codes (ADR-026)', () => {
    expect(CurrencyCode.options).toEqual(['USD', 'BRL', 'USDC', 'BTC']);
  });

  it('rejects an unknown code', () => {
    expect(CurrencyCode.safeParse('EUR').success).toBe(false);
  });
});

describe('Money', () => {
  it('requires a positive number — native precision is not constrained here', () => {
    expect(Money.safeParse(0.00000001).success).toBe(true); // a satoshi
    expect(Money.safeParse(0).success).toBe(false);
    expect(Money.safeParse(-1).success).toBe(false);
  });
});

describe('CurrencySchema', () => {
  it('accepts a crypto currency with its own decimals', () => {
    const btc = CurrencySchema.parse({ code: 'BTC', symbol: '₿', name: 'Bitcoin', decimals: 8 });
    expect(btc).toEqual({ code: 'BTC', symbol: '₿', name: 'Bitcoin', decimals: 8 });
  });

  it('rejects a negative decimals value', () => {
    expect(CurrencySchema.safeParse({ code: 'BRL', symbol: 'R$', name: 'Real', decimals: -1 }).success).toBe(false);
  });

  it('rejects a currency code outside CurrencyCode', () => {
    expect(CurrencySchema.safeParse({ code: 'EUR', symbol: '€', name: 'Euro', decimals: 2 }).success).toBe(false);
  });
});
