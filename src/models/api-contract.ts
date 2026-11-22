import type { OperationObject } from 'openapi3-ts/oas30';
import { z } from 'zod';

export const HttpMethod = z.enum(['get', 'post', 'patch', 'delete']);
export type HttpMethod = z.infer<typeof HttpMethod>;

export type ContractIndexEntry = {
  method: HttpMethod;
  /** In OpenAPI form (`/api/dashboards/{name}`). */
  path: string;
  summary: string;
  query: string[];
  body: string[];
  response: string;
};

export type ContractRouteDetail = { method: HttpMethod; path: string } & Record<string, unknown>;

export type ContractOperations = ReadonlyArray<readonly [HttpMethod, OperationObject]>;

export type ContractRoute = { path: string; operations: ContractOperations };
