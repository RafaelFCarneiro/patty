import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { setupHttpTest } from './setup.js';

const { inject } = setupHttpTest();

const ROUTES_SOURCE = fileURLToPath(new URL('../../../src/diplomat/http/routes.ts', import.meta.url));
const HTTP_METHODS = ['get', 'post', 'patch', 'delete'];

// The spec route documents every OTHER /api route, not itself — routes.ts registers it,
// but it is intentionally absent from the generated OpenAPI document (openapi.ts).
const META_ROUTES = new Set(['GET /api/openapi.json']);

/** Enumerate every `app.<verb>('/api/...')` call in routes.ts — the actual registered surface. */
const registeredRoutes = (): string[] => {
  const source = readFileSync(ROUTES_SOURCE, 'utf-8');
  const matches = [...source.matchAll(/app\.(get|post|patch|delete)\(\s*['"]([^'"]+)['"]/g)];
  return matches
    .map(([, method, path]) => `${method.toUpperCase()} ${path.replace(/:([A-Za-z]+)/g, '{$1}')}`)
    .filter((route) => !META_ROUTES.has(route));
};

/** Flatten the OpenAPI document's paths object into the same "METHOD /path" shape. */
const documentedRoutes = (paths: Record<string, Record<string, unknown>>): string[] =>
  Object.entries(paths).flatMap(([path, item]) =>
    HTTP_METHODS.filter((method) => item[method]).map((method) => `${method.toUpperCase()} ${path}`),
  );

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

  it('has exactly one documented path+method per route registered in routes.ts (parity)', async () => {
    const res = await inject({ method: 'GET', url: '/api/openapi.json' });
    const doc = res.json();

    expect(new Set(documentedRoutes(doc.paths))).toEqual(new Set(registeredRoutes()));
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
});
