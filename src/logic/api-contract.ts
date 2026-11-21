import { err, ok, type Result } from 'neverthrow';
import type { OpenAPIObject, OperationObject, ParameterObject, PathItemObject } from 'openapi3-ts/oas30';
import * as R from 'remeda';
import { validation, type ValidationError } from '../models/error.js';
import { HttpMethod, type ContractIndexEntry, type ContractRouteDetail } from '../models/api-contract.js';

/**
 * The API contract as a client that only receives tools reads it: an index of the routes, then one route's schema.
 * Both are views of the OpenAPI document, which is built from `buildRouteDefinitions` — nothing here lists a route.
 */

const CLOSE_MATCH_LIMIT = 5;
const FIRST_SUCCESS_STATUS = /^2\d\d$/;
const REF_PREFIX = '#/';

type Operations = ReadonlyArray<readonly [HttpMethod, OperationObject]>;

const operationsOf = (item: PathItemObject): Operations =>
  HttpMethod.options.flatMap((method) => (item[method] ? [[method, item[method]] as const] : []));

const routesOf = (doc: OpenAPIObject): ReadonlyArray<{ path: string; operations: Operations }> =>
  Object.entries(doc.paths ?? {}).map(([path, item]) => ({ path, operations: operationsOf(item) }));

/** `:name` and `{name}` are the same path; the document spells it `{name}`. */
const toDocumentPath = (path: string): string => path.trim().replace(/:([A-Za-z]+)/g, '{$1}');

/** Replaces each `$ref` by what it points to; a reference that cannot be followed, or loops, is left as it is. */
const resolveRefs =
  (doc: OpenAPIObject) =>
  (node: unknown, followed: readonly string[] = []): unknown => {
    if (Array.isArray(node)) return node.map((child) => resolveRefs(doc)(child, followed));
    if (!R.isPlainObject(node)) return node;
    const ref = node['$ref'];
    if (typeof ref !== 'string') return R.mapValues(node, (child) => resolveRefs(doc)(child, followed));
    const target = ref.startsWith(REF_PREFIX)
      ? ref
          .slice(REF_PREFIX.length)
          .split('/')
          .reduce<unknown>((at, key) => (R.isPlainObject(at) ? at[key] : undefined), doc)
      : undefined;
    return target === undefined || followed.includes(ref) ? node : resolveRefs(doc)(target, [...followed, ref]);
  };

const schemaOf = (content: unknown): Record<string, unknown> | undefined => {
  const media = R.isPlainObject(content) ? content['application/json'] : undefined;
  const schema = R.isPlainObject(media) ? media['schema'] : undefined;
  return R.isPlainObject(schema) ? schema : undefined;
};

const propertyNames = (schema: Record<string, unknown> | undefined): string[] =>
  R.isPlainObject(schema?.['properties']) ? Object.keys(schema['properties']) : [];

const typeName = (schema: Record<string, unknown> | undefined): string => {
  const type = typeof schema?.['type'] === 'string' ? schema['type'] : 'object';
  const items = R.isPlainObject(schema?.['items']) ? schema['items'] : undefined;
  return type === 'array' ? `${typeName(items)}[]` : type;
};

const queryParameterNames = (operation: OperationObject): string[] =>
  ((operation.parameters ?? []) as ParameterObject[])
    .filter((parameter) => parameter.in === 'query')
    .map((p) => p.name);

const responseOf = (operation: OperationObject): string => {
  const status = Object.keys(operation.responses ?? {}).find((code) => FIRST_SUCCESS_STATUS.test(code));
  const response = status === undefined ? undefined : (operation.responses?.[status] as Record<string, unknown>);
  const description = typeof response?.['description'] === 'string' ? response['description'] : 'no body';
  return `${description} (${typeName(schemaOf(response?.['content']))})`;
};

const indexEntry = (path: string, [method, operation]: readonly [HttpMethod, OperationObject]): ContractIndexEntry => ({
  method,
  path,
  summary: operation.summary ?? '',
  query: queryParameterNames(operation),
  body: propertyNames(schemaOf((operation.requestBody as Record<string, unknown> | undefined)?.['content'])),
  response: responseOf(operation),
});

/** Every route of the document, one entry per method and path, in document order. */
export const index = (doc: OpenAPIObject): ContractIndexEntry[] =>
  routesOf(doc).flatMap(({ path, operations }) => operations.map((operation) => indexEntry(path, operation)));

const listOrDash = (names: string[]): string => (names.length === 0 ? '-' : names.join(','));

/** One line per route: `GET /api/summary — Get spending summary | query: month,year | body: - | returns: …`. */
export const formatIndexEntry = ({ method, path, summary, query, body, response }: ContractIndexEntry): string =>
  `${method.toUpperCase()} ${path} — ${summary} | query: ${listOrDash(query)} | body: ${listOrDash(body)} | returns: ${response}`;

const API_SEGMENT = 'api';

const segmentsOf = (path: string): string[] => path.split('/').filter((segment) => segment && segment !== API_SEGMENT);

const commonPrefixLength = (a: string, b: string): number => {
  const differing = [...a].findIndex((character, index) => character !== b[index]);
  return differing === -1 ? a.length : differing;
};

/** How much of each segment of `path` the candidate's best segment shares from the start: `summaries` ≈ `summary`. */
const closeness = (candidate: string, path: string): number =>
  segmentsOf(path).reduce(
    (total, segment) =>
      total + Math.max(0, ...segmentsOf(candidate).map((other) => commonPrefixLength(segment, other))),
    0,
  );

const closeMatches = (doc: OpenAPIObject, path: string): string[] =>
  R.pipe(
    routesOf(doc),
    R.map(({ path: candidate }) => ({ candidate, score: closeness(candidate, path) })),
    R.filter(({ score }) => score > 0),
    R.sortBy([R.prop('score'), 'desc'], R.prop('candidate')),
    R.take(CLOSE_MATCH_LIMIT),
    R.map(R.prop('candidate')),
  );

const unknownPath = (doc: OpenAPIObject, path: string): ValidationError => {
  const matches = closeMatches(doc, path);
  return validation([
    `unknown path "${path}" — ${matches.length === 0 ? 'call without arguments for the index' : `close matches: ${matches.join(', ')}`}`,
  ]);
};

const detailOf = (doc: OpenAPIObject, path: string, [method, operation]: readonly [HttpMethod, OperationObject]) =>
  ({ method, path, ...(resolveRefs(doc)(operation) as Record<string, unknown>) }) satisfies ContractRouteDetail;

/** The route's operation(s), `$ref`s resolved: the one `method` names, or every method of the path without one. */
export const routeDetail = (
  doc: OpenAPIObject,
  rawPath: string,
  method?: HttpMethod,
): Result<ContractRouteDetail[], ValidationError> => {
  const path = toDocumentPath(rawPath);
  const route = routesOf(doc).find((candidate) => candidate.path === path);
  if (route === undefined) return err(unknownPath(doc, path));
  const operations = route.operations.filter(([candidateMethod]) => method === undefined || candidateMethod === method);
  return operations.length === 0
    ? err(validation([`${path} has no ${method} operation — it has: ${route.operations.map(([m]) => m).join(', ')}`]))
    : ok(operations.map((operation) => detailOf(doc, path, operation)));
};
