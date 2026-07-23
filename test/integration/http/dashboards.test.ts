import { describe, expect, it } from 'vitest';
import { DASHBOARD_HTML_MAX_LENGTH } from '../../../src/models/dashboard.js';
import { setupHttpTest } from './setup.js';

const { inject } = setupHttpTest();

describe('GET /ui/:name', () => {
  it('serves the seeded baseline dashboard template on a fresh DB', async () => {
    const res = await inject({ method: 'GET', url: '/ui/overview' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.headers['cache-control']).toContain('no-cache');
    expect(res.body).toContain('FinTrack');
  });

  it('returns the exact stored HTML after save_dashboard, and reflects an override on next GET', async () => {
    await inject({
      method: 'POST',
      url: '/api/dashboards',
      payload: { name: 'ui-test', html: '<html><body>first</body></html>' },
    });
    const first = await inject({ method: 'GET', url: '/ui/ui-test' });
    expect(first.statusCode).toBe(200);
    expect(first.body).toBe('<html><body>first</body></html>');

    await inject({
      method: 'POST',
      url: '/api/dashboards',
      payload: { name: 'ui-test', html: '<html><body>second</body></html>' },
    });
    const second = await inject({ method: 'GET', url: '/ui/ui-test' });
    expect(second.body).toBe('<html><body>second</body></html>');
  });

  it('404s for an unknown dashboard', async () => {
    const res = await inject({ method: 'GET', url: '/ui/does-not-exist' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toHaveProperty('error.code', 'unknown_dashboard');
  });
});

describe('POST /api/dashboards', () => {
  it('upserts and returns the dashboard', async () => {
    const res = await inject({
      method: 'POST',
      url: '/api/dashboards',
      payload: { name: 'save-test', html: '<html></html>' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: 'save-test', html: '<html></html>' });
    expect(res.json()).toHaveProperty('updatedAt');
  });

  it('rejects an empty name (422)', async () => {
    const res = await inject({ method: 'POST', url: '/api/dashboards', payload: { name: '', html: '<html></html>' } });
    expect(res.statusCode).toBe(422);
  });

  it('rejects html with no <html> root (422) and does not save it', async () => {
    const res = await inject({
      method: 'POST',
      url: '/api/dashboards',
      payload: { name: 'unrenderable-root', html: 'not html at all' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toHaveProperty('error.code', 'validation');

    const stored = await inject({ method: 'GET', url: '/api/dashboards/unrenderable-root' });
    expect(stored.statusCode).toBe(404);
  });

  it('rejects html with a broken inline <script> (422) and does not save it', async () => {
    const html = '<!doctype html><html><body><script>function( { broken</script></body></html>';
    const res = await inject({
      method: 'POST',
      url: '/api/dashboards',
      payload: { name: 'unrenderable-script', html },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.issues.some((issue: string) => issue.includes('syntax error'))).toBe(true);

    const stored = await inject({ method: 'GET', url: '/api/dashboards/unrenderable-script' });
    expect(stored.statusCode).toBe(404);
  });

  it('rejects html over the max length (422) and does not save it', async () => {
    const res = await inject({
      method: 'POST',
      url: '/api/dashboards',
      payload: { name: 'too-large', html: 'x'.repeat(DASHBOARD_HTML_MAX_LENGTH + 1) },
    });
    expect(res.statusCode).toBe(422);

    const stored = await inject({ method: 'GET', url: '/api/dashboards/too-large' });
    expect(stored.statusCode).toBe(404);
  });
});

describe('GET /api/dashboards', () => {
  it('lists dashboards without the html blob, including the seeded placeholder', async () => {
    const res = await inject({ method: 'GET', url: '/api/dashboards' });
    expect(res.statusCode).toBe(200);
    const list = res.json() as Array<Record<string, unknown>>;
    expect(list.some((d) => d.name === 'overview')).toBe(true);
    for (const item of list) {
      expect(item).not.toHaveProperty('html');
      expect(item).toHaveProperty('updatedAt');
    }
  });
});

describe('GET /api/dashboards/:name', () => {
  it('returns the dashboard as JSON', async () => {
    await inject({ method: 'POST', url: '/api/dashboards', payload: { name: 'json-test', html: '<html></html>' } });
    const res = await inject({ method: 'GET', url: '/api/dashboards/json-test' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: 'json-test', html: '<html></html>' });
  });

  it('404s for an unknown dashboard', async () => {
    const res = await inject({ method: 'GET', url: '/api/dashboards/does-not-exist' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toHaveProperty('error.code', 'unknown_dashboard');
  });
});

describe('DELETE /api/dashboards/:name', () => {
  it('deletes a dashboard, and /ui/:name 404s afterward', async () => {
    await inject({ method: 'POST', url: '/api/dashboards', payload: { name: 'del-test', html: '<html></html>' } });
    const res = await inject({ method: 'DELETE', url: '/api/dashboards/del-test' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('deleted', true);

    const ui = await inject({ method: 'GET', url: '/ui/del-test' });
    expect(ui.statusCode).toBe(404);
  });

  it('returns deleted:false for an unknown name', async () => {
    const res = await inject({ method: 'DELETE', url: '/api/dashboards/does-not-exist' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('deleted', false);
  });
});
