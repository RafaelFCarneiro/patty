import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import type { ChangeBus } from './diplomat/changeBus.js';
import { isPortInUse, LOOPBACK_HOST, portInUseReason } from './common/net.js';
import type { Deps, RunEffects, RunEffectsSequence } from './controllers/deps.js';
import { registerRoutes } from './diplomat/http/routes.js';
import { registerMcpRoute } from './diplomat/mcp/route.js';

/**
 * Composition root for the HTTP surface (REST + streamable-HTTP MCP): wires the two
 * diplomat edges onto one Fastify instance. Lives outside diplomat/http and diplomat/mcp
 * so neither edge depends on the other (docs/architecture.md dependency table) — only the
 * composition root is allowed to know about both.
 */
export const buildHttpApp = (
  deps: Deps,
  version: string,
  runEffects: RunEffects,
  runEffectsSequence: RunEffectsSequence,
  resetLocale: () => void,
  subscribeToChanges: ChangeBus['subscribe'],
  opts?: { logger?: boolean },
): FastifyInstance => {
  // ADR-027 Phase 3: GET /ui/events is a genuinely long-lived connection (SSE) — without this,
  // fastify.close() waits for it to end on its own, which it never does, hanging shutdown for as
  // long as any browser tab has a dashboard open.
  const app = Fastify({ logger: opts?.logger ?? true, forceCloseConnections: true });
  registerRoutes(app, deps, version, runEffects, runEffectsSequence, subscribeToChanges);
  registerMcpRoute(app, deps, version, runEffects, runEffectsSequence, resetLocale);
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
export const startHttpSidecar = async (
  deps: Deps,
  version: string,
  runEffects: RunEffects,
  runEffectsSequence: RunEffectsSequence,
  resetLocale: () => void,
  subscribeToChanges: ChangeBus['subscribe'],
  port: number,
): Promise<HttpSidecar> => {
  const app = buildHttpApp(deps, version, runEffects, runEffectsSequence, resetLocale, subscribeToChanges, {
    logger: false,
  });
  try {
    await app.listen({ port, host: LOOPBACK_HOST });
    // `port` may be 0 (OS-assigned); read back the address actually bound for the banner.
    const boundPort = (app.server.address() as AddressInfo).port;
    console.error(
      `fintrack: HTTP sidecar up — REST http://${LOOPBACK_HOST}:${boundPort}/api · ` +
        `MCP http://${LOOPBACK_HOST}:${boundPort}/mcp · dashboard http://${LOOPBACK_HOST}:${boundPort}/ui/overview`,
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
