import { describe, expect, it } from 'vitest';
import { setupHttpTest } from './setup.js';

const { inject } = setupHttpTest();

describe('GET /api/currencies', () => {
  it('lists the seeded currencies with symbol and decimals (ADR-026)', async () => {
    const res = await inject({ method: 'GET', url: '/api/currencies' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{ code: string; symbol: string; name: string; decimals: number }>;
    const byCode = Object.fromEntries(body.map((c) => [c.code, c]));
    expect(byCode.BRL).toMatchObject({ decimals: 2 });
    expect(byCode.USD).toMatchObject({ decimals: 2 });
    expect(byCode.MXN).toMatchObject({ decimals: 2, symbol: 'MX$', name: 'Peso Mexicano' });
    expect(byCode.COP).toMatchObject({ decimals: 2, symbol: 'COL$', name: 'Peso Colombiano' });
    expect(byCode.USDC).toMatchObject({ decimals: 6 });
    expect(byCode.BTC).toMatchObject({ decimals: 8, symbol: '₿' });
  });
});
