import { describe, expect, it } from 'vitest';
import { CURRENCIES } from '../../../../../src/diplomat/db/seed/currencies.js';

describe('CURRENCIES seed', () => {
  it('seeds fiat with 2 decimals and crypto with their own precision (ADR-026)', () => {
    const byCode = Object.fromEntries(CURRENCIES.map((c) => [c.code, c]));
    expect(byCode.BRL).toMatchObject({ decimals: 2, symbol: 'R$' });
    expect(byCode.USD).toMatchObject({ decimals: 2, symbol: '$' });
    expect(byCode.USDC).toMatchObject({ decimals: 6 });
    expect(byCode.BTC).toMatchObject({ decimals: 8, symbol: '₿' });
  });

  it('every row has a non-empty symbol and name', () => {
    for (const c of CURRENCIES) {
      expect(c.symbol.length).toBeGreaterThan(0);
      expect(c.name.length).toBeGreaterThan(0);
    }
  });
});
