import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { LOOPBACK_HOST } from '../../../src/common/net.js';
import { startChangeRelay, type ChangeRelay } from '../../../src/composition/change-relay.js';
import { append, openChangeLog } from '../../../src/diplomat/db/change-events.js';
import { closeDatabase } from '../../../src/diplomat/db/driver.js';
import { ACCOUNT_ENTITY_TAG } from '../../../src/models/account.js';
import { OWNER_USER_ID } from '../../../src/models/auth/owner.js';
import { BILL_ENTITY_TAG } from '../../../src/models/bill.js';
import { BUDGET_ENTITY_TAG } from '../../../src/models/budget.js';
import { CURRENCY_RATE_ENTITY_TAG } from '../../../src/models/currency-rate.js';
import { USER_SETTINGS_ENTITY_TAG } from '../../../src/models/locale.js';
import { TAG_ENTITY_TAG } from '../../../src/models/tag.js';
import type { ChangeEvent } from '../../../src/models/tenancy.js';
import { buildApp, type AppContext } from '../app-builder.js';

/**
 * Two runtimes on ONE database file stand for two PATTY processes (each has its own connection and its own origin).
 * `B` serves the dashboard (its relay runs and it listens); `A` only writes, as a stdio server without the port does.
 */

const POLL_MS = 25;
const RETENTION_MS = 10 * 60 * 1000;
const PRUNE_EVERY_MS = 20;
/** Two poll intervals and the time a loaded machine needs to run them. */
const WITHIN_TWO_POLLS_MS = POLL_MS * 2 + 1500;

let tmpDir: string;
let a: AppContext;
let b: AppContext;
let baseUrlB: string;
const relayErrors: unknown[] = [];
const stoppers: Array<() => Promise<void>> = [];

const startRelayOn = async (
  ctx: AppContext,
  overrides: Partial<Parameters<typeof startChangeRelay>[0]> = {},
): Promise<ChangeRelay> => {
  const relay = await startChangeRelay({
    db: ctx.db,
    publishLocal: ctx.runtime.changeLog.publishLocal,
    origin: ctx.runtime.changeLog.origin,
    clock: () => new Date(),
    pollMs: POLL_MS,
    retentionMs: RETENTION_MS,
    pruneEveryMs: 60_000,
    onError: (cause) => relayErrors.push(cause),
    ...overrides,
  });
  stoppers.push(relay.stop);
  return relay;
};

/** An extra relay for one test, stopped when it ends, reporting to its own list so only its errors are counted. */
const withExtraRelay = async (
  overrides: Partial<Parameters<typeof startChangeRelay>[0]>,
  body: () => Promise<void>,
): Promise<void> => {
  const relay = await startRelayOn(b, overrides);
  try {
    await body();
  } finally {
    await relay.stop();
    stoppers.splice(stoppers.indexOf(relay.stop), 1);
  }
};

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'patty-cross-process-'));
  const dbPath = join(tmpDir, 'shared.db');
  a = await buildApp({ dbPath });
  b = await buildApp({ dbPath });
  await b.app.listen({ port: 0, host: LOOPBACK_HOST });
  baseUrlB = `http://${LOOPBACK_HOST}:${(b.app.server.address() as AddressInfo).port}`;
  await startRelayOn(b);
});

afterEach(async () => {
  await drain();
  relayErrors.splice(0);
});

afterAll(async () => {
  await Promise.all(stoppers.map((stop) => stop()));
  await Promise.all([a.runtime.changeLog.close(), b.runtime.changeLog.close()]);
  await Promise.all([a.app.close(), b.app.close()]);
  rmSync(tmpDir, { recursive: true, force: true });
});

/** One SSE message at a time: a chunk may carry several, so what follows the first stays buffered. */
const messageReader = (reader: ReadableStreamDefaultReader<Uint8Array>) => {
  const decoder = new TextDecoder();
  const state = { buffer: '' };
  return async (): Promise<string> => {
    while (!state.buffer.includes('\n\n')) {
      const { value, done } = await reader.read();
      if (done) break;
      state.buffer += decoder.decode(value, { stream: true });
    }
    const end = state.buffer.indexOf('\n\n') + 2;
    const message = state.buffer.slice(0, end);
    state.buffer = state.buffer.slice(end);
    return message;
  };
};

const openStreamOnB = async () => {
  const controller = new AbortController();
  const res = await fetch(`${baseUrlB}/ui/events`, { signal: controller.signal });
  return { next: messageReader(res.body!.getReader()), close: () => controller.abort() };
};

const collect = (ctx: AppContext): ChangeEvent[] => {
  const heard: ChangeEvent[] = [];
  ctx.changeBus.subscribe((event) => heard.push(event));
  return heard;
};

/** Rows are read in id order, so once B has heard a fresh marker from A, every earlier row of A has been relayed:
 *  what one test wrote cannot arrive during the next. */
let markerCount = 0;
const drain = async (): Promise<void> => {
  const marker = `marker-${++markerCount}`;
  const heard = collect(b);
  a.changeBus.publish({ userId: null, entities: [marker] });
  await vi.waitFor(() => expect(heard.some((event) => event.entities.includes(marker))).toBe(true), {
    timeout: WITHIN_TWO_POLLS_MS,
  });
};

const rowsOf = (ctx: AppContext) =>
  ctx.db.all<{ id: number; user_id: string | null; entities: string; origin: string }>(
    sql`SELECT id, user_id, entities, origin FROM change_events ORDER BY id`,
  );

describe('a write through one process reaches the dashboard another process serves (ADR-036)', () => {
  it('delivers it to a /ui/events subscriber of the other runtime within two poll intervals', async () => {
    const stream = await openStreamOnB();
    const startedAt = Date.now();

    const created = await a.app.inject({ method: 'POST', url: '/api/tags', payload: { name: `Cross ${Date.now()}` } });
    expect(created.statusCode).toBe(201);
    const message = await stream.next();

    expect(message).toBe(`data: {"entities":["${TAG_ENTITY_TAG}"]}\n\n`);
    expect(Date.now() - startedAt).toBeLessThan(WITHIN_TWO_POLLS_MS);
    stream.close();
  });

  it('carries the writer’s user and the entity tags on the row, and the writer’s origin', async () => {
    await a.app.inject({ method: 'POST', url: '/api/tags', payload: { name: `Row ${Date.now()}` } });
    await a.runtime.changeLog.settled();

    const rows = await rowsOf(a);

    expect(rows.at(-1)).toMatchObject({
      user_id: OWNER_USER_ID,
      entities: JSON.stringify([TAG_ENTITY_TAG]),
      origin: a.runtime.changeLog.origin,
    });
  });

  it('delivers the local event first: the writing process’s own subscribers do not wait for the database', async () => {
    const heardOnA = collect(a);

    await a.app.inject({ method: 'POST', url: '/api/tags', payload: { name: `Local ${Date.now()}` } });

    expect(heardOnA).toEqual([{ userId: OWNER_USER_ID, entities: [TAG_ENTITY_TAG] }]);
  });
});

describe('no echo between processes', () => {
  it('a runtime’s own write reaches its own subscribers exactly once', async () => {
    const heardOnB = collect(b);

    b.changeBus.publish({ userId: OWNER_USER_ID, entities: [BUDGET_ENTITY_TAG] });
    await b.runtime.changeLog.settled();
    // A's later row is read after B's own row (id order): once B has heard it, the relay has passed B's row.
    a.changeBus.publish({ userId: OWNER_USER_ID, entities: [BILL_ENTITY_TAG] });
    await vi.waitFor(() => expect(heardOnB).toHaveLength(2), { timeout: WITHIN_TWO_POLLS_MS });

    expect(heardOnB).toEqual([
      { userId: OWNER_USER_ID, entities: [BUDGET_ENTITY_TAG] },
      { userId: OWNER_USER_ID, entities: [BILL_ENTITY_TAG] },
    ]);
  });

  it('a relayed event is never appended again', async () => {
    const before = (await rowsOf(a)).length;
    const heardOnB = collect(b);

    a.changeBus.publish({ userId: OWNER_USER_ID, entities: [ACCOUNT_ENTITY_TAG] });
    await vi.waitFor(() => expect(heardOnB).toHaveLength(1), { timeout: WITHIN_TWO_POLLS_MS });
    await b.runtime.changeLog.settled();
    await a.runtime.changeLog.settled();

    expect(await rowsOf(a)).toHaveLength(before + 1);
  });
});

describe('a relay that starts later', () => {
  it('does not replay what was written before it started', async () => {
    a.changeBus.publish({ userId: OWNER_USER_ID, entities: [ACCOUNT_ENTITY_TAG] });
    await a.runtime.changeLog.settled();
    const published: ChangeEvent[] = [];

    await withExtraRelay({ publishLocal: (event) => published.push(event) }, async () => {
      a.changeBus.publish({ userId: OWNER_USER_ID, entities: [BILL_ENTITY_TAG] });
      await vi.waitFor(() => expect(published).toHaveLength(1), { timeout: WITHIN_TWO_POLLS_MS });

      expect(published).toEqual([{ userId: OWNER_USER_ID, entities: [BILL_ENTITY_TAG] }]);
    });
  });
});

describe('a relayed settings change', () => {
  it('drops the receiving process’s cached locale before its subscribers refetch', async () => {
    expect(await b.deps.locale()).toBe('en');
    await b.db.run(
      sql`INSERT INTO user_settings (user_id, locale) VALUES (${OWNER_USER_ID}, 'pt') ON CONFLICT (user_id) DO UPDATE SET locale = 'pt'`,
    );
    const heardOnB = collect(b);

    a.changeBus.publish({ userId: OWNER_USER_ID, entities: [USER_SETTINGS_ENTITY_TAG] });
    await vi.waitFor(() => expect(heardOnB).toHaveLength(1), { timeout: WITHIN_TWO_POLLS_MS });

    expect(await b.deps.locale()).toBe('pt');
    await b.db.run(sql`UPDATE user_settings SET locale = 'en' WHERE user_id = ${OWNER_USER_ID}`);
    a.changeBus.publish({ userId: OWNER_USER_ID, entities: [USER_SETTINGS_ENTITY_TAG] });
    await vi.waitFor(() => expect(heardOnB).toHaveLength(2), { timeout: WITHIN_TWO_POLLS_MS });
  });
});

describe('retention', () => {
  it('deletes rows older than the retention and keeps the newer ones', async () => {
    const log = await openChangeLog(b.db);
    const event = { userId: OWNER_USER_ID, entities: [BUDGET_ENTITY_TAG] };
    const origin = 'retention-test';
    await append(log, { event, origin, createdAt: '2000-01-01T00:00:00.000Z' });
    await append(log, { event, origin, createdAt: new Date().toISOString() });
    closeDatabase(log);

    await withExtraRelay({ pruneEveryMs: PRUNE_EVERY_MS }, async () => {
      await vi.waitFor(async () => {
        expect((await rowsOf(b)).filter((row) => row.origin === origin)).toHaveLength(1);
      });
      const createdAt = await b.db.all<{ created_at: string }>(
        sql`SELECT created_at FROM change_events WHERE origin = ${origin}`,
      );

      expect(createdAt[0]!.created_at > '2001').toBe(true);
    });
  });
});

describe('a row that cannot be decoded', () => {
  it('is skipped and reported, and the next row is still delivered', async () => {
    const published: ChangeEvent[] = [];
    const reported: unknown[] = [];
    const insertRow = (entities: string) =>
      b.db.run(
        sql`INSERT INTO change_events (user_id, entities, origin, created_at) VALUES (${OWNER_USER_ID}, ${entities}, ${'writer-x'}, ${new Date().toISOString()})`,
      );

    await withExtraRelay(
      { publishLocal: (event) => published.push(event), onError: (cause) => reported.push(cause) },
      async () => {
        await insertRow('not json');
        await insertRow('{"a":1}');
        a.changeBus.publish({ userId: OWNER_USER_ID, entities: [BILL_ENTITY_TAG] });
        await vi.waitFor(() => expect(published).toHaveLength(1), { timeout: WITHIN_TWO_POLLS_MS });

        expect(published).toEqual([{ userId: OWNER_USER_ID, entities: [BILL_ENTITY_TAG] }]);
        expect(reported).toHaveLength(2);
        expect(String(reported[0])).toMatch(/row \d+ skipped: entities is not valid JSON/);
      },
    );
  });
});

describe('users stay apart across processes', () => {
  it('forwards another user’s change to a stream only for shared tags; the stream’s own user’s whole', async () => {
    const stream = await openStreamOnB();

    a.changeBus.publish({ userId: 'someone-else', entities: [ACCOUNT_ENTITY_TAG] });
    a.changeBus.publish({ userId: 'someone-else', entities: [ACCOUNT_ENTITY_TAG, CURRENCY_RATE_ENTITY_TAG] });
    a.changeBus.publish({ userId: OWNER_USER_ID, entities: [BILL_ENTITY_TAG] });

    expect(await stream.next()).toBe(`data: {"entities":["${CURRENCY_RATE_ENTITY_TAG}"]}\n\n`);
    expect(await stream.next()).toBe(`data: {"entities":["${BILL_ENTITY_TAG}"]}\n\n`);
    stream.close();
  });
});

describe('a process without a relay (sidecar disabled, or its port taken)', () => {
  it('still appends its writes for the serving process to hear, and hears nothing itself', async () => {
    const heardOnA = collect(a);
    const heardOnB = collect(b);

    // `A` runs no relay in this file: it is the writer-only process.
    await a.app.inject({ method: 'POST', url: '/api/tags', payload: { name: `Only-A-${Date.now()}` } });
    await a.runtime.changeLog.settled();
    b.changeBus.publish({ userId: OWNER_USER_ID, entities: [BUDGET_ENTITY_TAG] });
    await b.runtime.changeLog.settled();
    await vi.waitFor(() => expect(heardOnB.map((event) => event.entities)).toContainEqual([TAG_ENTITY_TAG]), {
      timeout: WITHIN_TWO_POLLS_MS,
    });
    await new Promise((resolve) => setTimeout(resolve, POLL_MS * 3));

    const origins = (await rowsOf(a)).map((row) => row.origin);
    expect(origins).toContain(a.runtime.changeLog.origin);
    expect(origins).toContain(b.runtime.changeLog.origin);
    expect(heardOnA).toEqual([{ userId: OWNER_USER_ID, entities: [TAG_ENTITY_TAG] }]);
  });
});
