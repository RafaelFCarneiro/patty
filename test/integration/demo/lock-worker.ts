import { rmSync, writeFileSync } from 'node:fs';
import { acquireDatabaseLock } from '../../../src/diplomat/db/database-files.js';

/**
 * One contender for the demo database lock, run as its own process by `lock.test.ts`: it takes the lock many times,
 * and inside each hold claims an exclusive marker file — which fails (and is reported) if another holder is inside too.
 */
const [databasePath = '', inside = '', rounds = '0'] = process.argv.slice(2);
const HOLD_MS = 2;

const sleep = (ms: number): void => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

let acquired = 0;
let violations = 0;
for (let round = 0; round < Number(rounds); round += 1) {
  const lock = await acquireDatabaseLock(databasePath);
  if (lock === null) continue;
  acquired += 1;
  try {
    writeFileSync(inside, String(process.pid), { flag: 'wx' });
    sleep(HOLD_MS);
    rmSync(inside);
  } catch {
    violations += 1;
  } finally {
    await lock.release();
  }
}
process.stdout.write(JSON.stringify({ acquired, violations }));
