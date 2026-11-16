import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChangeLogEntry } from '@rfc0/effect-runner';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bootstrap } from '../../../src/diplomat/db/bootstrap.js';
import {
  CHANGE_EVENT_APPEND_BACKOFF_MS,
  changeLogStore,
  type SqliteChangeLog,
} from '../../../src/diplomat/db/change-events.js';
import { BUSY_TIMEOUT_MS, closeDatabase, openDatabase, openSibling, type Db } from '../../../src/diplomat/db/driver.js';
import type { ChangeEvent } from '../../../src/models/tenancy.js';
import { keyLockPathForTest } from '../../unit/fixtures/key-lock.js';

let tmpDir: string;
let db: Db;
let store: SqliteChangeLog;

const record = (entities: string[], origin = 'proc-a', createdAt = '2026-11-14T12:00:00.000Z', userId = 'u1') => ({
  event: { userId, entities } as ChangeEvent,
  origin,
  createdAt,
});
const entitiesOf = (entries: readonly ChangeLogEntry<ChangeEvent>[]) =>
  entries.map((entry) => ('event' in entry ? entry.event.entities[0] : null));

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'patty-change-events-'));
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  db = await openDatabase({
    KEY_LOCK_PATH: keyLockPathForTest(),
    DB_PATH: join(tmpDir, 'patty.db'),
    PATTY_DB_KEY: 'c'.repeat(64),
  });
  await bootstrap(db);
  store = changeLogStore(db);
});

afterEach(async () => {
  await store.close();
  vi.restoreAllMocks();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('changeLogStore — the SQLite ChangeLogStore', () => {
  it('appends a row and reads it back decoded, in id order', async () => {
    await store.append(record(['account']));
    await store.append({
      ...record(['bill', 'transaction']),
      event: { userId: null, entities: ['bill', 'transaction'] },
    });

    expect(await store.readAfter(0, 'someone-else', 10)).toEqual([
      { id: 1, origin: 'proc-a', event: { userId: 'u1', entities: ['account'] } },
      { id: 2, origin: 'proc-a', event: { userId: null, entities: ['bill', 'transaction'] } },
    ]);
  });

  it('treats an entity tag as data, never as SQL (parameterized)', async () => {
    const hostile = `x'); DROP TABLE change_events; --`;

    await store.append(record([hostile]));

    expect(await store.readAfter(0, 'none', 10)).toEqual([
      { id: 1, origin: 'proc-a', event: { userId: 'u1', entities: [hostile] } },
    ]);
  });

  it('respects excludeOrigin, the cursor and the limit, and returns id order', async () => {
    await store.append(record(['one'], 'me'));
    await store.append(record(['two'], 'other'));
    await store.append(record(['three'], 'other'));
    await store.append(record(['four'], 'other'));

    const entries = await store.readAfter(1, 'me', 2);

    expect(entries.map(({ id }) => id)).toEqual([2, 3]);
    expect(entitiesOf(entries)).toEqual(['two', 'three']);
  });

  it('answers a row that does not decode as a skipped entry with its id and the reason, never throwing', async () => {
    const insert = (entities: string) =>
      db.run(
        sql`INSERT INTO change_events (user_id, entities, origin, created_at) VALUES ('u1', ${entities}, 'x', '2026-11-14T12:00:00.000Z')`,
      );
    await insert('not json');
    await insert('[1, 2]');
    await store.append(record(['tag']));

    const entries = await store.readAfter(0, 'none', 10);

    expect(entries.map(({ id }) => id)).toEqual([1, 2, 3]);
    expect(entries[0]).toEqual({ id: 1, skipped: 'entities is not valid JSON' });
    expect(entries[1]).toMatchObject({ id: 2, skipped: expect.any(String) });
    expect(entries[2]).toMatchObject({ id: 3, event: { entities: ['tag'] } });
  });

  it('knows the newest id, 0 for an empty table', async () => {
    expect(await store.latestId()).toBe(0);

    await store.append(record(['a']));
    await store.append(record(['b']));

    expect(await store.latestId()).toBe(2);
  });

  it('keeps ids increasing after a prune empties the table (never reuses one)', async () => {
    await store.append(record(['old'], 'p', '2026-11-14T11:00:00.000Z'));
    await store.append(record(['older'], 'p', '2026-11-14T11:01:00.000Z'));

    await store.pruneBefore('2026-11-14T12:00:00.000Z');
    expect(await store.readAfter(0, 'none', 10)).toEqual([]);
    await store.append(record(['new']));

    expect(await store.latestId()).toBe(3);
    expect((await store.readAfter(0, 'none', 10)).map(({ id }) => id)).toEqual([3]);
  });

  it('prunes only rows created before the instant', async () => {
    await store.append(record(['old'], 'p', '2026-11-14T11:00:00.000Z'));
    await store.append(record(['edge'], 'p', '2026-11-14T11:50:00.000Z'));
    await store.append(record(['new'], 'p', '2026-11-14T12:00:00.000Z'));

    await store.pruneBefore('2026-11-14T11:50:00.000Z');

    expect(entitiesOf(await store.readAfter(0, 'none', 10))).toEqual(['edge', 'new']);
  });

  it('changes its token only after another connection committed, not after its own append', async () => {
    const baseline = await store.changeToken!();
    expect(await store.changeToken!()).toBe(baseline);
    await store.append(record(['own write']));
    expect(await store.changeToken!()).toBe(baseline);

    await db.run(sql`UPDATE settings SET version = version + 1 WHERE id = 'singleton'`);

    expect(await store.changeToken!()).not.toBe(baseline);
  });

  it('keeps one connection identity across the engine’s transactions on the main handle', async () => {
    // libsql replaces a client's connection after every transaction, so a `data_version` read on the main handle
    // would reset. The store's connection never runs one, so its reading is stable.
    const baseline = await store.changeToken!();

    await db.transaction(async (tx) => {
      await tx.run(sql`UPDATE settings SET version = version + 1 WHERE id = 'singleton'`);
    });
    const afterFirst = (await store.changeToken!()) as number;
    await db.transaction(async () => undefined);
    await db.transaction(async () => undefined);

    expect(afterFirst).toBeGreaterThan(baseline as number);
    expect(await store.changeToken!()).toBe(afterFirst);
  });

  describe('under real write contention', () => {
    // Another connection holds the write lock, as a long write of another process would.
    const holdingTheWriteLock = async (work: () => Promise<void>): Promise<void> => {
      const holder = await openSibling(db, BUSY_TIMEOUT_MS);
      await holder.run(sql`BEGIN IMMEDIATE`);
      try {
        await work();
      } finally {
        await holder.run(sql`COMMIT`);
        closeDatabase(holder);
      }
    };

    const pause = (ms: number) => new Promise<void>((resume) => setTimeout(resume, ms));
    /** The longest the event loop went without running a 5 ms timer while `work` ran. */
    const loopLagDuring = async (work: () => Promise<unknown>): Promise<number> => {
      const lag = { worst: 0, last: Date.now() };
      const timer = setInterval(() => {
        lag.worst = Math.max(lag.worst, Date.now() - lag.last - 5);
        lag.last = Date.now();
      }, 5);
      await work().catch(() => undefined);
      clearInterval(timer);
      return lag.worst;
    };

    it('gives up on a lock never released after the backoff, far below the database’s own timeout', async () => {
      await store.append(record(['warm up the connection']));
      const backoff = CHANGE_EVENT_APPEND_BACKOFF_MS.reduce((total, ms) => total + ms, 0);

      await holdingTheWriteLock(async () => {
        const startedAt = Date.now();
        await expect(store.append(record(['blocked']))).rejects.toThrow();
        const waited = Date.now() - startedAt;

        expect(waited).toBeGreaterThanOrEqual(backoff - 5);
        expect(waited).toBeLessThan(BUSY_TIMEOUT_MS / 2);
      });
    });

    it('never blocks the event loop while it waits for a lock', async () => {
      await store.append(record(['warm up the connection']));

      await holdingTheWriteLock(async () => {
        const worst = await loopLagDuring(() => store.append(record(['blocked'])));

        expect(worst).toBeLessThan(40);
      });
    });

    it('lands the append when the lock is released during the backoff', async () => {
      await store.append(record(['warm up the connection']));
      const releaseAfterMs = CHANGE_EVENT_APPEND_BACKOFF_MS[0]! + CHANGE_EVENT_APPEND_BACKOFF_MS[1]!;
      const holder = await openSibling(db, BUSY_TIMEOUT_MS);
      await holder.run(sql`BEGIN IMMEDIATE`);
      const released = pause(releaseAfterMs).then(async () => {
        await holder.run(sql`COMMIT`);
        closeDatabase(holder);
      });

      await store.append(record(['waited it out']));
      await released;

      expect(entitiesOf(await store.readAfter(0, 'none', 10))).toEqual(['warm up the connection', 'waited it out']);
    });

    it('lands the append while this process’s own transaction is open (a blocking wait never could)', async () => {
      const ownTransaction = db.transaction(async (tx) => {
        await tx.run(sql`UPDATE settings SET version = version + 1 WHERE id = 'singleton'`);
        await pause(15);
      });
      await pause(1);

      await store.append(record(['during the engine’s transaction']));
      await ownTransaction;

      expect(entitiesOf(await store.readAfter(0, 'none', 10))).toEqual(['during the engine’s transaction']);
    });

    it('leaves the main connection’s own lock wait untouched by the store’s', async () => {
      const busyTimeout = async () => (await db.all<{ timeout: number }>(sql`PRAGMA busy_timeout`))[0]?.timeout;
      const before = await busyTimeout();

      await holdingTheWriteLock(async () => {
        await expect(store.append(record(['blocked']))).rejects.toThrow();
      });

      expect(before).toBe(BUSY_TIMEOUT_MS);
      expect(await busyTimeout()).toBe(BUSY_TIMEOUT_MS);
    });

    it('recovers once the lock is released: the next append lands, the failed one left no row', async () => {
      await holdingTheWriteLock(async () => {
        await expect(store.append(record(['lost']))).rejects.toThrow();
      });

      await store.append(record(['after']));

      expect(entitiesOf(await store.readAfter(0, 'none', 10))).toEqual(['after']);
    });
  });

  it('reopens after close: the next call opens a fresh connection', async () => {
    await store.append(record(['before']));
    await store.close();

    await store.append(record(['after']));

    expect(entitiesOf(await store.readAfter(0, 'none', 10))).toEqual(['before', 'after']);
  });

  it('refuses a handle that this adapter did not open', async () => {
    await expect(openSibling({} as Db, 1)).rejects.toThrow(/not opened by openDatabase/);
  });
});
