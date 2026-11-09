import type { AddressInfo } from 'node:net';
import { prepareAuth, type AuthConfig } from '../auth.js';
import { version } from '../../common/build-version.js';
import { httpOrigin, LOCALHOST_NAME } from '../../common/net.js';
import { McpTransport } from '../../config.js';
import type { SignInServer } from '../../controllers/deps.js';
import type { Db } from '../../diplomat/db/driver.js';
import { AuthMode } from '../../models/auth/mode.js';
import { createRuntime } from '../runtime.js';

/** Lazy: Fastify and the whole route table load only when a login actually needs to serve the consent page. */
const loadServerModule = () => import('../http.js');

/**
 * Where the browser goes when a sign-in has no honest page of its own to name — `patty login` (ADR-034 §6), and a
 * stdio session whose sidecar is not serving a valid link: always a temporary app of THIS process — authentication
 * required, no `PUBLIC_URL` — on a free loopback port, closed when the login ends. A server already running on
 * `HOST:PORT` is deliberately not reused: a healthy `/api/health` proves it is PATTY, not that it opened this
 * database, and a grant written here would never validate there.
 */
export const startSignInServer = async (config: AuthConfig, db: Db): Promise<SignInServer> => {
  const runtime = createRuntime(db, config);
  const { auth } = await prepareAuth(
    {
      ...config,
      PATTY_AUTH: AuthMode.enum.required,
      PUBLIC_URL: undefined,
      MCP_TRANSPORT: McpTransport.enum.http,
      PATTY_HTTP: true,
    },
    db,
    runtime.authRunEffects,
  );
  const { buildHttpApp } = await loadServerModule();
  const app = buildHttpApp(runtime, version, { logger: false, auth, trustProxy: config.TRUST_PROXY });
  // Loopback only, but under the NAME `localhost`: the session cookie is keyed by host, not port, so on `127.0.0.1`
  // this login would overwrite the cookie of any PATTY already open there and sign its dashboard out.
  // Fastify binds `localhost` to both its IPv4 and IPv6 loopback addresses.
  await app.listen({ port: 0, host: LOCALHOST_NAME }).catch(async (cause: unknown) => {
    await app.close();
    throw cause;
  });
  const { port } = app.server.address() as AddressInfo;
  return { origin: httpOrigin(LOCALHOST_NAME, port), close: () => app.close() };
};
