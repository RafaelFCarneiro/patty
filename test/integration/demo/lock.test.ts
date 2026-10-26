import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
    const child = spawn(process.execPath, [
      '--import',
      'tsx',
      WORKER,
      databasePath,
      join(dir, 'inside'),
      String(ROUNDS),
    ]);
    let out = '';
    child.stdout.on('data', (chunk) => (out += String(chunk)));
    child.once('error', reject);
    child.once('close', (code) => (code === 0 ? resolve(JSON.parse(out) as Tally) : reject(new Error(`exit ${code}`))));
  });

const contend = async (): Promise<Tally[]> => Promise.all(Array.from({ length: WORKERS }, runWorker));

describe('the demo database lock across processes', () => {
  it(
    'never admits two holders at once while processes race for it',
    async () => {
      const tallies = await contend();
      expect(tallies.reduce((sum, tally) => sum + tally.violations, 0)).toBe(0);
      expect(tallies.reduce((sum, tally) => sum + tally.acquired, 0)).toBeGreaterThan(0);
    },
    TIMEOUT_MS,
  );

  it(
    'never admits two holders when they all find the same stale lock (reclaim race)',
    async () => {
      const gone = spawnSync(process.execPath, ['-e', '']).pid;
      writeFileSync(`${databasePath}.lock`, `${gone}:stale-token`);
      const tallies = await contend();
      expect(tallies.reduce((sum, tally) => sum + tally.violations, 0)).toBe(0);
      expect(tallies.reduce((sum, tally) => sum + tally.acquired, 0)).toBeGreaterThan(0);
    },
    TIMEOUT_MS,
  );

  it(
    'never exposes a lock that does not yet name its owner (publication is atomic)',
    async () => {
      const tallies = await contend();
      const lockFiles = spawnSync('ls', [dir], { encoding: 'utf8' }).stdout;
      expect(lockFiles).not.toMatch(/\.tmp|\.stale/);
      expect(tallies.reduce((sum, tally) => sum + tally.violations, 0)).toBe(0);
    },
    TIMEOUT_MS,
  );
});
