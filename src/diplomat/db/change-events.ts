import * as changeEventAdapters from '../../adapters/change-events.js';
import { asc, and, gt, ne, lt, sql } from 'drizzle-orm';
import {
  CHANGE_EVENT_APPEND_TIMEOUT_MS,
  type ChangeEventEntry,
  type NewChangeEvent,
} from '../../models/change-events.js';
import { DataVersionRowSchema, LatestIdRowSchema } from '../../wire/db/change-events.js';
import { openSibling, type Db } from './driver.js';
import { changeEvents } from './schema.js';

/** The connection every `change_events` statement runs on: a sibling of the engine's, so it waits at most
 *  `CHANGE_EVENT_APPEND_TIMEOUT_MS` for a lock without touching how long a write waits, and keeps one identity for as
 *  long as it is open (`data_version` is per connection). Never run a transaction on it. */
export const openChangeLog = (db: Db): Promise<Db> => openSibling(db, CHANGE_EVENT_APPEND_TIMEOUT_MS);

/** Appends one row (parameterized). */
export const append = async (log: Db, { event, origin, createdAt }: NewChangeEvent): Promise<void> => {
  await log.insert(changeEvents).values({
    userId: event.userId,
    entities: JSON.stringify(event.entities),
    origin,
    createdAt,
  });
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
): Promise<readonly ChangeEventEntry[]> => {
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
