import type { ChangeEvent } from './tenancy.js';

/** How often a serving process asks whether another process committed (ADR-036 §3, §5: the cross-process latency). */
export const CHANGE_RELAY_POLL_MS = 1000;
/** A change-log row older than this is deleted: the log only bridges the seconds between two processes (§4). */
export const CHANGE_EVENT_RETENTION_MS = 10 * 60 * 1000;
/** How often the relay deletes rows past retention. */
export const CHANGE_EVENT_PRUNE_EVERY_MS = 60 * 1000;
/** The longest any change-log statement waits for a lock — far below the database's own `busy_timeout`, so a
 *  busy file costs one missed refresh, never a stalled process (§2). */
export const CHANGE_EVENT_APPEND_TIMEOUT_MS = 250;
/** Rows one relay tick reads; a backlog drains over the following ticks, in id order. */
export const CHANGE_RELAY_BATCH_LIMIT = 200;

/** A change to announce to the other processes: the event, who wrote it and when. */
export type NewChangeEvent = { event: ChangeEvent; origin: string; createdAt: string };

/** A stored row that decoded into an event. `id` is the table's autoincrement key, the relay's cursor. */
export type StoredChangeEvent = { id: number; origin: string; event: ChangeEvent };

/** What reading the table returns per row: an event, or the reason one row could not be decoded (never thrown, so
 *  one bad row cannot block the rows after it). */
export type ChangeEventEntry = StoredChangeEvent | { id: number; skipped: string };

/** What the relay does with one batch: the events to publish locally, the rows to report, the new cursor. */
export type RelayBatchPlan = {
  events: readonly ChangeEvent[];
  skipped: readonly { id: number; skipped: string }[];
  lastId: number;
};
