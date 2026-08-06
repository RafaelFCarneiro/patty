import { describe, expect, it } from 'vitest';
import { DASHBOARD_HTML_MAX_LENGTH } from '../../../src/models/dashboard.js';
import { setupHttpTest } from './setup.js';

const { inject } = setupHttpTest();

describe('POST /api/dashboards', () => {
  it('upserts and returns the dashboard', async () => {
    const res = await inject({
      method: 'POST',
      url: '/api/dashboards',
      payload: { name: 'save-test', html: '<section></section>' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: 'save-test', html: '<section></section>' });
    expect(res.json()).toHaveProperty('updatedAt');
  });

  it('rejects an empty name (422)', async () => {
    const res = await inject({
      method: 'POST',
      url: '/api/dashboards',
      payload: { name: '', html: '<section></section>' },
    });
    expect(res.statusCode).toBe(422);
  });

  it('rejects html carrying a full document root (422) and does not save it', async () => {
    const res = await inject({
      method: 'POST',
      url: '/api/dashboards',
      payload: { name: 'unrenderable-root', html: '<!doctype html><html><body>full page</body></html>' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toHaveProperty('error.code', 'validation');

    const stored = await inject({ method: 'GET', url: '/api/dashboards/unrenderable-root' });
    expect(stored.statusCode).toBe(404);
  });

  it('rejects empty content (422) and does not save it', async () => {
    const res = await inject({
      method: 'POST',
      url: '/api/dashboards',
      payload: { name: 'unrenderable-empty', html: '   ' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toHaveProperty('error.code', 'validation');

    const stored = await inject({ method: 'GET', url: '/api/dashboards/unrenderable-empty' });
    expect(stored.statusCode).toBe(404);
  });

  it('rejects an external <script src> reference (422) and does not save it', async () => {
    const html = '<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js"></script>';
    const res = await inject({
      method: 'POST',
      url: '/api/dashboards',
      payload: { name: 'unrenderable-external-script', html },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.issues.some((issue: string) => issue.includes('no external <script src>'))).toBe(true);

    const stored = await inject({ method: 'GET', url: '/api/dashboards/unrenderable-external-script' });
    expect(stored.statusCode).toBe(404);
  });

  it('rejects html with a broken inline <script> (422) and does not save it', async () => {
    const html = '<section><script>function( { broken</script></section>';
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
      expect(item).toHaveProperty('source');
    }
  });

  it('carries source: file for the seeded default, so the shell can group it apart from customs', async () => {
    const res = await inject({ method: 'GET', url: '/api/dashboards' });
    const list = res.json() as Array<Record<string, unknown>>;
    expect(list.find((d) => d.name === 'overview')).toMatchObject({ source: 'file' });
  });
});

describe('save_dashboard detaches a file-backed default into a custom, inline row (ADR-027 Phase 2)', () => {
  it('saving over "overview" flips source to inline and the new content is served', async () => {
    const overriddenHtml = '<section>my custom overview</section>';
    const res = await inject({
      method: 'POST',
      url: '/api/dashboards',
      payload: { name: 'overview', html: overriddenHtml },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: 'overview', html: overriddenHtml, source: 'inline' });

    const stored = await inject({ method: 'GET', url: '/api/dashboards/overview' });
    expect(stored.json()).toMatchObject({ html: overriddenHtml, source: 'inline' });

    const list = (await inject({ method: 'GET', url: '/api/dashboards' })).json() as Array<Record<string, unknown>>;
    expect(list.find((d) => d.name === 'overview')).toMatchObject({ source: 'inline' });
  });
});

describe('GET /api/dashboards/:name', () => {
  it('returns the dashboard fragment as JSON', async () => {
    await inject({
      method: 'POST',
      url: '/api/dashboards',
      payload: { name: 'json-test', html: '<section></section>' },
    });
    const res = await inject({ method: 'GET', url: '/api/dashboards/json-test' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: 'json-test', html: '<section></section>' });
  });

  it('404s for an unknown dashboard', async () => {
    const res = await inject({ method: 'GET', url: '/api/dashboards/does-not-exist' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toHaveProperty('error.code', 'unknown_dashboard');
  });

  it('sets cache-control: no-cache — file-backed content can change on disk between requests', async () => {
    await inject({
      method: 'POST',
      url: '/api/dashboards',
      payload: { name: 'cache-control-test', html: '<section></section>' },
    });
    const res = await inject({ method: 'GET', url: '/api/dashboards/cache-control-test' });
    expect(res.headers['cache-control']).toContain('no-cache');
  });
});

describe('DELETE /api/dashboards/:name', () => {
  it('deletes a dashboard, and GET /api/dashboards/:name 404s afterward', async () => {
    await inject({
      method: 'POST',
      url: '/api/dashboards',
      payload: { name: 'del-test', html: '<section></section>' },
    });
    const res = await inject({ method: 'DELETE', url: '/api/dashboards/del-test' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('deleted', true);

    const stored = await inject({ method: 'GET', url: '/api/dashboards/del-test' });
    expect(stored.statusCode).toBe(404);
  });

  it('returns deleted:false for an unknown name', async () => {
    const res = await inject({ method: 'DELETE', url: '/api/dashboards/does-not-exist' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('deleted', false);
  });
});

describe('POST /api/dashboards/:name/rename', () => {
  it('renames a dashboard: GET /api/dashboards/:newName serves it, :name 404s', async () => {
    await inject({
      method: 'POST',
      url: '/api/dashboards',
      payload: { name: 'rename-test', html: '<section>keep me</section>' },
    });
    const res = await inject({
      method: 'POST',
      url: '/api/dashboards/rename-test/rename',
      payload: { newName: 'renamed-test' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: 'renamed-test', html: '<section>keep me</section>' });

    const newStored = await inject({ method: 'GET', url: '/api/dashboards/renamed-test' });
    expect(newStored.statusCode).toBe(200);
    expect(newStored.json()).toHaveProperty('html', '<section>keep me</section>');

    const oldStored = await inject({ method: 'GET', url: '/api/dashboards/rename-test' });
    expect(oldStored.statusCode).toBe(404);
  });

  it('404s when the current name does not exist', async () => {
    const res = await inject({
      method: 'POST',
      url: '/api/dashboards/does-not-exist/rename',
      payload: { newName: 'whatever' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toHaveProperty('error.code', 'unknown_dashboard');
  });

  it('rejects (409) a newName already in use', async () => {
    await inject({
      method: 'POST',
      url: '/api/dashboards',
      payload: { name: 'rename-a', html: '<section></section>' },
    });
    await inject({
      method: 'POST',
      url: '/api/dashboards',
      payload: { name: 'rename-b', html: '<section></section>' },
    });

    const res = await inject({
      method: 'POST',
      url: '/api/dashboards/rename-a/rename',
      payload: { newName: 'rename-b' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toHaveProperty('error.code', 'duplicate_name');
  });

  it('rejects an empty newName (422)', async () => {
    await inject({
      method: 'POST',
      url: '/api/dashboards',
      payload: { name: 'rename-empty', html: '<section></section>' },
    });
    const res = await inject({ method: 'POST', url: '/api/dashboards/rename-empty/rename', payload: { newName: '' } });
    expect(res.statusCode).toBe(422);
  });
});
