/** How often a serving process asks whether another process committed (ADR-036 §3, §5: the cross-process latency). */
export const CHANGE_RELAY_POLL_MS = 1000;
/** A change-log row older than this is deleted: the log only bridges the seconds between two processes (§4). The
 *  package requires at least twice the poll interval. */
export const CHANGE_EVENT_RETENTION_MS = 10 * 60 * 1000;
/** How often the relay deletes rows past retention. */
export const CHANGE_EVENT_PRUNE_EVERY_MS = 60 * 1000;
/** How long a change-log statement waits for a lock inside SQLite: not at all. libsql's file client is synchronous, so
 *  any wait there blocks the whole event loop — and a lock held by this same process's own open transaction cannot be
 *  released while it does, so it would only burn the wait and fail. A busy statement fails at once and the append waits
 *  asynchronously instead (`CHANGE_EVENT_APPEND_BACKOFF_MS`), letting the lock holder finish (§2). */
export const CHANGE_EVENT_LOCK_WAIT_MS = 0;
/** The pauses between an append's attempts when the database is busy (one attempt more than there are pauses). The
 *  loop is free during each, so another transaction of this process, or a short write of another one, completes; an
 *  append still busy after the last pause fails and costs one missed refresh. */
export const CHANGE_EVENT_APPEND_BACKOFF_MS: readonly number[] = [5, 10, 20, 40, 80];
/** Rows one relay tick reads; a backlog drains over the following ticks, in id order. */
export const CHANGE_RELAY_BATCH_LIMIT = 200;
