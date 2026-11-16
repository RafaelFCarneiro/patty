/**
 * The other PATTY process of `separate-process.test.ts`: a real child that opens the shared database with its own
 * connections and runtime. `publish <db> <userId> <entity>` announces one change and shuts down the way a server does
 * (pending appends flushed, connections released); `hold <db>` takes the write lock and keeps it until stdin closes.
 */
import { sql } from 'drizzle-orm';
import { createRuntime } from '../../../src/composition/runtime.js';
import { closeDatabase, openDatabase } from '../../../src/diplomat/db/driver.js';
import { keyLockPathForTest } from '../../unit/fixtures/key-lock.js';

const CONFIG = { PATTY_LOCALE: undefined, FIAT_RATE_STALE_HOURS: 24, CRYPTO_RATE_STALE_HOURS: 1 };

const main = async (): Promise<void> => {
  const [mode, dbPath, userId, entity] = process.argv.slice(2);
  const db = await openDatabase({
    KEY_LOCK_PATH: keyLockPathForTest(),
    DB_PATH: dbPath!,
    PATTY_DB_KEY: process.env.PATTY_DB_KEY,
  });
  if (mode === 'hold') {
    await db.run(sql`BEGIN IMMEDIATE`);
    process.stdout.write('locked\n');
    process.stdin.resume();
    await new Promise<void>((done) => process.stdin.once('end', done));
    await db.run(sql`COMMIT`);
  } else {
    const runtime = createRuntime(db, CONFIG, { onChangeError: (cause) => console.error(cause) });
    runtime.changeBus.publish({ userId: userId!, entities: [entity!] });
    await runtime.changeLog.close();
  }
  closeDatabase(db);
  process.exit(0);
};

void main();
