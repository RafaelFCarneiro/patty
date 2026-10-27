import { err, ok, type Result } from 'neverthrow';
import { demoConfig, DEMO_DB_PATH, loadConfig, osLocale } from '../config.js';
import { formatAppError } from '../common/errors.js';
import { isPortInUse } from '../common/net.js';
import type { DemoPrepared, DemoRequest, DemoShell } from '../diplomat/cli/io.js';
import { bootstrap } from '../diplomat/db/bootstrap.js';
import {
  acquireDatabaseLock,
  canonicalPath,
  databaseExists,
  isSymlink,
  probeDatabase,
  removeDatabaseFiles,
} from '../diplomat/db/database-files.js';
import { closeDatabase, openDatabaseWithKey } from '../diplomat/db/driver.js';
import { resolveDemoCountry } from '../logic/demo.js';
import { failureOfSeedStatus, planDemoDatabase, refusalWithoutProbe } from '../logic/demo-database.js';
import { startupRefusalMessage } from '../models/startup.js';
import {
  DEMO_DB_KEY,
  DemoFailureCode,
  demoFailures,
  type DemoCountry,
  type DemoDatabaseFacts,
  type DemoFailure,
  type DemoSeedStatus,
} from '../models/demo.js';
import { seedDemo } from './demo-seed.js';
import { loadHttpModule } from './lazy-modules.js';

export type DemoShellOptions = {
  databasePath?: string;
  realDatabasePath?: () => string;
  today?: () => Date;
  seed?: typeof seedDemo;
};

const seedFailure = (reason: string): DemoFailure => demoFailures.of(DemoFailureCode.enum.seed_failed, reason);

type Location = Pick<DemoDatabaseFacts, 'isRealDatabase' | 'isAlias'>;

const locateDatabase = (databasePath: string, realDatabasePath: string): Location => {
  const demo = canonicalPath(databasePath);
  const real = canonicalPath(realDatabasePath);
  return { isRealDatabase: demo === null || real === null || demo === real, isAlias: isSymlink(databasePath) };
};

const lookAtDatabase = async (
  databasePath: string,
  location: Location,
  reset: boolean,
): Promise<DemoDatabaseFacts> => ({
  ...location,
  reset,
  ...(await probeDatabase(databasePath)),
});

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

/** A database this run created is removed if its seed fails; one that was already there is not ours to delete. */
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

type ShellContext = {
  databasePath: string;
  realDatabasePath: () => string;
  today: () => Date;
  seed: typeof seedDemo;
};

const prepareLocked = async (
  context: ShellContext,
  location: Location,
  request: DemoRequest,
): Promise<Result<DemoPrepared, DemoFailure>> => {
  const { databasePath, seed } = context;
  const plan = planDemoDatabase(await lookAtDatabase(databasePath, location, request.reset));
  if (plan.isErr()) return err(demoFailures.of(plan.error));
  if (plan.value.deleteFirst) removeDatabaseFiles(databasePath);

  const country = request.country ?? resolveDemoCountry(osLocale());
  const status = await seedOrClean({ seed, databasePath, country, today: context.today() }, plan.value.createdHere);
  return status.andThen((seeded) => {
    const failure = failureOfSeedStatus(seeded);
    return failure === null ? ok({ status: seeded, databasePath, country }) : err(demoFailures.of(failure));
  });
};

const prepareDemo = async (context: ShellContext, request: DemoRequest): Promise<Result<DemoPrepared, DemoFailure>> => {
  const { databasePath } = context;
  const location = locateDatabase(databasePath, context.realDatabasePath());
  const early = refusalWithoutProbe(location);
  if (early !== null) return err(demoFailures.of(early));
  const lock = await acquireDatabaseLock(databasePath);
  if (lock === null) return err(demoFailures.of(DemoFailureCode.enum.busy));
  try {
    return await prepareLocked(context, location, request);
  } finally {
    await lock.release();
  }
};

const serveDemo = async (databasePath: string): Promise<Result<void, DemoFailure>> => {
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
};

export const createDemoShell = (options: DemoShellOptions = {}): DemoShell => {
  const context: ShellContext = {
    databasePath: options.databasePath ?? DEMO_DB_PATH,
    realDatabasePath: options.realDatabasePath ?? (() => loadConfig().DB_PATH),
    today: options.today ?? (() => new Date()),
    seed: options.seed ?? seedDemo,
  };
  return {
    databasePath: context.databasePath,
    hasDatabase: () => databaseExists(context.databasePath),
    prepare: (request) => prepareDemo(context, request),
    serve: () => serveDemo(context.databasePath),
  };
};
