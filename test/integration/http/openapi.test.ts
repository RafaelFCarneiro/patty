import { describe, expect, it } from 'vitest';
import { setupHttpTest } from './setup.js';

const { inject } = setupHttpTest();

const HTTP_METHODS = ['get', 'post', 'patch', 'delete'];

describe('GET /api/openapi.json', () => {
  it('returns a well-formed OpenAPI 3.x document', async () => {
    const res = await inject({ method: 'GET', url: '/api/openapi.json' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');

    const doc = res.json();
    expect(doc.openapi).toMatch(/^3\./);
    expect(typeof doc.info?.title).toBe('string');
    expect(typeof doc.info?.version).toBe('string');
    expect(typeof doc.paths).toBe('object');
    expect(Object.keys(doc.paths).length).toBeGreaterThan(0);
  });

  it('every documented response body is JSON with a description', async () => {
    const res = await inject({ method: 'GET', url: '/api/openapi.json' });
    const doc = res.json();

    for (const [path, item] of Object.entries<Record<string, unknown>>(doc.paths)) {
      for (const method of HTTP_METHODS) {
        const operation = item[method] as { responses?: Record<string, { description?: string }> } | undefined;
        if (!operation) continue;
        for (const [status, response] of Object.entries(operation.responses ?? {})) {
          expect(response.description, `${method.toUpperCase()} ${path} -> ${status}`).toBeTruthy();
        }
      }
    }
  });

  it('documents a representative sample of live, mounted routes (both surfaces agree at runtime)', async () => {
    const doc = (await inject({ method: 'GET', url: '/api/openapi.json' })).json();

    const live = await inject({ method: 'GET', url: '/api/accounts' });
    expect(live.statusCode).toBe(200);
    expect(doc.paths['/api/accounts']?.get).toBeDefined();

    const liveUpdate = await inject({ method: 'PATCH', url: '/api/accounts/does-not-exist' });
    expect(liveUpdate.statusCode).toBe(404);
    expect(doc.paths['/api/accounts/{name}']?.patch).toBeDefined();

    // The spec route documents every OTHER route, not itself.
    expect(doc.paths['/api/openapi.json']).toBeUndefined();
  });

  it('documents /api/dashboards* (ADR-013 Phase A) but excludes /ui/:name by design', async () => {
    const doc = (await inject({ method: 'GET', url: '/api/openapi.json' })).json();

    expect(doc.paths['/api/dashboards']?.get).toBeDefined();
    expect(doc.paths['/api/dashboards']?.post).toBeDefined();
    expect(doc.paths['/api/dashboards/{name}']?.get).toBeDefined();

    const liveList = await inject({ method: 'GET', url: '/api/dashboards' });
    expect(liveList.statusCode).toBe(200);

    // /ui/:name is a browser-facing HTML surface, not a JSON fetch contract — deliberately kept
    // out of the OpenAPI document (docs/architecture.md § Dashboards / /ui surface), even though
    // it's a live, mounted route.
    expect(doc.paths['/ui/{name}']).toBeUndefined();
    expect(doc.paths['/ui/:name']).toBeUndefined();
    const liveUi = await inject({ method: 'GET', url: '/ui/overview' });
    expect(liveUi.statusCode).toBe(200);
  });
});
