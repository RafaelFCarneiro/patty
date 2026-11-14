import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { bootstrap } from '../../../src/diplomat/db/bootstrap.js';
import {
  append,
  dataVersion,
  latestId,
  openChangeLog,
  pruneBefore,
  readAfter,
} from '../../../src/diplomat/db/change-events.js';
import { closeDatabase, openDatabase, openSibling, type Db } from '../../../src/diplomat/db/driver.js';
import { isSkippedEntry } from '../../../src/logic/change-events.js';
import { CHANGE_EVENT_APPEND_TIMEOUT_MS } from '../../../src/models/change-events.js';
import { keyLockPathForTest } from '../../unit/fixtures/key-lock.js';

let tmpDir: string;
let db: Db;
let log: Db;

const event = (entities: string[], userId: string | null = 'u1') => ({ userId, entities });
const row = (entities: string[], origin = 'proc-a', createdAt = '2026-11-14T12:00:00.000Z') => ({
  event: event(entities),
  origin,
  createdAt,
});

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
  log = await openChangeLog(db);
});

afterEach(() => {
  closeDatabase(log);
  vi.restoreAllMocks();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('diplomat/db/change-events', () => {
  it('appends a row and reads it back decoded, in id order', async () => {
    await append(log, row(['account']));
    await append(log, { ...row(['bill', 'transaction']), event: event(['bill', 'transaction'], null) });

    const entries = await readAfter(log, 0, 'someone-else', 10);

    expect(entries).toEqual([
      { id: 1, origin: 'proc-a', event: { userId: 'u1', entities: ['account'] } },
      { id: 2, origin: 'proc-a', event: { userId: null, entities: ['bill', 'transaction'] } },
    ]);
  });

  it('treats an entity tag as data, never as SQL (parameterized)', async () => {
    const hostile = `x'); DROP TABLE change_events; --`;

    await append(log, row([hostile]));

    expect(await readAfter(log, 0, 'none', 10)).toEqual([
      { id: 1, origin: 'proc-a', event: { userId: 'u1', entities: [hostile] } },
    ]);
  });

  it('reads only rows after the cursor, never the reader’s own origin, and at most `limit`', async () => {
    await append(log, row(['one'], 'me'));
    await append(log, row(['two'], 'other'));
    await append(log, row(['three'], 'other'));
    await append(log, row(['four'], 'other'));

    const entries = await readAfter(log, 1, 'me', 2);

    expect(entries.map(({ id }) => id)).toEqual([2, 3]);
  });

  it('answers a row that does not decode as a skipped entry with its id and the reason, never throwing', async () => {
    await db.run(
      sql`INSERT INTO change_events (user_id, entities, origin, created_at) VALUES ('u1', 'not json', 'x', '2026-11-14T12:00:00.000Z')`,
    );
    await db.run(
      sql`INSERT INTO change_events (user_id, entities, origin, created_at) VALUES ('u1', '[1, 2]', 'x', '2026-11-14T12:00:00.000Z')`,
    );
    await append(log, row(['tag']));

    const entries = await readAfter(log, 0, 'none', 10);

    expect(entries.map(({ id }) => id)).toEqual([1, 2, 3]);
    expect(entries.filter(isSkippedEntry)).toHaveLength(2);
    expect(entries[0]).toEqual({ id: 1, skipped: 'entities is not valid JSON' });
    expect(entries[2]).toMatchObject({ id: 3, event: { entities: ['tag'] } });
  });

  it('knows the newest id, 0 for an empty table', async () => {
    expect(await latestId(log)).toBe(0);

    await append(log, row(['a']));
    await append(log, row(['b']));

    expect(await latestId(log)).toBe(2);
  });

  it('prunes only rows created before the instant', async () => {
    await append(log, row(['old'], 'p', '2026-11-14T11:00:00.000Z'));
    await append(log, row(['edge'], 'p', '2026-11-14T11:50:00.000Z'));
    await append(log, row(['new'], 'p', '2026-11-14T12:00:00.000Z'));

    await pruneBefore(log, '2026-11-14T11:50:00.000Z');

    const kept = await readAfter(log, 0, 'none', 10);
    expect(kept.map((entry) => ('event' in entry ? entry.event.entities[0] : null))).toEqual(['edge', 'new']);
  });

  it('reports a data_version that moves only when another connection commits', async () => {
    const baseline = await dataVersion(log);
    expect(await dataVersion(log)).toBe(baseline);
    await append(log, row(['own write on the log connection']));
    expect(await dataVersion(log)).toBe(baseline);

    await db.run(sql`UPDATE settings SET version = version + 1 WHERE id = 'singleton'`);

    expect(await dataVersion(log)).not.toBe(baseline);
  });

  it('keeps one connection identity across the engine’s transactions on the main handle', async () => {
    // libsql replaces a client's connection after every transaction; `data_version` read on the main handle would
    // therefore reset. The log connection is a sibling that never runs one, so its reading is stable.
    const baseline = await dataVersion(log);

    await db.transaction(async (tx) => {
      await tx.run(sql`UPDATE settings SET version = version + 1 WHERE id = 'singleton'`);
    });
    const afterFirst = await dataVersion(log);
    await db.transaction(async () => undefined);
    await db.transaction(async () => undefined);

    expect(afterFirst).toBeGreaterThan(baseline);
    expect(await dataVersion(log)).toBe(afterFirst);
  });

  it('opens its connection with the short lock wait, not the database’s own', async () => {
    const [busy] = await log.all<{ timeout: number }>(sql`PRAGMA busy_timeout`);

    expect(busy?.timeout).toBe(CHANGE_EVENT_APPEND_TIMEOUT_MS);
  });

  it('refuses a sibling of a handle that this adapter did not open', async () => {
    await expect(openSibling({} as Db, 1)).rejects.toThrow(/not opened by openDatabase/);
  });
});
