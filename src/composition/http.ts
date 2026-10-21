import type { AddressInfo } from 'node:net';
import { ok, safeTry, type ResultAsync } from 'neverthrow';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { version } from '../common/build-version.js';
import type { Config } from '../config.js';
import { boot } from './boot.js';
import { httpOrigin, isPortInUse, LOOPBACK_HOST, portInUseReason } from '../common/net.js';
import type { Tenancy } from '../controllers/deps.js';
import { DISABLED_AUTH, type HttpAuth, type HttpContext } from '../diplomat/http/context.js';
import type { ChangeBus } from '@rfc0/effect-runner';
import type { ChangeEvent } from '../models/tenancy.js';
import type { DatabaseAhead } from '../models/database.js';
import { redactSecretQuery } from '../logic/auth/redact.js';
import { AuthMode } from '../models/auth/mode.js';
import { registerAuthHook } from '../diplomat/http/hooks/auth.js';
import { registerRoutes } from '../diplomat/http/routes.js';
import { registerMcpRoute } from '../diplomat/mcp/route.js';

// Cookies and bearer credentials must never reach a log line (ADR-033 §2), whatever a serializer adds.
const REDACTED_LOG_PATHS = ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'];
const LOG_CENSOR = '[Redacted]';

// Fastify's own `req` serializer, except that a secret in the query string (an invite code in
// `/ui/access/invite?code=…`) is replaced: redaction paths cannot reach inside a URL.
const requestForLog = (req: FastifyRequest) => ({
  method: req.method,
  url: redactSecretQuery(req.url),
  version: String(req.headers['accept-version'] ?? '') || undefined,
  host: req.host,
  remoteAddress: req.ip,
  remotePort: req.socket?.remotePort,
});

export const httpLoggerOptions = (enabled: boolean) =>
  enabled ? { redact: { paths: REDACTED_LOG_PATHS, censor: LOG_CENSOR }, serializers: { req: requestForLog } } : false;

export type HttpSurface = Tenancy & {
  publicDeps: HttpContext['publicDeps'];
  changeBus: Pick<ChangeBus<ChangeEvent>, 'subscribe'>;
};

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
export const buildHttpApp = (surface: HttpSurface, version: string, opts?: HttpOptions): FastifyInstance => {
  // ADR-027 Phase 3: GET /ui/events is a genuinely long-lived connection (SSE) — without this,
  // fastify.close() waits for it to end on its own, which it never does, hanging shutdown for as
  // long as any browser tab has a dashboard open.
  const app = Fastify({
    logger: httpLoggerOptions(opts?.logger ?? true),
    trustProxy: opts?.trustProxy,
    forceCloseConnections: true,
  });
  registerHttpApp(app, surface, version, opts?.auth);
  return app;
};

/** Everything `buildHttpApp` adds to a bare Fastify instance, in the one order that matters: the auth hook
 *  first, so it guards every route registered after it (and any request no route matches). Exported so a
 *  test can attach an `onRoute` listener to the instance before the routes exist. */
export const registerHttpApp = (
  app: FastifyInstance,
  surface: HttpSurface,
  version: string,
  auth: HttpAuth = DISABLED_AUTH,
): void => {
  // Ordering is wiring: the auth hook goes on first, so it runs ahead of every route registered below and
  // also guards a request no route matches.
  registerAuthHook(app, auth);
  registerRoutes(app, { ...surface, version }, surface.changeBus.subscribe, auth);
  registerMcpRoute(app, surface, version, auth.mode === AuthMode.enum.required ? auth.publicUrl : undefined);
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
  surface: HttpSurface,
  version: string,
  port: number,
  host: string = LOOPBACK_HOST,
  opts?: Pick<HttpOptions, 'trustProxy' | 'auth'>,
): Promise<HttpSidecar> => {
  const app = buildHttpApp(surface, version, { ...opts, logger: false });
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

/**
 * The pure-HTTP start (`MCP_TRANSPORT=http`): Fastify with REST + streamable HTTP MCP. Unlike the sidecar, this is the
 * only surface running — a bind failure here is fatal by design (there is no stdio fallback to keep the process alive),
 * handled by the entrypoint.
 */
export const runHttp = (config: Config): ResultAsync<void, DatabaseAhead> =>
  safeTry(async function* () {
    const { runtime, prepared } = yield* boot(config);
    const app = buildHttpApp(runtime, version, { auth: prepared.auth, trustProxy: config.TRUST_PROXY });

    // A repeated signal (or SIGINT followed by SIGTERM) must not double-close/double-exit.
    let shuttingDown = false;
    const shutdown = (): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      app
        .close()
        .catch((err: unknown) => app.log.error(err))
        .finally(() => process.exit(0));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    await app.listen({ port: config.PORT, host: config.HOST });
    // config.PORT may be 0 (OS-assigned); read back the address actually bound for the banner.
    const boundPort = (app.server.address() as AddressInfo).port;
    const origin = httpOrigin(config.HOST, boundPort);
    // eslint-disable-next-line no-console -- HTTP-mode banner; stdout safe.
    console.log(`fintrack: REST ${origin}/api · MCP ${origin}/mcp`);
    await prepared.issueAndAnnounceSetup(origin);
    return ok(undefined);
  });
