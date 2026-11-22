import { err, ok, type Result } from 'neverthrow';
import type { OpenAPIObject, OperationObject, ParameterObject, PathItemObject } from 'openapi3-ts/oas30';
import * as R from 'remeda';
import { validation, type ValidationError } from '../models/error.js';
import {
  HttpMethod,
  type ContractIndexEntry,
  type ContractOperations,
  type ContractRoute,
  type ContractRouteDetail,
} from '../models/api-contract.js';

const CLOSE_MATCH_LIMIT = 5;
const FIRST_SUCCESS_STATUS = /^2\d\d$/;
const REF_PREFIX = '#/';

const operationsOf = (item: PathItemObject): ContractOperations =>
  HttpMethod.options.flatMap((method) => (item[method] ? [[method, item[method]] as const] : []));

const routesOf = (doc: OpenAPIObject): readonly ContractRoute[] =>
  Object.entries(doc.paths ?? {}).map(([path, item]) => ({ path, operations: operationsOf(item) }));

const toDocumentPath = (path: string): string => path.trim().replace(/:([A-Za-z]+)/g, '{$1}');

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
  R.pipe(
    (operation.parameters ?? []) as ParameterObject[],
    R.filter((parameter) => parameter.in === 'query'),
    R.map(R.prop('name')),
  );

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

export const index = (doc: OpenAPIObject): ContractIndexEntry[] =>
  routesOf(doc).flatMap(({ path, operations }) => operations.map((operation) => indexEntry(path, operation)));

const listOrDash = (names: string[]): string => (names.length === 0 ? '-' : names.join(','));

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
  R.sumBy(segmentsOf(path), (segment) =>
    Math.max(0, ...segmentsOf(candidate).map((other) => commonPrefixLength(segment, other))),
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
