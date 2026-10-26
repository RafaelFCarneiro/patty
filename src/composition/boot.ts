import { ok, safeTry } from 'neverthrow';
import type { Config } from '../config.js';
import { bootstrap } from '../diplomat/db/bootstrap.js';
import { closeDatabase, openDatabase } from '../diplomat/db/driver.js';
import { demoNotReadyMessage } from '../models/demo.js';
import { StartupRefusal } from '../models/error.js';
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
    const db = await openDatabase(config);
    yield* bootstrap(db);
    const runtime = createRuntime(db, config);
    // The demo key and no login are only for a database that says it is a demo: anything else is never served this way.
    if (config.FINTRACK_DEMO && !isDemoInstance(await runtime.instanceKind())) {
      closeDatabase(db);
      throw new StartupRefusal(demoNotReadyMessage(config.DB_PATH));
    }
    const prepared = await prepareAuth(config, db, runtime.authRunEffects);
    return ok({ db, runtime, prepared });
  });
