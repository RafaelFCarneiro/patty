import { err, ok, type Result } from 'neverthrow';
import { demoConfig, DEMO_DB_PATH, loadConfig, osLocale } from '../config.js';
import { formatAppError } from '../common/errors.js';
import { isPortInUse } from '../common/net.js';
import type { DemoShell } from '../diplomat/cli/io.js';
import { bootstrap } from '../diplomat/db/bootstrap.js';
import {
  canonicalPath,
  databaseExists,
  isSymlink,
  probeDatabase,
  removeDatabaseFiles,
} from '../diplomat/db/database-files.js';
import { closeDatabase, openDatabaseWithKey } from '../diplomat/db/driver.js';
import { resolveDemoCountry } from '../logic/demo.js';
import { failureOfSeedStatus, planDemoDatabase } from '../logic/demo-database.js';
import { startupRefusalMessage } from '../models/startup.js';
import {
  DEMO_DB_KEY,
  DemoFailureCode,
  DemoProbeAbsence,
  demoFailures,
  type DemoCountry,
  type DemoDatabaseFacts,
  type DemoFailure,
  type DemoSeedStatus,
} from '../models/demo.js';
import { seedDemo } from './demo-seed.js';

/**
 * Composition root of `fintrack demo`, as a sequence: look at the file at the demo path, decide (pure,
 * `logic/demo-database.ts`) what may be done with it, delete / seed / clean up, and map the outcome to what the CLI
 * reports. The demo never reads or writes the real `DB_PATH`, and the only file it ever deletes is a database that
 * says, inside itself, that it is a demo.
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

const seedFailure = (reason: string): DemoFailure => demoFailures.of(DemoFailureCode.enum.seed_failed, reason);

/** Look: what the demo path is. The real database is never opened, not even to look at it. */
const lookAtDatabase = async (
  databasePath: string,
  realDatabasePath: string,
  reset: boolean,
): Promise<DemoDatabaseFacts> => {
  const demo = canonicalPath(databasePath);
  const real = canonicalPath(realDatabasePath);
  const isRealDatabase = demo === null || real === null || demo === real;
  const isAlias = isSymlink(databasePath);
  const { probe, holdsData } =
    isRealDatabase || isAlias
      ? { probe: DemoProbeAbsence.enum.missing, holdsData: false }
      : await probeDatabase(databasePath);
  return { isRealDatabase, isAlias, reset, probe, holdsData };
};

type SeedRun = { seed: typeof seedDemo; databasePath: string; country: DemoCountry; today: Date };

const seedDatabase = async ({ seed, databasePath, country, today }: SeedRun) => {
  const db = await openDatabaseWithKey({ DB_PATH: databasePath }, DEMO_DB_KEY);
  try {
    const bootstrapped = await bootstrap(db);
    if (bootstrapped.isErr()) return err(seedFailure(startupRefusalMessage(bootstrapped.error)));
    const seeded = await seed(db, { country, today, config: demoConfig(databasePath) });
    return seeded.map((report) => report.status).mapErr((error) => seedFailure(formatAppError(error)));
  } finally {
    closeDatabase(db);
  }
};

/** A seed that fails or throws on a database created by this very run leaves nothing behind: half a demo is worse than
 *  none. A database that was already there is not ours to delete. */
const seedOrClean = async (run: SeedRun, createdHere: boolean): Promise<Result<DemoSeedStatus, DemoFailure>> => {
  try {
    const seeded = await seedDatabase(run);
    if (seeded.isErr() && createdHere) removeDatabaseFiles(run.databasePath);
    return seeded;
  } catch (cause) {
    if (createdHere) removeDatabaseFiles(run.databasePath);
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
    hasDatabase: () => databaseExists(databasePath),
    prepare: async (request) => {
      const plan = planDemoDatabase(await lookAtDatabase(databasePath, realDatabasePath(), request.reset));
      if (plan.isErr()) return err(demoFailures.of(plan.error));
      if (plan.value.deleteFirst) removeDatabaseFiles(databasePath);

      const country = request.country ?? resolveDemoCountry(osLocale());
      const status = await seedOrClean({ seed, databasePath, country, today: today() }, plan.value.createdHere);
      return status.andThen((seeded) => {
        const failure = failureOfSeedStatus(seeded);
        return failure === null ? ok({ status: seeded, databasePath, country }) : err(demoFailures.of(failure));
      });
    },
    serve: async () => {
      try {
        const { runHttp } = await loadHttpModule();
        const started = await runHttp(demoConfig(databasePath));
        return started.mapErr((refusal) =>
          demoFailures.of(DemoFailureCode.enum.start_failed, startupRefusalMessage(refusal)),
        );
      } catch (cause) {
        if (isPortInUse(cause)) return err(demoFailures.of(DemoFailureCode.enum.port_in_use));
        throw cause;
      }
    },
  };
};
