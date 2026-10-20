import type { AddressInfo } from 'node:net';
import { ok, safeTry, type ResultAsync } from 'neverthrow';
import { version } from '../common/buildVersion.js';
import { httpOrigin } from '../common/net.js';
import type { Config } from '../config.js';
import { connectStdio, type StdioAuth, type StdioConnection } from '../diplomat/mcp/stdio.js';
import { signInOrigin } from '../logic/auth/origin.js';
import type { DatabaseAhead } from '../models/database.js';
import { AuthMode } from '../models/auth/mode.js';
import type { HttpAuth } from '../diplomat/http/context.js';
import type { PreparedAuth } from './auth.js';
import { boot } from './boot.js';
import type { HttpSidecar } from './http.js';
import type { Runtime } from './runtime.js';

/**
 * Lazily imports the HTTP composition module so Fastify — and the whole REST / MCP-over-HTTP route table it wires
 * up — is never loaded during the default stdio-only startup path, only when the sidecar is enabled.
 */
const loadHttpModule = () => import('./http.js');

const maybeStartSidecar = async (config: Config, runtime: Runtime, auth: HttpAuth): Promise<HttpSidecar | null> => {
  if (!config.FINTRACK_HTTP) return null;
  const { startHttpSidecar } = await loadHttpModule();
  return startHttpSidecar(runtime, version, config.PORT, config.HOST, { auth, trustProxy: config.TRUST_PROXY });
};

/** The page the sign-in link may name from what is known here (decided in `logic/auth/origin.ts`); with none, the
 *  session serves `/ui/connect` itself from a temporary server on this database. The sidecar binds later. */
const signInLink = (config: Config) => {
  let boundOrigin: string | null = null;
  return {
    origin: (): string | null =>
      signInOrigin({
        httpEnabled: config.FINTRACK_HTTP,
        publicUrl: config.PUBLIC_URL,
        boundOrigin,
        host: config.HOST,
      }),
    bind: (origin: string): void => {
      boundOrigin = origin;
    },
  };
};

const stdioAuthFor = (config: Config, stdio: PreparedAuth['stdio'], linkOrigin: () => string | null): StdioAuth =>
  stdio
    ? {
        mode: AuthMode.enum.required,
        profile: config.FINTRACK_PROFILE,
        envToken: config.FINTRACK_TOKEN,
        signIn: (profile) => stdio.signIn(profile, linkOrigin),
      }
    : { mode: AuthMode.enum.disabled };

const closeLogged = (closing: Promise<void>): Promise<void> => closing.catch((err: unknown) => console.error(err));

// 'close' commonly follows 'end' on stdin, and a client can also send SIGINT/SIGTERM around
// the same disconnect — guard against shutdown() running (and double process.exit-ing) twice.
const shutdownOf = ({ server, session }: StdioConnection, sidecar: HttpSidecar | null): (() => void) => {
  let shuttingDown = false;
  return (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void Promise.allSettled([
      closeLogged(server.close()),
      sidecar?.listening ? closeLogged(sidecar.app.close()) : Promise.resolve(),
      // A "this session only" sign-in ends with the session (best effort — its 12-hour cap covers a crash).
      session?.close(),
    ]).finally(() => process.exit(0));
  };
};

const shutDownOnDisconnect = (shutdown: () => void): void => {
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  // stdin end/close = client disconnected; route through shutdown to drain in-flight work
  process.stdin.once('end', shutdown);
  process.stdin.once('close', shutdown);
};

/**
 * The stdio start (ADR-007): the MCP server on stdin/stdout, the HTTP sidecar beside it unless `FINTRACK_HTTP=false`,
 * and the channel's identity — a sign-in session, or the owner under an explicit `FINTRACK_AUTH=disabled`.
 */
export const runStdio = (config: Config): ResultAsync<void, DatabaseAhead> =>
  safeTry(async function* () {
    const { runtime, prepared } = yield* boot(config);
    const link = signInLink(config);
    const connection = await connectStdio(runtime, version, stdioAuthFor(config, prepared.stdio, link.origin));

    // A bind failure inside startHttpSidecar is caught there and is never fatal — the stdio server keeps working.
    const sidecar = await maybeStartSidecar(config, runtime, prepared.auth);
    // The setup code is issued and printed only now, naming the origin the sidecar really bound. If it did not
    // bind (another process owns the port and has announced its own code) this process must not replace that
    // code with one nobody sees.
    if (sidecar?.listening) {
      const boundOrigin = httpOrigin(config.HOST, (sidecar.app.server.address() as AddressInfo).port);
      link.bind(boundOrigin);
      await prepared.issueAndAnnounceSetup(boundOrigin);
    }

    shutDownOnDisconnect(shutdownOf(connection, sidecar));
    return ok(undefined);
  });
