import {
  extendZodWithOpenApi,
  OpenAPIRegistry,
  OpenApiGeneratorV3,
  type RouteConfig,
} from '@asteasolutions/zod-to-openapi';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import './principal.js';
import type { OpenAPIObject } from 'openapi3-ts/oas30';
import { z } from 'zod';
import { scopedFor, type Scoped, type Tenancy } from '../../controllers/deps.js';
import type { Scope } from '../../models/auth/scope.js';

/**
 * OpenAPI machinery shared by every REST route. routes.ts builds ONE array of route
 * definitions (method/path/schemas/handler) — the single source of truth. `mountRoutes`
 * registers it on Fastify; `buildOpenApiDocument` documents it. Neither needs the other, so
 * the MCP resource (which has no Fastify instance under stdio transport) can call
 * `buildOpenApiDocument` directly on the same array with nothing to keep in sync (ADR-013 Phase A).
 *
 * This module holds only routing/doc-generation mechanics — no wire schemas. Response and
 * request shapes are domain wire contracts and live in `wire/out/*` and `wire/in/*`, same as
 * everywhere else in the app; routes.ts imports them from there.
 */

extendZodWithOpenApi(z);

export type HttpMethod = 'get' | 'post' | 'patch' | 'delete';
/** The request's user-scoped dependencies, asked for by the handler that needs them (ADR-033 §5). It throws when the
 *  request carries no principal — a handler that reaches for a user's data without one is a bug, and it fails closed
 *  rather than falling back to anyone. A public route (the health probe) simply never asks. */
export type ScopeOf = () => Scoped;
export type RouteHandler = (req: FastifyRequest, reply: FastifyReply, scope: ScopeOf) => unknown;
export type RouteMeta = Omit<RouteConfig, 'method' | 'path'> & {
  method: HttpMethod;
  path: string;
  /** The scope a caller needs (ADR-033 §3) — enforced by the auth hook from the matched route's config. */
  scope: Scope;
};
export type RouteDefinition = RouteMeta & { handler: RouteHandler };

// Route definitions write paths in Fastify's `:param` syntax (the only form Fastify accepts);
// this is the sole conversion to OpenAPI's `{param}` syntax, applied when documenting.
const toOpenApiPath = (fastifyPath: string): string => fastifyPath.replace(/:([A-Za-z]+)/g, '{$1}');

export const MISSING_PRINCIPAL_MESSAGE = 'fintrack: a route reached user data without an authenticated principal';

/** Binds a handler to the tenancy: the principal the auth hook attached to the request becomes the user the handler's
 *  dependencies are scoped to. */
const withScope =
  (tenancy: Tenancy, handler: RouteHandler) =>
  (req: FastifyRequest, reply: FastifyReply): unknown =>
    handler(req, reply, () => {
      if (!req.principal) throw new Error(MISSING_PRINCIPAL_MESSAGE);
      return scopedFor(tenancy, req.principal);
    });

export const mountRoutes = (app: FastifyInstance, definitions: RouteDefinition[], tenancy: Tenancy): void => {
  for (const { method, path, scope, handler } of definitions) {
    const options = { config: { scope } };
    const scoped = withScope(tenancy, handler);
    switch (method) {
      case 'get':
        app.get(path, options, scoped);
        break;
      case 'post':
        app.post(path, options, scoped);
        break;
      case 'patch':
        app.patch(path, options, scoped);
        break;
      case 'delete':
        app.delete(path, options, scoped);
        break;
      default: {
        const _exhaustive: never = method;
        throw new Error(`unmapped HTTP method: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }
};

export const buildOpenApiDocument = (definitions: RouteDefinition[], version: string): OpenAPIObject => {
  const registry = new OpenAPIRegistry();
  for (const { handler: _handler, scope: _scope, ...meta } of definitions) {
    registry.registerPath({ ...meta, path: toOpenApiPath(meta.path) });
  }

  const generator = new OpenApiGeneratorV3(registry.definitions);
  return generator.generateDocument({
    openapi: '3.0.3',
    info: {
      title: 'FinTrack API',
      version,
      description:
        'REST contract for the FinTrack HTTP API (ADR-013). MCP (POST /mcp) is the primary surface; ' +
        'this document exists so agent-generated dashboards can call /api with correct request/response shapes.',
    },
  });
};

// ─── OpenAPI response-config formatting — presentation glue, not domain/wire shapes ───

const jsonContent = (schema: z.ZodTypeAny) => ({ 'application/json': { schema } });
export const jsonBody = (schema: z.ZodTypeAny) => ({ content: jsonContent(schema) });
export const okResponse = (description: string, schema: z.ZodTypeAny) => ({
  description,
  content: jsonContent(schema),
});
