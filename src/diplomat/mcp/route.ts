import type { IncomingMessage } from 'node:http';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { FastifyInstance } from 'fastify';
import type { Tenancy } from '../../controllers/deps.js';
import { hasScope, requiredMcpScope } from '../../logic/auth/scope.js';
import { MCP_PATH } from '../../models/auth/bearer.js';
import { authErrors } from '../../models/auth/errors.js';
import { READ_SCOPE } from '../../models/auth/scope.js';
import { rejectWithChallenge } from '../http/bearer.js';
import '../http/principal.js';
import { authInfoOf } from './auth-info.js';
import { authInfoGate } from './gate.js';
import { buildMcpServer } from './server.js';
import { toolScopesOf } from './scopes.js';

/**
 * Stateless MCP over streamable HTTP: a fresh server+transport per request.
 * Claude clients connect to POST /mcp.
 *
 * Authorization (ADR-033 §3): the auth hook has already authenticated the request and checked the route-level
 * `read` scope (config below). A `preHandler` then reads the parsed JSON-RPC body and, for a `tools/call` of a
 * write tool (any message, if the SDK is given a batch), demands `fintrack:write` — a short token gets a 403
 * `insufficient_scope` challenge before any tool runs. The principal then travels to the tools as `req.raw.auth`
 * (the SDK's `AuthInfo`), where `scopes.ts` checks it again.
 */
export const registerMcpRoute = (app: FastifyInstance, tenancy: Tenancy, version: string, publicUrl?: string): void => {
  const scopeGuard = { gate: authInfoGate };
  // Built once, only to learn which scope each tool needs; the per-request server below is identical.
  const catalog = buildMcpServer(tenancy, version, scopeGuard);
  const toolScopes = toolScopesOf(catalog);

  app.post(
    MCP_PATH,
    {
      config: { scope: READ_SCOPE },
      preHandler: async (req, reply) => {
        const required = requiredMcpScope(req.body, (name) => toolScopes.get(name));
        const principal = req.principal;
        if (principal && hasScope(principal.scopes, required)) return undefined;
        const error = principal ? authErrors.insufficientScope(required) : authErrors.unauthenticated;
        return rejectWithChallenge(req, reply, publicUrl, error);
      },
    },
    async (req, reply) => {
      const server = buildMcpServer(tenancy, version, scopeGuard);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      // The SDK reads the caller's AuthInfo from `req.auth` and passes it to every tool as `extra.authInfo`.
      if (req.principal) (req.raw as IncomingMessage & { auth?: AuthInfo }).auth = authInfoOf(req.principal);
      reply.hijack();
      await server.connect(transport);
      await transport.handleRequest(req.raw, reply.raw, req.body);
      reply.raw.on('close', () => {
        void transport.close();
        void server.close();
      });
    },
  );

  // Stateless mode: no SSE stream or session to manage.
  app.get(MCP_PATH, async (_req, reply) => reply.status(405).send({ error: 'method_not_allowed' }));
  app.delete(MCP_PATH, async (_req, reply) => reply.status(405).send({ error: 'method_not_allowed' }));
};
