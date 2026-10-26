import type { AddressInfo } from 'node:net';
import { ok, safeTry, type ResultAsync } from 'neverthrow';
import { version } from '../common/build-version.js';
import { httpOrigin } from '../common/net.js';
import type { Config } from '../config.js';
import { connectStdio, type StdioAuth, type StdioConnection } from '../diplomat/mcp/stdio.js';
import { signInOrigin } from '../logic/auth/origin.js';
import type { StartupRefusal } from '../models/startup.js';
import { AuthMode } from '../models/auth/mode.js';
import type { HttpAuth } from '../diplomat/http/context.js';
import type { PreparedAuth } from './auth.js';
import { boot } from './boot.js';
import type { HttpSidecar } from './http.js';
import type { Runtime } from './runtime.js';
import { loadHttpModule } from './lazy-modules.js';

const maybeStartSidecar = async (config: Config, runtime: Runtime, auth: HttpAuth): Promise<HttpSidecar | null> => {
  if (!config.FINTRACK_HTTP) return null;
  const { startHttpSidecar } = await loadHttpModule();
  return startHttpSidecar(runtime, version, config.PORT, config.HOST, { auth, trustProxy: config.TRUST_PROXY });
};

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

const shutdownOf = ({ server, session }: StdioConnection, sidecar: HttpSidecar | null): (() => void) => {
  let shuttingDown = false;
  return (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void Promise.allSettled([
      closeLogged(server.close()),
      sidecar?.listening ? closeLogged(sidecar.app.close()) : Promise.resolve(),
      session?.close(),
    ]).finally(() => process.exit(0));
  };
};

const shutDownOnDisconnect = (shutdown: () => void): void => {
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  process.stdin.once('end', shutdown);
  process.stdin.once('close', shutdown);
};

export const runStdio = (config: Config): ResultAsync<void, StartupRefusal> =>
  safeTry(async function* () {
    const { runtime, prepared } = yield* boot(config);
    const link = signInLink(config);
    const connection = await connectStdio(runtime, version, stdioAuthFor(config, prepared.stdio, link.origin));

    const sidecar = await maybeStartSidecar(config, runtime, prepared.auth);
    if (sidecar?.listening) {
      const boundOrigin = httpOrigin(config.HOST, (sidecar.app.server.address() as AddressInfo).port);
      link.bind(boundOrigin);
      await prepared.issueAndAnnounceSetup(boundOrigin);
    }

    shutDownOnDisconnect(shutdownOf(connection, sidecar));
    return ok(undefined);
  });
