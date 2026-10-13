import { runEffects } from '@rfc0/effect-runner';
import { AUTH_APPLIERS, bindAuthRunEffects, createAuthDeps } from './authRuntime.js';
import { version } from './common/buildVersion.js';
import { loadConfig } from './config.js';
import { clientConfigs } from './diplomat/clientConfig/clients.js';
import { type CliIo, type Shell } from './diplomat/cli/io.js';
import * as tty from './diplomat/cli/terminal.js';
import { bootstrap } from './diplomat/db/bootstrap.js';
import { closeDatabase, openDatabase } from './diplomat/db/driver.js';
import { createEngineContext } from './diplomat/db/engine.js';
import { AuthMode } from './models/auth/mode.js';
import { createSignInFor } from './signInWiring.js';

/**
 * Composition root of the command mode (`setup`, `auth …`, `login`, `logout`): the one place that joins the database,
 * the keychain, the terminal and the client config files into the `CliIo` the commands in `diplomat/cli` are written
 * against. Loaded lazily by `main.ts`, so a server start never pays for it.
 */

const openShell = async (): Promise<Shell> => {
  const config = loadConfig();
  const db = await openDatabase(config);
  try {
    await bootstrap(db);
  } catch (cause) {
    closeDatabase(db);
    throw cause;
  }
  const engineContext = createEngineContext(db);
  const deps = await createAuthDeps(db);
  const run = bindAuthRunEffects((flow) => runEffects(engineContext, AUTH_APPLIERS, flow));
  return {
    deps,
    run,
    close: () => closeDatabase(db),
    authRequired: config.FINTRACK_AUTH === AuthMode.enum.required,
    defaultProfile: config.FINTRACK_PROFILE,
    // `login` never reuses a server already on HOST:PORT: it names no page and serves its own, on this database.
    signIn: (profile) =>
      createSignInFor({ config, db, deps, run }, { profile, origin: () => null, canServePage: true }),
  };
};

const waitOrAbort = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
  });

const interruptSignal = (): AbortSignal => {
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  return controller.signal;
};

export const defaultCliIo = (): CliIo => ({
  openShell,
  openTerminal: () => (tty.isInteractive() ? tty.open() : null),
  readPasswordFromStdin: tty.readPasswordFromStdin,
  out: tty.printResult,
  err: tty.printDiagnostic,
  version,
  wait: waitOrAbort,
  interruptSignal,
  clients: clientConfigs,
});
