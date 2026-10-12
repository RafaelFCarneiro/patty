import type { AddressInfo } from 'node:net';
import { prepareAuth } from './authRuntime.js';
import { version } from './common/buildVersion.js';
import { httpOrigin, LOOPBACK_HOST } from './common/net.js';
import { McpTransport, type Config } from './config.js';
import type { Db } from './diplomat/db/driver.js';
import { AuthMode } from './models/auth.js';
import { createRuntime } from './runtime.js';

/** Where the sign-in page is served while `fintrack login` waits for its approval. */
export type SignInServer = { origin: string; close: () => Promise<void> };

/** Lazy: Fastify and the whole route table load only when a login actually needs to serve the consent page. */
const loadServerModule = () => import('./server.js');

/**
 * Where the browser goes for `fintrack login` (ADR-034 §6): always a temporary app of THIS process — authentication
 * required, no `PUBLIC_URL` — on a free loopback port, closed when the login ends. A server already running on
 * `HOST:PORT` is deliberately not reused: a healthy `/api/health` proves it is FinTrack, not that it opened this
 * database, and a grant written here would never validate there.
 */
export const startSignInServer = async (config: Config, db: Db): Promise<SignInServer> => {
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
  const { buildHttpApp } = await loadServerModule();
  const app = buildHttpApp(
    runtime.deps,
    version,
    runtime.runEffects,
    runtime.runEffectsSequence,
    runtime.resetLocale,
    runtime.changeBus.subscribe,
    { logger: false, auth, trustProxy: config.TRUST_PROXY },
  );
  await app.listen({ port: 0, host: LOOPBACK_HOST });
  const { port } = app.server.address() as AddressInfo;
  return { origin: httpOrigin(LOOPBACK_HOST, port), close: () => app.close() };
};
