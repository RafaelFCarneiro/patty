import { z } from 'zod';

/** The verbs the REST API uses. */
export const HttpMethod = z.enum(['get', 'post', 'patch', 'delete']);
export type HttpMethod = z.infer<typeof HttpMethod>;

/** One line of the API contract index: what a client needs to pick a route before asking for its schema. */
export type ContractIndexEntry = {
  method: HttpMethod;
  /** In OpenAPI form (`/api/dashboards/{name}`). */
  path: string;
  summary: string;
  query: string[];
  body: string[];
  response: string;
};

/** A route's full request and response schema: its OpenAPI operation, `$ref`s resolved. */
export type ContractRouteDetail = { method: HttpMethod; path: string } & Record<string, unknown>;
