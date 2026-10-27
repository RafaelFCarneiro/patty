import { err, ok, safeTry } from 'neverthrow';
import type { Config } from '../config.js';
import { bootstrap } from '../diplomat/db/bootstrap.js';
import { databaseExists } from '../diplomat/db/database-files.js';
import { closeDatabase, openDatabase } from '../diplomat/db/driver.js';
import { demoNotReady } from '../models/demo.js';
import { isDemoInstance } from '../models/instance.js';
import { prepareAuth } from './auth.js';
import { createRuntime } from './runtime.js';

/**
 * What every server start shares, in order: open the database, bootstrap it (version guard, safety copy, migrations,
 * seed), assemble the runtime, and decide what demands a login (ADR-033, ADR-034). `stdio.ts` and `http.ts` then
 * differ only in what they serve.
 */
export const boot = (config: Config) =>
  safeTry(async function* () {
    // Never create a file (least of all the real database's) just to look.
    if (config.FINTRACK_DEMO && !databaseExists(config.DB_PATH)) return err(demoNotReady(config.DB_PATH));
    const db = await openDatabase(config);
    yield* bootstrap(db);
    const runtime = createRuntime(db, config);
    if (config.FINTRACK_DEMO && !isDemoInstance(await runtime.instanceKind())) {
      closeDatabase(db);
      return err(demoNotReady(config.DB_PATH));
    }
    const prepared = await prepareAuth(config, db, runtime.authRunEffects);
    return ok({ db, runtime, prepared });
  });
