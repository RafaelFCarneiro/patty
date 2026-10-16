import { describe, expect, it } from 'vitest';
import type { Tenancy } from '../../../../src/controllers/deps.js';
import { documentationContext } from '../../../../src/diplomat/http/context.js';
import { buildOpenApiDocument, mountRoutes } from '../../../../src/diplomat/http/openapi.js';
import { buildRouteDefinitions } from '../../../../src/diplomat/http/routes.js';

// Route handlers are never invoked in this test — buildRouteDefinitions is given the documentation-only context, whose
// factories refuse to build anyone's dependencies. The point being proved is that building the array and the OpenAPI
// document from it requires no I/O, no principal and no live Fastify instance.
const context = documentationContext('0.0.0-test');
const stubTenancy = {} as unknown as Tenancy;

const HTTP_METHODS = ['get', 'post', 'patch', 'delete'] as const;

const toOpenApiPath = (path: string) => path.replace(/:([A-Za-z]+)/g, '{$1}');

describe('buildRouteDefinitions + buildOpenApiDocument + mountRoutes', () => {
  it('documents every route in the single shared definitions array (parity is now structural)', () => {
    const definitions = buildRouteDefinitions(context);
    expect(definitions.length).toBeGreaterThan(0);

    const doc = buildOpenApiDocument(definitions, '0.0.0-test');
    const documented = new Set(
      Object.entries(doc.paths ?? {}).flatMap(([path, item]) =>
        HTTP_METHODS.filter((m) => (item as Record<string, unknown>)[m]).map((m) => `${m.toUpperCase()} ${path}`),
      ),
    );
    const declared = new Set(definitions.map((d) => `${d.method.toUpperCase()} ${toOpenApiPath(d.path)}`));

    expect(documented).toEqual(declared);
  });

  it('has no duplicate method+path across the definitions array', () => {
    const definitions = buildRouteDefinitions(context);
    const keys = definitions.map((d) => `${d.method} ${d.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('mounts every definition on the Fastify instance via the matching HTTP verb', () => {
    const definitions = buildRouteDefinitions(context);
    const mounted: Array<{ method: string; path: string }> = [];
    const fakeApp = Object.fromEntries(
      HTTP_METHODS.map((method) => [method, (path: string) => mounted.push({ method, path })]),
    );

    mountRoutes(fakeApp as never, definitions, stubTenancy);

    expect(mounted).toEqual(definitions.map(({ method, path }) => ({ method, path })));
  });
});
