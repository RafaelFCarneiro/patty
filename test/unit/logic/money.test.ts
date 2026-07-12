import { describe, expect, it } from 'vitest';
import { CurrencyCode } from '../../../src/models/money.js';
import { resolveCurrency } from '../../../src/logic/money.js';

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
