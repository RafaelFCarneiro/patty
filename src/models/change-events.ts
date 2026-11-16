/** How often a serving process asks whether another process committed (ADR-036 §3, §5: the cross-process latency). */
export const CHANGE_RELAY_POLL_MS = 1000;
/** A change-log row older than this is deleted: the log only bridges the seconds between two processes (§4). The
 *  package requires at least twice the poll interval. */
export const CHANGE_EVENT_RETENTION_MS = 10 * 60 * 1000;
/** How often the relay deletes rows past retention. */
export const CHANGE_EVENT_PRUNE_EVERY_MS = 60 * 1000;
/** Reported with `LOG_PREFIX` when a change notification (a subscriber, an append, the relay) fails. */
export const CHANGE_NOTIFICATION_FAILED = 'change notification failed';
/** Rows one relay tick reads; a backlog drains over the following ticks, in id order. */
export const CHANGE_RELAY_BATCH_LIMIT = 200;
