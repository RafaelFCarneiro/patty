import { describe, expect, it } from 'vitest';
import { setupHttpTest } from './setup.js';

const { inject } = setupHttpTest();

describe('GET /api/preferences', () => {
  it('derives base currency from the default locale (en -> USD) on a fresh DB', async () => {
    const res = await inject({ method: 'GET', url: '/api/preferences' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ locale: 'en', localeSource: 'default', baseCurrency: 'USD' });
  });
});

describe('POST /api/settings/base-currency', () => {
  it('sets an explicit override, reflected by GET /api/preferences', async () => {
    const res = await inject({
      method: 'POST',
      url: '/api/settings/base-currency',
      payload: { baseCurrency: 'BTC' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ baseCurrency: 'BTC' });

    const prefs = await inject({ method: 'GET', url: '/api/preferences' });
    expect(prefs.json()).toMatchObject({ baseCurrency: 'BTC' });
  });

  it('rejects an invalid currency code with 422', async () => {
    const res = await inject({
      method: 'POST',
      url: '/api/settings/base-currency',
      payload: { baseCurrency: 'NOT_A_CURRENCY' },
    });
    expect(res.statusCode).toBe(422);
  });
});
