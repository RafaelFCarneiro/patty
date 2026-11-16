import type { ChangeLogEntry, ChangeLogStore, NewChangeLogRecord } from '@rfc0/effect-runner';
import { asc, and, gt, ne, lt, sql } from 'drizzle-orm';
import { sleep } from '../../common/time.js';
import * as changeEventAdapters from '../../adapters/change-events.js';
import type { ChangeEvent } from '../../models/tenancy.js';
import { DataVersionRowSchema, LatestIdRowSchema } from '../../wire/db/change-events.js';
import { closeDatabase, NEVER_BLOCK_IN_SQLITE_MS, openSibling, type Db } from './driver.js';
import { changeEvents } from './schema.js';
import { isSqliteBusy } from './sqlite-errors.js';

/** The change log's own connection: no lock wait, and one stable identity (`data_version` is per connection).
 *  Never run a transaction on it. */
export const openChangeLog = (db: Db): Promise<Db> => openSibling(db, NEVER_BLOCK_IN_SQLITE_MS);

const insertRow = async (log: Db, { event, origin, createdAt }: NewChangeLogRecord<ChangeEvent>): Promise<void> => {
  await log.insert(changeEvents).values({
    userId: event.userId,
    entities: JSON.stringify(event.entities),
    origin,
    createdAt,
  });
};

/** Pauses between append attempts while the database is busy; the loop stays free meanwhile (ADR-036 §2). */
export const CHANGE_EVENT_APPEND_BACKOFF_MS: readonly number[] = [5, 10, 20, 40, 80];

/** Appends one row; while the database is busy, retries after each pause, then fails. */
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
    await sleep(next);
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
 * The package's `ChangeLogStore` over `change_events`. It meets the package's id contract: AUTOINCREMENT never reuses
 * an id, and with one writer at a time rows become readable in id order. It runs on one lazily opened sibling
 * connection; `close` releases it.
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
