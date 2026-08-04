import { describe, expect, it } from 'vitest';
import { setupHttpTest } from './setup.js';

const { inject } = setupHttpTest();

describe('GET /ui', () => {
  it('serves the app shell — menu container, content container, and asset links', async () => {
    const res = await inject({ method: 'GET', url: '/ui' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.headers['cache-control']).toContain('no-cache');
    expect(res.body).toContain('id="dashboard-menu"');
    expect(res.body).toContain('id="content"');
    expect(res.body).toContain('/ui/assets/app.css');
    expect(res.body).toContain('/ui/assets/app.js');
  });
});

describe('GET /ui/:name', () => {
  it('serves the same shell regardless of whether the name exists (client resolves it)', async () => {
    const known = await inject({ method: 'GET', url: '/ui/overview' });
    const unknown = await inject({ method: 'GET', url: '/ui/does-not-exist' });
    expect(known.statusCode).toBe(200);
    expect(unknown.statusCode).toBe(200);
    expect(known.body).toBe(unknown.body);
    expect(known.body).toContain('id="content"');
  });
});

describe('GET /ui/assets/app.css', () => {
  it('serves the shared stylesheet', async () => {
    const res = await inject({ method: 'GET', url: '/ui/assets/app.css' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/css');
    expect(res.body).toContain(':root');
    expect(res.body).toContain('#dashboard-menu');
  });
});

describe('GET /ui/assets/app.js', () => {
  it('serves the shell client', async () => {
    const res = await inject({ method: 'GET', url: '/ui/assets/app.js' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('javascript');
    expect(res.body).toContain('/api/dashboards');
  });
});
