import { acquireDatabaseLock } from '../../../src/diplomat/db/database-files.js';

/** Holds the demo database lock until killed: a run that dies holding it. */
const HOLD_FOREVER_MS = 60_000;

const lock = await acquireDatabaseLock(process.argv[2] ?? '');
process.stdout.write(lock === null ? 'busy' : 'held');
setTimeout(() => undefined, HOLD_FOREVER_MS);
