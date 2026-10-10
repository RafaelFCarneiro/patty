import { describe, expect, it } from 'vitest';
import type { Deps, RunEffects, RunEffectsSequence } from '../../../../src/controllers/deps.js';
import { buildRouteDefinitions } from '../../../../src/diplomat/http/routes.js';
import { defaultScopeForMethod } from '../../../../src/logic/auth.js';
import { READ_SCOPE, Scope, WRITE_SCOPE } from '../../../../src/models/auth.js';

const definitions = buildRouteDefinitions(
  {} as Deps,
  '0.0.0',
  (() => undefined) as unknown as RunEffects,
  (() => undefined) as unknown as RunEffectsSequence,
);

describe('REST route scopes (ADR-033 §3)', () => {
  it('names the two scopes the enum defines', () => {
    expect([READ_SCOPE, WRITE_SCOPE]).toEqual([Scope.enum['fintrack:read'], Scope.enum['fintrack:write']]);
  });

  it('every route definition declares a scope, and it is the default method rule', () => {
    expect(definitions.length).toBeGreaterThan(50);
    const disagreeing = definitions
      .filter(({ method, scope }) => scope !== defaultScopeForMethod(method))
      .map(({ method, path, scope }) => `${method.toUpperCase()} ${path} declares ${scope}`);
    expect(disagreeing).toEqual([]);
  });

  it('no non-GET route is readable with a read-only token', () => {
    const writes = definitions.filter(({ method }) => method !== 'get');
    expect(writes.length).toBeGreaterThan(25);
    for (const { scope } of writes) expect(scope).toBe(WRITE_SCOPE);
  });
});
