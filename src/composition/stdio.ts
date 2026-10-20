import type { AddressInfo } from 'node:net';
import { ok, safeTry, type ResultAsync } from 'neverthrow';
import { version } from '../common/buildVersion.js';
import { httpOrigin } from '../common/net.js';
import type { Config } from '../config.js';
import { connectStdio, type StdioAuth } from '../diplomat/mcp/stdio.js';
import { signInOrigin } from '../logic/auth/origin.js';
import type { DatabaseAhead } from '../models/database.js';
import { AuthMode } from '../models/auth/mode.js';
import type { HttpAuth } from '../diplomat/http/context.js';
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

/**
 * The stdio start (ADR-007): the MCP server on stdin/stdout, the HTTP sidecar beside it unless `FINTRACK_HTTP=false`,
 * and the channel's identity — a sign-in session, or the owner under an explicit `FINTRACK_AUTH=disabled`.
 */
export const runStdio = (config: Config): ResultAsync<void, DatabaseAhead> =>
  safeTry(async function* () {
    const { runtime, prepared } = yield* boot(config);
    const { auth, issueAndAnnounceSetup } = prepared;

    // The page the sign-in link may name from what is known here (decided in `logic/auth/origin.ts`); with none, the
    // session serves `/ui/connect` itself from a temporary server on this database. The sidecar binds later.
    let boundOrigin: string | null = null;
    const linkOrigin = (): string | null =>
      signInOrigin({
        httpEnabled: config.FINTRACK_HTTP,
        publicUrl: config.PUBLIC_URL,
        boundOrigin,
        host: config.HOST,
      });

    const { stdio } = prepared;
    const stdioAuth: StdioAuth = stdio
      ? {
          mode: AuthMode.enum.required,
          profile: config.FINTRACK_PROFILE,
          envToken: config.FINTRACK_TOKEN,
          signIn: (profile) => stdio.signIn(profile, linkOrigin),
        }
      : { mode: AuthMode.enum.disabled };

    const { server, session } = await connectStdio(runtime, version, stdioAuth);

    // A bind failure inside startHttpSidecar is caught there and is never fatal — the stdio server keeps working.
    const sidecar = await maybeStartSidecar(config, runtime, auth);
    // The setup code is issued and printed only now, naming the origin the sidecar really bound. If it did not
    // bind (another process owns the port and has announced its own code) this process must not replace that
    // code with one nobody sees.
    if (sidecar?.listening) {
      boundOrigin = httpOrigin(config.HOST, (sidecar.app.server.address() as AddressInfo).port);
      await issueAndAnnounceSetup(boundOrigin);
    }

    // 'close' commonly follows 'end' on stdin, and a client can also send SIGINT/SIGTERM around
    // the same disconnect — guard against shutdown() running (and double process.exit-ing) twice.
    let shuttingDown = false;
    const shutdown = (): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      void Promise.allSettled([
        server.close().catch((err: unknown) => console.error(err)),
        sidecar?.listening ? sidecar.app.close().catch((err: unknown) => console.error(err)) : Promise.resolve(),
        // A "this session only" sign-in ends with the session (best effort — its 12-hour cap covers a crash).
        session?.close(),
      ]).finally(() => process.exit(0));
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    // stdin end/close = client disconnected; route through shutdown to drain in-flight work
    process.stdin.once('end', shutdown);
    process.stdin.once('close', shutdown);
    return ok(undefined);
  });
