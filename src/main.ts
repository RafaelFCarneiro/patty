#!/usr/bin/env node
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AddressInfo } from 'node:net';
import { prepareAuth } from './authRuntime.js';
import { version } from './common/buildVersion.js';
import { httpOrigin, isPortInUse, portInUseMessage } from './common/net.js';
import { loadConfig, McpTransport, type Config } from './config.js';
import type { Deps, RunEffects, RunEffectsSequence } from './controllers/deps.js';
import { keychainSignInStore } from './diplomat/auth/signInStore.js';
import { bootstrap } from './diplomat/db/bootstrap.js';
import { openDatabase } from './diplomat/db/driver.js';
import { DatabaseAheadError } from './diplomat/db/versionGuard.js';
import type { HttpAuth } from './diplomat/http/context.js';
import { ownerGate } from './diplomat/mcp/gate.js';
import { connectStdio } from './diplomat/mcp/stdio.js';
import { createStdioSession } from './diplomat/mcp/stdioSession.js';
import { dbIdOf, keychainAccount } from './logic/auth/keychain.js';
import { signInOrigin } from './logic/auth/origin.js';
import { createRuntime } from './runtime.js';
import { startSignInServer } from './signInServer.js';
import type { ChangeBus } from '@rfc0/effect-runner';
import type { HttpSidecar } from './server.js';

/**
 * Lazily imports the HTTP composition module (server.ts) so Fastify — and the whole REST /
 * MCP-over-HTTP route table it wires up — is never loaded during the default stdio-only
 * startup path, only when the sidecar is enabled or MCP_TRANSPORT=http actually needs it.
 * Isolated here as one named function instead of an inline import() at each call site.
 */
const loadServerModule = () => import('./server.js');

const loadCliModule = () => import('./cli.js');

const maybeStartSidecar = async (
  deps: Deps,
  version: string,
  runEffects: RunEffects,
  runEffectsSequence: RunEffectsSequence,
  resetLocale: () => void,
  subscribeToChanges: ChangeBus['subscribe'],
  config: Config,
  auth: HttpAuth,
): Promise<HttpSidecar | null> => {
  if (!config.FINTRACK_HTTP) return null;
  const { startHttpSidecar } = await loadServerModule();
  return startHttpSidecar(
    deps,
    version,
    runEffects,
    runEffectsSequence,
    resetLocale,
    subscribeToChanges,
    config.PORT,
    config.HOST,
    { auth, trustProxy: config.TRUST_PROXY },
  );
};

const main = async (): Promise<void> => {
  // Any argument is a command: an unknown one is a usage error, never a reason to start a server.
  if (process.argv.length > 2) {
    const { runCli } = await loadCliModule();
    // Not process.exit: let the event loop drain, so everything the command printed has been flushed.
    process.exitCode = await runCli(process.argv.slice(2));
    return;
  }

  const config = loadConfig();

  const db = await openDatabase(config);
  await bootstrap(db);

  const runtime = createRuntime(db, config);
  const { deps, runEffects: boundRunEffects, runEffectsSequence: boundRunEffectsSequence, resetLocale } = runtime;

  // Sessions guard the HTTP surface; the stdio channel signs in too (ADR-034), unless auth is explicitly disabled.
  const prepared = await prepareAuth(config, db, boundRunEffects);
  const { auth, issueAndAnnounceSetup } = prepared;

  if (config.MCP_TRANSPORT === McpTransport.enum.stdio) {
    // The page the sign-in link may name from what is known here (decided in `logic/auth.ts`); with none, the
    // session serves `/ui/connect` itself from a temporary server on this database. The sidecar binds later.
    let boundOrigin: string | null = null;
    const linkOrigin = (): string | null =>
      signInOrigin({
        httpEnabled: config.FINTRACK_HTTP,
        publicUrl: config.PUBLIC_URL,
        boundOrigin,
        host: config.HOST,
      });

    // The connected server reports who spawned it (`initialize`'s clientInfo); the session asks only when it needs to.
    const connected: { server?: McpServer } = {};
    const session = prepared.stdio
      ? createStdioSession({
          deps: prepared.stdio.deps,
          run: prepared.stdio.run,
          profile: config.FINTRACK_PROFILE,
          envToken: config.FINTRACK_TOKEN,
          store: keychainSignInStore(
            keychainAccount(config.FINTRACK_PROFILE, dbIdOf(prepared.stdio.deps.secrets.hashSecret(config.DB_PATH))),
          ),
          origin: linkOrigin,
          temporaryServer: config.FINTRACK_HTTP ? () => startSignInServer(config, db) : undefined,
          clientInfo: () => connected.server?.server.getClientVersion(),
        })
      : undefined;

    const server = await connectStdio(deps, version, boundRunEffects, boundRunEffectsSequence, resetLocale, {
      gate: session ? () => session.resolve() : ownerGate,
    });
    connected.server = server;

    // A bind failure inside startHttpSidecar is caught there and is never fatal — the stdio
    const sidecar = await maybeStartSidecar(
      deps,
      version,
      boundRunEffects,
      boundRunEffectsSequence,
      resetLocale,
      runtime.changeBus.subscribe,
      config,
      auth,
    );
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
    return;
  }

  // MCP_TRANSPORT === 'http': start Fastify with REST + streamable HTTP MCP. Unlike the
  // sidecar, this is the only surface running — a bind failure here is fatal by design
  // (there is no stdio fallback to keep the process alive), handled below in main().catch.
  const { buildHttpApp } = await loadServerModule();
  const app = buildHttpApp(
    deps,
    version,
    boundRunEffects,
    boundRunEffectsSequence,
    resetLocale,
    runtime.changeBus.subscribe,
    { auth, trustProxy: config.TRUST_PROXY },
  );

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
  await issueAndAnnounceSetup(origin);
};

main().catch((e: unknown) => {
  if (isPortInUse(e)) {
    console.error(portInUseMessage(e));
    process.exit(1);
  }
  // Already a complete, actionable diagnosis — a stack trace would only bury it.
  console.error(e instanceof DatabaseAheadError ? e.message : e);
  process.exit(1);
});
