import type { ChangeLogEntry, ChangeLogStore, NewChangeLogRecord } from '@rfc0/effect-runner';
import { asc, and, gt, ne, lt, sql } from 'drizzle-orm';
import * as changeEventAdapters from '../../adapters/change-events.js';
import { CHANGE_EVENT_APPEND_BACKOFF_MS, CHANGE_EVENT_LOCK_WAIT_MS } from '../../models/change-events.js';
import type { ChangeEvent } from '../../models/tenancy.js';
import { DataVersionRowSchema, LatestIdRowSchema } from '../../wire/db/change-events.js';
import { closeDatabase, openSibling, type Db } from './driver.js';
import { changeEvents } from './schema.js';
import { isSqliteBusy } from './sqlite-errors.js';

/** The connection every `change_events` statement runs on: a sibling of the engine's, so its lock wait
 *  (`CHANGE_EVENT_LOCK_WAIT_MS`, none) never touches how long a write waits, and it keeps one identity for as long as
 *  it is open (`data_version` is per connection). Never run a transaction on it. */
export const openChangeLog = (db: Db): Promise<Db> => openSibling(db, CHANGE_EVENT_LOCK_WAIT_MS);

const insertRow = async (log: Db, { event, origin, createdAt }: NewChangeLogRecord<ChangeEvent>): Promise<void> => {
  await log.insert(changeEvents).values({
    userId: event.userId,
    entities: JSON.stringify(event.entities),
    origin,
    createdAt,
  });
};

const pause = (ms: number): Promise<void> => new Promise((resume) => setTimeout(resume, ms));

/** Appends one row (parameterized). A busy database fails the statement at once (it never blocks the event loop)
 *  and the append waits asynchronously, `CHANGE_EVENT_APPEND_BACKOFF_MS` between attempts, so a transaction of this
 *  process or a short write of another one can finish; still busy after the last pause, it fails with that error. */
export const append = async (
  log: Db,
  record: NewChangeLogRecord<ChangeEvent>,
  pauses: readonly number[] = CHANGE_EVENT_APPEND_BACKOFF_MS,
): Promise<void> => {
  try {
    await insertRow(log, record);
  } catch (cause) {
    const [next, ...rest] = pauses;
    if (next === undefined || !isSqliteBusy(cause)) throw cause;
    await pause(next);
    await append(log, record, rest);
  }
};

/** The newest row's id, 0 for an empty table: where a relay starts, so it never replays what came before it. */
export const latestId = async (log: Db): Promise<number> => {
  const [row] = await log.all(sql`SELECT MAX(${changeEvents.id}) AS latest FROM ${changeEvents}`);
  return LatestIdRowSchema.parse(row).latest ?? 0;
};

/** Rows after `afterId` written by a process other than `excludeOrigin`, in id order, at most `limit`. A row that
 *  does not decode is returned as a skipped entry carrying its id and the reason, never thrown. */
export const readAfter = async (
  log: Db,
  afterId: number,
  excludeOrigin: string,
  limit: number,
): Promise<readonly ChangeLogEntry<ChangeEvent>[]> => {
  const rows = await log
    .select()
    .from(changeEvents)
    .where(and(gt(changeEvents.id, afterId), ne(changeEvents.origin, excludeOrigin)))
    .orderBy(asc(changeEvents.id))
    .limit(limit);
  return rows.map(changeEventAdapters.dbToModel);
};

/** Deletes rows created before the instant (ISO-8601, so text order is time order). */
export const pruneBefore = async (log: Db, isoInstant: string): Promise<void> => {
  await log.delete(changeEvents).where(lt(changeEvents.createdAt, isoInstant));
};

/** SQLite's `data_version` on this connection: it changes only when another connection committed. */
export const dataVersion = async (log: Db): Promise<number> => {
  const [row] = await log.all(sql`PRAGMA data_version`);
  return DataVersionRowSchema.parse(row).data_version;
};

export type SqliteChangeLog = ChangeLogStore<ChangeEvent> & { close: () => Promise<void> };

/**
 * `@rfc0/effect-runner`'s `ChangeLogStore` over the `change_events` table. The table meets the package's id
 * contract: `INTEGER PRIMARY KEY AUTOINCREMENT` ids strictly increase and are never reused, even after a prune empties
 * the table, and SQLite admits one writer at a time, so a row becomes readable in id order. Every statement, and the
 * `changeToken` (`PRAGMA data_version`, per connection), runs on one sibling connection opened on first use and opened
 * again after a failed open; `close` releases it. A busy database fails a statement at once, never blocking the event
 * loop; an append then waits asynchronously (`CHANGE_EVENT_APPEND_BACKOFF_MS`) before the package reports the failure
 * and carries on.
 */
export const changeLogStore = (db: Db): SqliteChangeLog => {
  const link = { opened: undefined as Promise<Db> | undefined };
  const connection = (): Promise<Db> =>
    (link.opened ??= openChangeLog(db).catch((cause: unknown) => {
      link.opened = undefined;
      throw cause;
    }));
  return {
    append: async (record) => append(await connection(), record),
    latestId: async () => latestId(await connection()),
    readAfter: async (afterId, excludeOrigin, limit) => readAfter(await connection(), afterId, excludeOrigin, limit),
    pruneBefore: async (isoInstant) => pruneBefore(await connection(), isoInstant),
    changeToken: async () => dataVersion(await connection()),
    close: async () => {
      const opened = link.opened;
      link.opened = undefined;
      if (opened) closeDatabase(await opened);
    },
  };
};
