import { describe, expect, it } from 'vitest';
import { setupHttpTest } from './setup.js';

const { inject } = setupHttpTest();

type RateView = { from: string; to: string; rate: number; asOf: string; source?: string };

describe('POST /api/exchange-rates', () => {
  it('upserts a new rate and returns the view', async () => {
    const res = await inject({
      method: 'POST',
      url: '/api/exchange-rates',
      payload: { from: 'USD', to: 'BRL', rate: 5.2, asOf: '2026-08-10T10:00:00.000Z', source: 'PTAX' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ from: 'USD', to: 'BRL', rate: 5.2, asOf: '2026-08-10T10:00:00.000Z', source: 'PTAX' });
  });

  it('upsert-latest: a second call for the same pair overwrites the rate, not a duplicate row', async () => {
    await inject({
      method: 'POST',
      url: '/api/exchange-rates',
      payload: { from: 'USD', to: 'USDC', rate: 1, asOf: '2026-08-10T08:00:00.000Z' },
    });
    const res = await inject({
      method: 'POST',
      url: '/api/exchange-rates',
      payload: { from: 'USD', to: 'USDC', rate: 1.001, asOf: '2026-08-10T09:00:00.000Z' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ rate: 1.001, asOf: '2026-08-10T09:00:00.000Z' });

    const list = (await inject({ method: 'GET', url: '/api/exchange-rates' })).json() as RateView[];
    expect(list.filter((r) => r.from === 'USD' && r.to === 'USDC')).toHaveLength(1);
  });

  it('rejects from === to with 422', async () => {
    const res = await inject({
      method: 'POST',
      url: '/api/exchange-rates',
      payload: { from: 'USD', to: 'USD', rate: 1, asOf: '2026-08-10T10:00:00.000Z' },
    });
    expect(res.statusCode).toBe(422);
  });

  it('rejects a malformed body with 422', async () => {
    const res = await inject({
      method: 'POST',
      url: '/api/exchange-rates',
      payload: { from: 'USD', to: 'BRL', rate: -1, asOf: '2026-08-10T10:00:00.000Z' },
    });
    expect(res.statusCode).toBe(422);
  });

  it('rejects a non-ISO-8601 asOf with 422 rather than persisting an unparseable timestamp', async () => {
    const res = await inject({
      method: 'POST',
      url: '/api/exchange-rates',
      payload: { from: 'USD', to: 'BTC', rate: 0.00002, asOf: 'unknown' },
    });
    expect(res.statusCode).toBe(422);
  });
});

describe('GET /api/exchange-rates', () => {
  it('lists every stored rate', async () => {
    await inject({
      method: 'POST',
      url: '/api/exchange-rates',
      payload: { from: 'BTC', to: 'USD', rate: 60000, asOf: '2026-08-10T10:00:00.000Z' },
    });
    const res = await inject({ method: 'GET', url: '/api/exchange-rates' });
    expect(res.statusCode).toBe(200);
    const rates = res.json() as RateView[];
    expect(rates.some((r) => r.from === 'BTC' && r.to === 'USD' && r.rate === 60000)).toBe(true);
  });
});

describe('POST /api/exchange-rates/bulk', () => {
  it('reports partial success: one bad pair does not block the others', async () => {
    const res = await inject({
      method: 'POST',
      url: '/api/exchange-rates/bulk',
      payload: {
        rates: [
          { from: 'USD', to: 'BRL', rate: 5.3, asOf: '2026-08-10T10:00:00.000Z' },
          { from: 'BTC', to: 'BTC', rate: 1, asOf: '2026-08-10T10:00:00.000Z' },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<{ status: string; from: string; to: string; error?: string }> };
    expect(body.items).toHaveLength(2);
    expect(body.items[0]).toMatchObject({ status: 'ok' });
    expect(body.items[1]).toMatchObject({ status: 'error', from: 'BTC', to: 'BTC' });
  });
});
