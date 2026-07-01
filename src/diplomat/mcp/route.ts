import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { FastifyInstance } from 'fastify';
import type { Deps } from '../../controllers/deps.js';
import { buildMcpServer } from './server.js';

/**
 * Stateless MCP over streamable HTTP: a fresh server+transport per request.
 * Claude clients connect to POST /mcp.
 */
export const registerMcpRoute = (app: FastifyInstance, deps: Deps, version: string): void => {
  app.post('/mcp', async (req, reply) => {
    const server = buildMcpServer(deps, version);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    reply.hijack();
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });
  });

  // Stateless mode: no SSE stream or session to manage.
  app.get('/mcp', async (_req, reply) => reply.status(405).send({ error: 'method_not_allowed' }));
  app.delete('/mcp', async (_req, reply) => reply.status(405).send({ error: 'method_not_allowed' }));
};
