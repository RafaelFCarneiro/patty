import { acquireDatabaseLock } from '../../../src/diplomat/db/database-files.js';

/** Takes the demo database lock, says so, and holds it until killed — a run that dies holding the lock. */
const HOLD_FOREVER_MS = 60_000;

const lock = await acquireDatabaseLock(process.argv[2] ?? '');
process.stdout.write(lock === null ? 'busy' : 'held');
setTimeout(() => undefined, HOLD_FOREVER_MS);
