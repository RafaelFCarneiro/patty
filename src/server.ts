import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import { isPortInUse, portInUseReason } from './common/net.js';
import type { Deps } from './controllers/deps.js';
import { registerRoutes } from './diplomat/http/routes.js';
import { registerMcpRoute } from './diplomat/mcp/route.js';

/**
 * Composition root for the HTTP surface (REST + streamable-HTTP MCP): wires the two
 * diplomat edges onto one Fastify instance. Lives outside diplomat/http and diplomat/mcp
 * so neither edge depends on the other (docs/architecture.md dependency table) — only the
 * composition root is allowed to know about both.
 */
export const buildHttpApp = (deps: Deps, version: string, opts?: { logger?: boolean }): FastifyInstance => {
  const app = Fastify({ logger: opts?.logger ?? true });
  registerRoutes(app, deps, version);
  registerMcpRoute(app, deps, version);
  return app;
};

export type HttpSidecar = { app: FastifyInstance; listening: boolean };

/**
 * Best-effort HTTP sidecar alongside stdio MCP (ADR-013 Decision 7). A bind failure is
 * caught here and never propagates: the stdio MCP connection this runs beside is the
 * resilient primary and must keep working even when the port is taken. All output goes to
 * stderr — stdout carries the MCP protocol in stdio mode (ADR-007) — and the Fastify
 * request logger is disabled for the same reason.
 */
export const startHttpSidecar = async (deps: Deps, version: string, port: number): Promise<HttpSidecar> => {
  const app = buildHttpApp(deps, version, { logger: false });
  try {
    await app.listen({ port, host: '::' });
    // `port` may be 0 (OS-assigned); read back the address actually bound for the banner.
    const boundPort = (app.server.address() as AddressInfo).port;
    console.error(
      `fintrack: HTTP sidecar up — REST http://localhost:${boundPort}/api · MCP http://localhost:${boundPort}/mcp`,
    );
    return { app, listening: true };
  } catch (e) {
    const reason = isPortInUse(e) ? portInUseReason(port) : String(e);
    console.error(
      `fintrack: HTTP sidecar disabled — ${reason}. Dashboards/REST are unavailable this run; MCP over stdio ` +
        `keeps working. Free the port (or set PORT=<other> and restart) to enable it.`,
    );
    return { app, listening: false };
  }
};
