import type { OpenAPIObject } from 'openapi3-ts/oas30';
import { describe, expect, it } from 'vitest';
import * as apiContract from '../../../src/logic/api-contract.js';
import { documentationContext } from '../../../src/diplomat/http/context.js';
import { buildOpenApiDocument } from '../../../src/diplomat/http/openapi.js';
import { buildRouteDefinitions } from '../../../src/diplomat/http/routes.js';
import type { HttpMethod } from '../../../src/models/api-contract.js';

const definitions = buildRouteDefinitions(documentationContext('0.0.0-test'));
const doc = buildOpenApiDocument(definitions, '0.0.0-test');
const toOpenApiPath = (path: string) => path.replace(/:([A-Za-z]+)/g, '{$1}');

const operationOf = (path: string, method: HttpMethod) =>
  (doc.paths[path] as Record<string, Record<string, unknown>>)[method]!;

describe('the contract index', () => {
  const index = apiContract.index(doc);

  it('lists every mounted route, and only those', () => {
    const declared = definitions.map(({ method, path }) => `${method} ${toOpenApiPath(path)}`).sort();
    expect(index.map(({ method, path }) => `${method} ${path}`).sort()).toEqual(declared);
  });

  it('carries each route’s summary, query names, body names and response', () => {
    const search = index.find(({ path, method }) => path === '/api/transactions' && method === 'get')!;
    expect(search.summary).toBe('Search transactions');
    expect(search.query).toEqual(expect.arrayContaining(['month', 'year', 'cursor']));
    const save = index.find(({ path, method }) => path === '/api/dashboards' && method === 'post')!;
    expect(save.body).toEqual(['name', 'html']);
    expect(save.response).toBe('Dashboard saved (object)');
    const list = index.find(({ path }) => path === '/api/dashboards')!;
    expect(list.response).toBe('Dashboards (HTML omitted) (object[])');
  });

  it('is a few KB, one line per route', () => {
    const text = index.map(apiContract.formatIndexEntry).join('\n');
    expect(text.split('\n')).toHaveLength(definitions.length);
    expect(text.length).toBeLessThan(16_000);
    expect(text).toContain('GET /api/portfolio — Get the portfolio');
  });

  it('writes "-" where a route has no query or body', () => {
    const line = apiContract.formatIndexEntry(index.find(({ path }) => path === '/api/currencies')!);
    expect(line).toContain('query: - | body: -');
  });
});

describe('a route’s detail', () => {
  it('is its OpenAPI operation, with its method and path', () => {
    const detail = apiContract.routeDetail(doc, '/api/summary', 'get')._unsafeUnwrap();
    expect(detail).toEqual([{ method: 'get', path: '/api/summary', ...operationOf('/api/summary', 'get') }]);
  });

  it('accepts the Fastify spelling of a path parameter', () => {
    const detail = apiContract.routeDetail(doc, '/api/dashboards/:name', 'delete')._unsafeUnwrap();
    expect(detail[0]?.path).toBe('/api/dashboards/{name}');
  });

  it('answers every method of the path when none is given', () => {
    const methods = apiContract
      .routeDetail(doc, '/api/dashboards')
      ._unsafeUnwrap()
      .map(({ method }) => method);
    expect(methods).toEqual(['get', 'post']);
  });

  it('refuses a method the path does not have, naming the ones it has', () => {
    const error = apiContract.routeDetail(doc, '/api/dashboards', 'delete')._unsafeUnwrapErr();
    expect(error.issues[0]).toContain('has no delete operation — it has: get, post');
  });

  it('refuses an unknown path with a validation error that lists the close matches', () => {
    const error = apiContract.routeDetail(doc, '/api/accounts/nothing/here')._unsafeUnwrapErr();
    expect(error.code).toBe('validation');
    expect(error.issues[0]).toContain('close matches: ');
    expect(error.issues[0]).toContain('/api/accounts');
  });

  it('points at the index when nothing is close', () => {
    const error = apiContract.routeDetail(doc, '/zzz')._unsafeUnwrapErr();
    expect(error.issues[0]).toContain('call without arguments for the index');
  });

  it('resolves $refs, leaving a reference it cannot follow or that loops as it is', () => {
    const withRefs = {
      openapi: '3.0.3',
      info: { title: 't', version: '0' },
      paths: {
        '/api/x': {
          get: {
            responses: {
              200: {
                description: 'ok',
                content: { 'application/json': { schema: { $ref: '#/components/schemas/Thing' } } },
              },
              404: {
                description: 'gone',
                content: { 'application/json': { schema: { $ref: '#/components/schemas/Nope' } } },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          Thing: {
            type: 'object',
            properties: { id: { type: 'string' }, parent: { $ref: '#/components/schemas/Thing' } },
          },
        },
      },
    } as unknown as OpenAPIObject;

    const [detail] = apiContract.routeDetail(withRefs, '/api/x', 'get')._unsafeUnwrap();
    const responses = detail!['responses'] as Record<string, any>;
    expect(responses['200'].content['application/json'].schema.properties.id).toEqual({ type: 'string' });
    expect(responses['200'].content['application/json'].schema.properties.parent).toEqual({
      $ref: '#/components/schemas/Thing',
    });
    expect(responses['404'].content['application/json'].schema).toEqual({ $ref: '#/components/schemas/Nope' });
    expect(apiContract.index(withRefs)[0]?.response).toBe('ok (object)');
  });
});
