import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { prepareAuth } from './authRuntime.js';
import { version } from './common/buildVersion.js';
import { httpOrigin, isPortInUse } from './common/net.js';
import { McpTransport, type Config } from './config.js';
import type { Db } from './diplomat/db/driver.js';
import { HEALTH_PATH } from './diplomat/http/authPaths.js';
import { AuthMode } from './models/auth.js';
import { createRuntime } from './runtime.js';
import { HealthOut } from './wire/out/status.js';

/** Where the sign-in page is served while `fintrack login` waits for its approval. */
export type SignInServer = { origin: string; close: () => Promise<void> };

const PROBE_TIMEOUT_MS = 1500;

/** Is a FinTrack HTTP server answering at `origin`? Only its public liveness route is asked, and only the shape of
 *  the answer is trusted — a stranger on the port is not mistaken for one. */
const answersAsFinTrack = async (origin: string): Promise<boolean> => {
  try {
    const response = await fetch(`${origin}${HEALTH_PATH}`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    return response.ok && HealthOut.safeParse(await response.json()).success;
  } catch {
    return false;
  }
};

const listenOnPreferredPort = async (app: FastifyInstance, config: Pick<Config, 'HOST' | 'PORT'>): Promise<number> => {
  try {
    await app.listen({ port: config.PORT, host: config.HOST });
  } catch (cause) {
    // Something that is not FinTrack holds the configured port: any free one serves a one-off sign-in just as well.
    if (!isPortInUse(cause)) throw cause;
    await app.listen({ port: 0, host: config.HOST });
  }
  return (app.server.address() as AddressInfo).port;
};

/**
 * The origin to send the person to for `fintrack login` (ADR-034 §6). A running FinTrack on `HOST:PORT` already serves
 * `/ui/connect` from this same database, so it is used as is. With none running, a temporary loopback app —
 * authentication required, no `PUBLIC_URL` — serves it for as long as the login takes and is then closed.
 */
export const startSignInServer = async (config: Config, db: Db): Promise<SignInServer> => {
  const running = httpOrigin(config.HOST, config.PORT);
  if (await answersAsFinTrack(running)) return { origin: config.PUBLIC_URL ?? running, close: async () => undefined };

  const runtime = createRuntime(db, config);
  const { auth } = await prepareAuth(
    {
      ...config,
      FINTRACK_AUTH: AuthMode.enum.required,
      PUBLIC_URL: undefined,
      MCP_TRANSPORT: McpTransport.enum.http,
      FINTRACK_HTTP: true,
    },
    db,
    runtime.runEffects,
  );
  const { buildHttpApp } = await import('./server.js');
  const app = buildHttpApp(
    runtime.deps,
    version,
    runtime.runEffects,
    runtime.runEffectsSequence,
    runtime.resetLocale,
    runtime.changeBus.subscribe,
    { logger: false, auth, trustProxy: config.TRUST_PROXY },
  );
  const port = await listenOnPreferredPort(app, config);
  return { origin: httpOrigin(config.HOST, port), close: () => app.close() };
};
