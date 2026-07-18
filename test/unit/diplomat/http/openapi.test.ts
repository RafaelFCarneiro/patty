import { describe, expect, it } from 'vitest';
import type { Deps, RunEffects, RunEffectsSequence } from '../../../../src/controllers/deps.js';
import { buildOpenApiDocument, mountRoutes } from '../../../../src/diplomat/http/openapi.js';
import { buildRouteDefinitions } from '../../../../src/diplomat/http/routes.js';

// Route handlers are never invoked in this test — buildRouteDefinitions only needs `deps`/
// `runEffects`/`runEffectsSequence` to close over them inside handler bodies (routes.ts still
// imports controllers at module load, same as always; these stubs just never get called). The
// point being proved is that building the array and the OpenAPI document from it requires no I/O
// and no live Fastify instance.
const stubDeps = {} as unknown as Deps;
const stubRunEffects = {} as unknown as RunEffects;
const stubRunEffectsSequence = {} as unknown as RunEffectsSequence;

const HTTP_METHODS = ['get', 'post', 'patch', 'delete'] as const;

const toOpenApiPath = (path: string) => path.replace(/:([A-Za-z]+)/g, '{$1}');

describe('buildRouteDefinitions + buildOpenApiDocument + mountRoutes', () => {
  it('documents every route in the single shared definitions array (parity is now structural)', () => {
    const definitions = buildRouteDefinitions(stubDeps, '0.0.0-test', stubRunEffects, stubRunEffectsSequence);
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
    const definitions = buildRouteDefinitions(stubDeps, '0.0.0-test', stubRunEffects, stubRunEffectsSequence);
    const keys = definitions.map((d) => `${d.method} ${d.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('mounts every definition on the Fastify instance via the matching HTTP verb', () => {
    const definitions = buildRouteDefinitions(stubDeps, '0.0.0-test', stubRunEffects, stubRunEffectsSequence);
    const mounted: Array<{ method: string; path: string }> = [];
    const fakeApp = Object.fromEntries(
      HTTP_METHODS.map((method) => [method, (path: string) => mounted.push({ method, path })]),
    );

    mountRoutes(fakeApp as never, definitions);

    expect(mounted).toEqual(definitions.map(({ method, path }) => ({ method, path })));
  });
});
