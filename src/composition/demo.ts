import { existsSync, realpathSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { err, ok, type Result } from 'neverthrow';
import { demoConfig, DEMO_DB_PATH, loadConfig } from '../config.js';
import { isPortInUse } from '../common/net.js';
import type { DemoShell } from '../diplomat/cli/io.js';
import { bootstrap } from '../diplomat/db/bootstrap.js';
import { closeDatabase, openDatabaseWithKey } from '../diplomat/db/driver.js';
import { instanceRepo } from '../diplomat/db/repos/instance.js';
import { resolveDemoCountry } from '../logic/demo.js';
import { planDemoDatabase } from '../logic/demo-database.js';
import { databaseAheadMessage } from '../models/database.js';
import {
  DEMO_DB_KEY,
  DemoFailureCode,
  demoFailures,
  type DemoCountry,
  type DemoFailure,
  type DemoProbe,
  type DemoSeedStatus,
} from '../models/demo.js';
import { formatAppError } from '../common/errors.js';
import { seedDemo } from './demo-seed.js';

/**
 * Composition root of `fintrack demo`: looks at the file at the demo path, decides (pure, `logic/demo-database.ts`)
 * whether it may be reset, seeds it through the write flows, and serves it. The demo never reads or writes the real
 * `DB_PATH`, and the only file it ever deletes is a database that says, inside itself, that it is a demo.
 */

// Fastify loads only for the one command that serves: the CLI's other commands never pay for it.
const loadHttpModule = () => import('./http.js');

export type DemoShellOptions = {
  /** The demo database; the real `DB_PATH` by default is never this. Overridable for tests. */
  databasePath?: string;
  /** The real install's database, which the demo must never touch. */
  realDatabasePath?: () => string;
  today?: () => Date;
  /** The seeder, `seedDemo` unless a test needs a seed that fails. */
  seed?: typeof seedDemo;
};

const OS_LOCALE_VARIABLES = ['LC_ALL', 'LC_MESSAGES', 'LANG'] as const;
const DATABASE_FILE_SUFFIXES = ['', '-wal', '-shm', '-journal'] as const;

const osLocale = (): string | undefined =>
  OS_LOCALE_VARIABLES.map((name) => process.env[name]).find((value) => value) ??
  Intl.DateTimeFormat().resolvedOptions().locale;

/** The same file through symlinks and relative spellings: a path that does not exist yet is only resolved. */
const canonicalPath = (path: string): string => (existsSync(path) ? realpathSync(path) : resolve(path));

const removeDatabaseFiles = (databasePath: string): void =>
  DATABASE_FILE_SUFFIXES.forEach((suffix) => rmSync(`${databasePath}${suffix}`, { force: true }));

/** What the file at `databasePath` says it is, from opening it with the demo key — nothing is migrated or written. A
 *  file that does not open that way (another key, not a database, a schema without the marker) is not a demo. */
const probeDatabase = async (databasePath: string): Promise<DemoProbe> => {
  if (!existsSync(databasePath)) return 'missing';
  try {
    const db = await openDatabaseWithKey({ DB_PATH: databasePath }, DEMO_DB_KEY);
    try {
      return await instanceRepo(db).kind();
    } finally {
      closeDatabase(db);
    }
  } catch {
    return 'unreadable';
  }
};

type SeedRequest = { country: DemoCountry };

const seedFailure = (reason: string): DemoFailure => demoFailures.of(DemoFailureCode.enum.seed_failed, reason);

const seedDatabase = async (
  seed: typeof seedDemo,
  databasePath: string,
  request: SeedRequest,
  today: Date,
): Promise<Result<DemoSeedStatus, DemoFailure>> => {
  const db = await openDatabaseWithKey({ DB_PATH: databasePath }, DEMO_DB_KEY);
  try {
    const bootstrapped = await bootstrap(db);
    if (bootstrapped.isErr()) return err(seedFailure(databaseAheadMessage(bootstrapped.error.version)));
    const seeded = await seed(db, { country: request.country, today, config: demoConfig(databasePath) });
    return seeded.map((report) => report.status).mapErr((error) => seedFailure(formatAppError(error)));
  } finally {
    closeDatabase(db);
  }
};

const FAILURE_OF_STATUS: Readonly<Record<DemoSeedStatus, DemoFailureCode | null>> = {
  seeded: null,
  present: null,
  interrupted: DemoFailureCode.enum.interrupted,
  not_demo: DemoFailureCode.enum.not_demo,
};

/** A seed that fails or throws on a database created by this very run leaves nothing behind: half a demo is worse than
 *  none. A database that was already there is not ours to delete. */
const seedOrClean = async (
  seed: typeof seedDemo,
  databasePath: string,
  request: SeedRequest,
  today: Date,
  createdHere: boolean,
): Promise<Result<DemoSeedStatus, DemoFailure>> => {
  try {
    const seeded = await seedDatabase(seed, databasePath, request, today);
    if (seeded.isErr() && createdHere) removeDatabaseFiles(databasePath);
    return seeded;
  } catch (cause) {
    if (createdHere) removeDatabaseFiles(databasePath);
    throw cause;
  }
};

export const createDemoShell = (options: DemoShellOptions = {}): DemoShell => {
  const databasePath = options.databasePath ?? DEMO_DB_PATH;
  const realDatabasePath = options.realDatabasePath ?? (() => loadConfig().DB_PATH);
  const today = options.today ?? (() => new Date());
  const seed = options.seed ?? seedDemo;

  return {
    databasePath,
    prepare: async (request) => {
      const isRealDatabase = canonicalPath(databasePath) === canonicalPath(realDatabasePath());
      // The real database is never opened, not even to look at it.
      const probe = isRealDatabase ? 'missing' : await probeDatabase(databasePath);
      const plan = planDemoDatabase({ isRealDatabase, reset: request.reset, probe });
      if (plan.isErr()) return err(demoFailures.of(plan.error));
      if (plan.value.deleteFirst) removeDatabaseFiles(databasePath);

      const createdHere = probe === 'missing' || plan.value.deleteFirst;
      const country = request.country ?? resolveDemoCountry(osLocale());
      const status = await seedOrClean(seed, databasePath, { country }, today(), createdHere);
      return status.andThen((seeded) => {
        const failure = FAILURE_OF_STATUS[seeded];
        return failure === null ? ok({ status: seeded, databasePath, country }) : err(demoFailures.of(failure));
      });
    },
    serve: async () => {
      try {
        const { runHttp } = await loadHttpModule();
        const started = await runHttp(demoConfig(databasePath));
        return started.mapErr((ahead) => seedFailure(databaseAheadMessage(ahead.version)));
      } catch (cause) {
        if (isPortInUse(cause)) return err(demoFailures.of(DemoFailureCode.enum.port_in_use));
        throw cause;
      }
    },
  };
};
