import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startChangeRelay, type ChangeRelay } from '@rfc0/effect-runner';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  CHANGE_EVENT_RETENTION_MS,
  CHANGE_NOTIFICATION_FAILED,
  CHANGE_RELAY_BATCH_LIMIT,
} from '../../../src/models/change-events.js';
import { BUSY_TIMEOUT_MS } from '../../../src/diplomat/db/driver.js';
import { OWNER_USER_ID } from '../../../src/models/auth/owner.js';
import { TAG_ENTITY_TAG } from '../../../src/models/tag.js';
import type { ChangeEvent } from '../../../src/models/tenancy.js';
import { buildApp, type AppContext } from '../app-builder.js';

/**
 * The same flow as `cross-process.test.ts`, but the writer is a real second Node process (`writer-process.ts`): its
 * own native libSQL connections, its own runtime and origin, exiting the way a server does. Nothing here can be
 * satisfied by two runtimes sharing one process.
 */

const WRITER = fileURLToPath(new URL('./writer-process.ts', import.meta.url));
const TEST_KEY = 'a'.repeat(64);
const POLL_MS = 25;
/** A cold child starts a TypeScript runtime and opens an encrypted database: generous, never slept on. */
const CHILD_TIMEOUT_MS = 20_000;

let tmpDir: string;
let dbPath: string;
let b: AppContext;
let relay: ChangeRelay;
const heard: ChangeEvent[] = [];

const spawnWriter = (...args: string[]): ChildProcessWithoutNullStreams =>
  spawn(process.execPath, ['--import', 'tsx', WRITER, ...args], {
    env: { ...process.env, PATTY_DB_KEY: TEST_KEY },
  });

const exited = (child: ChildProcessWithoutNullStreams): Promise<number | null> =>
  child.exitCode !== null
    ? Promise.resolve(child.exitCode)
    : new Promise((done) => child.once('exit', (code) => done(code)));

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'patty-separate-process-'));
  dbPath = join(tmpDir, 'shared.db');
  b = await buildApp({ dbPath });
  b.changeBus.subscribe((event) => heard.push(event));
  relay = await startChangeRelay({
    store: b.runtime.changeLog.store,
    publishLocal: b.runtime.changeLog.publishLocal,
    origin: b.runtime.changeLog.origin,
    pollMs: POLL_MS,
    retentionMs: CHANGE_EVENT_RETENTION_MS,
    pruneEveryMs: 60_000,
    batchLimit: CHANGE_RELAY_BATCH_LIMIT,
  });
});

afterAll(async () => {
  await relay.stop();
  await b.runtime.changeLog.close();
  await b.app.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('a writer in a separate process (ADR-036)', () => {
  it(
    'reaches this process’s relay, flushed by the writer’s own shutdown, with the writer’s user and tags',
    async () => {
      const writer = spawnWriter('publish', dbPath, OWNER_USER_ID, TAG_ENTITY_TAG);
      const stderr: string[] = [];
      writer.stderr.on('data', (chunk: Buffer) => stderr.push(String(chunk)));

      const code = await exited(writer);
      await vi.waitFor(() => expect(heard).toContainEqual({ userId: OWNER_USER_ID, entities: [TAG_ENTITY_TAG] }), {
        timeout: 5000,
      });

      expect({ code, stderr: stderr.join('').includes(CHANGE_NOTIFICATION_FAILED) }).toEqual({
        code: 0,
        stderr: false,
      });
    },
    CHILD_TIMEOUT_MS,
  );

  it(
    'fails an append fast while another process holds the write lock, and recovers when it lets go',
    async () => {
      const holder = spawnWriter('hold', dbPath);
      await new Promise<void>((locked) => holder.stdout.once('data', () => locked()));
      const record = {
        event: { userId: OWNER_USER_ID, entities: [TAG_ENTITY_TAG] },
        origin: 'probe',
        createdAt: '2026-11-16T00:00:00.000Z',
      };

      // Whatever the assertions find, the holder is released and awaited: a failing run must not leave a live process
      // holding the write lock.
      let holderExit: number | null = null;
      try {
        const startedAt = Date.now();
        await expect(b.runtime.changeLog.store.append(record)).rejects.toThrow();
        expect(Date.now() - startedAt).toBeLessThan(BUSY_TIMEOUT_MS / 2);
      } finally {
        holder.stdin.end();
        holderExit = await exited(holder);
      }

      expect(holderExit).toBe(0);
      await b.runtime.changeLog.store.append(record);
      expect(await b.runtime.changeLog.store.latestId()).toBeGreaterThan(0);
    },
    CHILD_TIMEOUT_MS,
  );
});
