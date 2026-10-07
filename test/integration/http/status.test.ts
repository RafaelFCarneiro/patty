import { describe, expect, it } from 'vitest';
import { setupHttpTest } from './setup.js';

const { inject } = setupHttpTest();

describe('GET /api/health', () => {
  it('returns ok', async () => {
    const res = await inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', db: 'ok' });
  });
});

describe('GET /api/status', () => {
  it('returns version, db status, and locale', async () => {
    const res = await inject({ method: 'GET', url: '/api/status' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty('version');
    expect(body).toHaveProperty('db', 'ok');
    expect(body).toHaveProperty('locale');
  });
});
