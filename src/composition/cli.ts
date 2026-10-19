import { runEffects } from '@rfc0/effect-runner';
import { err, ok, ResultAsync, type Result } from 'neverthrow';
import { AUTH_APPLIERS, bindAuthRunEffects, createAuthDeps } from './auth.js';
import { version } from '../common/buildVersion.js';
import { loadConfig } from '../config.js';
import { clientConfigs } from '../diplomat/clientConfig/clients.js';
import { runCli } from '../diplomat/cli/commands.js';
import { type CliIo, type Shell } from '../diplomat/cli/io.js';
import * as tty from '../diplomat/cli/terminal.js';
import { bootstrap } from '../diplomat/db/bootstrap.js';
import { closeDatabase, openDatabase, type Db } from '../diplomat/db/driver.js';
import { createEngineContext } from '../diplomat/db/engine.js';
import type { DatabaseAhead } from '../models/database.js';
import { AuthMode } from '../models/auth/mode.js';
import { createSignInFor } from './signIn/wiring.js';

/**
 * Composition root of the command mode (`setup`, `auth …`, `login`, `logout`): the one place that joins the database,
 * the keychain, the terminal and the client config files into the `CliIo` the commands in `diplomat/cli` are written
 * against. Loaded lazily by `main.ts`, so a server start never pays for it.
 */

/** Bootstraps, closing the database when that fails — by refusal or by throwing. */
const bootstrapOrClose = async (db: Db): Promise<Result<void, DatabaseAhead>> => {
  try {
    return await bootstrap(db);
  } catch (cause) {
    closeDatabase(db);
    throw cause;
  }
};

const openShell = async (): Promise<Result<Shell, DatabaseAhead>> => {
  const config = loadConfig();
  const db = await openDatabase(config);
  const bootstrapped = await bootstrapOrClose(db);
  if (bootstrapped.isErr()) {
    closeDatabase(db);
    return err(bootstrapped.error);
  }
  const engineContext = createEngineContext(db);
  const deps = await createAuthDeps(db);
  const run = bindAuthRunEffects((flow) => runEffects(engineContext, AUTH_APPLIERS, flow));
  return ok({
    deps,
    run,
    close: () => closeDatabase(db),
    authRequired: config.FINTRACK_AUTH === AuthMode.enum.required,
    defaultProfile: config.FINTRACK_PROFILE,
    // The CLI binds nothing, so HOST:PORT is not known to serve THIS database: only a configured origin is named.
    inviteOrigin: config.PUBLIC_URL ?? null,
    // `login` never reuses a server already on HOST:PORT: it names no page and serves its own, on this database.
    signIn: (profile) =>
      createSignInFor({ config, db, deps, run }, { profile, origin: () => null, canServePage: true }),
  });
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

const defaultCliIo = (): CliIo => ({
  openShell: () => new ResultAsync(openShell()),
  openTerminal: () => (tty.isInteractive() ? tty.open() : null),
  readPasswordFromStdin: tty.readPasswordFromStdin,
  out: tty.printResult,
  err: tty.printDiagnostic,
  version,
  wait: waitOrAbort,
  interruptSignal,
  clients: clientConfigs,
});

/** The command line, ready to run: the router bound to the real terminal, database, keychain and config files. */
export const runCommandLine = (args: readonly string[]): Promise<number> => runCli(args, defaultCliIo());
