import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import type { ChangeBus } from '@rfc0/effect-runner';
import { httpOrigin, isPortInUse, LOOPBACK_HOST, portInUseReason } from './common/net.js';
import type { Deps, RunEffects, RunEffectsSequence } from './controllers/deps.js';
import { registerAuthGate } from './authGate.js';
import { DISABLED_AUTH, type HttpAuth } from './diplomat/http/context.js';
import { registerRoutes } from './diplomat/http/routes.js';
import { registerMcpRoute } from './diplomat/mcp/route.js';

// Cookies and bearer credentials must never reach a log line (ADR-033 §2), whatever a serializer adds.
const REDACTED_LOG_PATHS = ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'];
const LOG_CENSOR = '[Redacted]';

export const httpLoggerOptions = (enabled: boolean) =>
  enabled ? { redact: { paths: REDACTED_LOG_PATHS, censor: LOG_CENSOR } } : false;

export type HttpOptions = {
  logger?: boolean;
  /** Fastify `trustProxy` (`TRUST_PROXY`): lets rate limiting see the real client IP behind a proxy. */
  trustProxy?: boolean | number | string;
  auth?: HttpAuth;
};

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
  opts?: HttpOptions,
): FastifyInstance => {
  // ADR-027 Phase 3: GET /ui/events is a genuinely long-lived connection (SSE) — without this,
  // fastify.close() waits for it to end on its own, which it never does, hanging shutdown for as
  // long as any browser tab has a dashboard open.
  const app = Fastify({
    logger: httpLoggerOptions(opts?.logger ?? true),
    trustProxy: opts?.trustProxy,
    forceCloseConnections: true,
  });
  registerHttpApp(app, deps, version, runEffects, runEffectsSequence, resetLocale, subscribeToChanges, opts?.auth);
  return app;
};

/** Everything `buildHttpApp` adds to a bare Fastify instance, in the one order that matters: the auth hook
 *  first, so it guards every route registered after it (and any request no route matches). Exported so a
 *  test can attach an `onRoute` listener to the instance before the routes exist. */
export const registerHttpApp = (
  app: FastifyInstance,
  deps: Deps,
  version: string,
  runEffects: RunEffects,
  runEffectsSequence: RunEffectsSequence,
  resetLocale: () => void,
  subscribeToChanges: ChangeBus['subscribe'],
  auth: HttpAuth = DISABLED_AUTH,
): void => {
  registerAuthGate(app, auth);
  registerRoutes(app, deps, version, runEffects, runEffectsSequence, subscribeToChanges, auth);
  registerMcpRoute(app, deps, version, runEffects, runEffectsSequence, resetLocale);
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
  host: string = LOOPBACK_HOST,
  opts?: Pick<HttpOptions, 'trustProxy' | 'auth'>,
): Promise<HttpSidecar> => {
  const app = buildHttpApp(deps, version, runEffects, runEffectsSequence, resetLocale, subscribeToChanges, {
    ...opts,
    logger: false,
  });
  try {
    await app.listen({ port, host });
    // `port` may be 0 (OS-assigned); read back the address actually bound for the banner.
    const boundPort = (app.server.address() as AddressInfo).port;
    const origin = httpOrigin(host, boundPort);
    console.error(
      `fintrack: HTTP sidecar up — REST ${origin}/api · MCP ${origin}/mcp · dashboard ${origin}/ui/overview`,
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
