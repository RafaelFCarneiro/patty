import { describe, expect, it } from 'vitest';
import { type Currency, CurrencyCode } from '../../../src/models/money.js';
import { decimalsLookup, resolveCurrency, roundMoney, roundToDecimals } from '../../../src/logic/money.js';

describe('resolveCurrency', () => {
  const { BRL, USD } = CurrencyCode.enum;
  const source = (currency: typeof BRL | typeof USD) => ({ currency });

  it('prefers the funding source currency (account or card) over the input', () => {
    expect(resolveCurrency(source(USD), { currency: BRL })).toBe(USD);
  });

  it('falls back to explicit currency when no source is given', () => {
    expect(resolveCurrency(null, { currency: USD })).toBe(USD);
  });

  it('defaults to USD when nothing is provided', () => {
    expect(resolveCurrency(null, {})).toBe(USD);
  });
});

describe('roundToDecimals', () => {
  it('rounds to the given number of decimal places', () => {
    expect(roundToDecimals(1.005, 2)).toBe(1.01); // EPSILON-corrected float drift
    expect(roundToDecimals(0.123456785, 8)).toBe(0.12345679);
    expect(roundToDecimals(0.1 + 0.2, 1)).toBe(0.3);
  });

  it('never flattens a currency amount that needs more than 2 decimals', () => {
    // BTC's 8th decimal (a satoshi) must survive — this is exactly ADR-026's documented gotcha.
    expect(roundToDecimals(0.00000001, 8)).toBe(0.00000001);
    expect(roundToDecimals(0.00000001, 2)).toBe(0); // what a fiat-shaped rounder would wrongly do
  });
});

describe('roundMoney', () => {
  it('is roundToDecimals fixed at 2 places — fiat/ratio default', () => {
    expect(roundMoney(1.005)).toBe(1.01);
    expect(roundMoney(0.123456785)).toBe(0.12);
  });
});

describe('decimalsLookup', () => {
  const currency = (overrides: Partial<Currency>): Currency => ({
    code: CurrencyCode.enum.BRL,
    symbol: 'R$',
    name: 'Real',
    decimals: 2,
    ...overrides,
  });

  it("resolves each currency's own decimals from the reference list", () => {
    const lookup = decimalsLookup([
      currency({ code: CurrencyCode.enum.BRL, decimals: 2 }),
      currency({ code: CurrencyCode.enum.BTC, decimals: 8 }),
      currency({ code: CurrencyCode.enum.USDC, decimals: 6 }),
    ]);
    expect(lookup(CurrencyCode.enum.BRL)).toBe(2);
    expect(lookup(CurrencyCode.enum.BTC)).toBe(8);
    expect(lookup(CurrencyCode.enum.USDC)).toBe(6);
  });

  it('falls back to 2 decimals for a code missing from the list', () => {
    const lookup = decimalsLookup([]);
    expect(lookup(CurrencyCode.enum.BTC)).toBe(2);
  });
});
