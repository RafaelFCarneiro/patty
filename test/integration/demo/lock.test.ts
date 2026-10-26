import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const WORKERS = 6;
const ROUNDS = 60;
const WORKER = 'test/integration/demo/lock-worker.ts';
const TIMEOUT_MS = 60_000;

let dir: string;
let databasePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fintrack-lock-'));
  databasePath = join(dir, 'demo.db');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

type Tally = { acquired: number; violations: number };

const runWorker = (): Promise<Tally> =>
  new Promise((resolve, reject) => {
    const args = ['--import', 'tsx', WORKER, databasePath, join(dir, 'inside'), String(ROUNDS)];
    const child = spawn(process.execPath, args);
    let out = '';
    child.stdout.on('data', (chunk) => (out += String(chunk)));
    child.once('error', reject);
    child.once('close', (code) => (code === 0 ? resolve(JSON.parse(out) as Tally) : reject(new Error(`exit ${code}`))));
  });

const contend = (): Promise<Tally[]> => Promise.all(Array.from({ length: WORKERS }, runWorker));
const total = (tallies: Tally[], field: keyof Tally): number => tallies.reduce((sum, tally) => sum + tally[field], 0);

// The lock is held by the operating system (an exclusive SQLite transaction): nothing to go stale or reclaim.
describe('the demo database lock across processes', () => {
  it(
    'never admits two holders at once while processes race for it',
    async () => {
      const tallies = await contend();
      expect(total(tallies, 'violations')).toBe(0);
      expect(total(tallies, 'acquired')).toBeGreaterThan(0);
    },
    TIMEOUT_MS,
  );

  it(
    'never admits two holders across a second wave of contenders on the same lock file',
    async () => {
      const tallies = [...(await contend()), ...(await contend())];
      expect(total(tallies, 'violations')).toBe(0);
      expect(total(tallies, 'acquired')).toBeGreaterThan(0);
    },
    TIMEOUT_MS,
  );
});
