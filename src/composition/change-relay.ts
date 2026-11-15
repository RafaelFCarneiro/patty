import { dataVersion, latestId, openChangeLog, pruneBefore, readAfter } from '../diplomat/db/change-events.js';
import { reportChangeError } from './change-log.js';
import type { Runtime } from './runtime.js';
import { closeDatabase, type Db } from '../diplomat/db/driver.js';
import { planRelayBatch, pruneCutoff, shouldLook } from '../logic/change-events.js';
import {
  CHANGE_EVENT_PRUNE_EVERY_MS,
  CHANGE_EVENT_RETENTION_MS,
  CHANGE_RELAY_BATCH_LIMIT,
  CHANGE_RELAY_POLL_MS,
} from '../models/change-events.js';
import type { ChangeEvent } from '../models/tenancy.js';

export type ChangeRelayOptions = {
  db: Db;
  /** Publishes on this process's bus only — never the appending one, or rows would echo between processes. */
  publishLocal: (event: ChangeEvent) => void;
  origin: string;
  clock: () => Date;
  pollMs: number;
  retentionMs: number;
  pruneEveryMs: number;
  /** Receives a failing tick, a failing prune and every row that did not decode: stderr (ADR-007). */
  onError: (cause: unknown) => void;
};

export type ChangeRelay = { stop: () => Promise<void> };

type Cursor = { lastId: number; version: number | null };

const describeSkipped = ({ id, skipped }: { id: number; skipped: string }): Error =>
  new Error(`change_events row ${id} skipped: ${skipped}`);

/** One tick: look only when another connection committed; then read past the cursor, publish locally, advance. The
 *  version moves only after the rows were handled, so a failed read is retried next tick. */
const relayOnce = async (log: Db, options: ChangeRelayOptions, cursor: Cursor): Promise<void> => {
  const version = await dataVersion(log);
  if (!shouldLook(cursor.version, version)) return;
  const entries = await readAfter(log, cursor.lastId, options.origin, CHANGE_RELAY_BATCH_LIMIT);
  const plan = planRelayBatch(cursor.lastId, entries);
  plan.skipped.forEach((row) => options.onError(describeSkipped(row)));
  plan.events.forEach((event) => options.publishLocal(event));
  cursor.lastId = plan.lastId;
  // A full batch may leave more behind: leave the version stale so the next tick reads on.
  cursor.version = entries.length < CHANGE_RELAY_BATCH_LIMIT ? version : null;
};

/** A repeating job that never overlaps itself (a slow tick is not started twice) and reports a failure instead of
 *  stopping: the next interval still runs. `idle` resolves when the run in flight, if any, has finished. */
const repeating = (onError: (cause: unknown) => void, work: () => Promise<void>) => {
  const state = { busy: false, running: Promise.resolve() };
  const run = (): void => {
    if (state.busy) return;
    state.busy = true;
    state.running = work()
      .catch(onError)
      .finally(() => {
        state.busy = false;
      });
  };
  return { run, idle: () => state.running };
};

/**
 * ADR-036 §3: the reading half. Starts at the newest row (no replay); every `pollMs` it asks SQLite whether another
 * connection committed and, only then, publishes the other processes' rows on the local bus. Every `pruneEveryMs` it
 * deletes rows past retention. A failing tick or prune is reported and the next one still runs; timers never keep the
 * process alive. Resolves once the cursor is in place, so a write made after it returns is always seen.
 */
export const startChangeRelay = async (options: ChangeRelayOptions): Promise<ChangeRelay> => {
  const log = await openChangeLog(options.db);
  // No version yet, so the first tick always reads past the cursor: a commit between `latestId` and a version
  // baseline would otherwise be absorbed into that baseline and never looked at.
  // A failure here leaves no relay whose `stop` could release the connection, so release it before propagating.
  const cursor: Cursor = {
    lastId: await latestId(log).catch((cause: unknown) => {
      closeDatabase(log);
      throw cause;
    }),
    version: null,
  };

  const tick = repeating(options.onError, () => relayOnce(log, options, cursor));
  const prune = repeating(options.onError, () => pruneBefore(log, pruneCutoff(options.clock(), options.retentionMs)));
  const timers = [setInterval(tick.run, options.pollMs), setInterval(prune.run, options.pruneEveryMs)];
  timers.forEach((timer) => timer.unref());

  return {
    stop: async () => {
      timers.forEach(clearInterval);
      await Promise.all([tick.idle(), prune.idle()]);
      closeDatabase(log);
    },
  };
};

/** The relay of a process that serves a dashboard (ADR-036 §3), with the product's intervals. A relay that cannot start
 *  is reported and answers `null`: the dashboard then updates from this process's own writes only, as before. */
export const startServingRelay = (db: Db, { changeLog }: Pick<Runtime, 'changeLog'>): Promise<ChangeRelay | null> =>
  startChangeRelay({
    db,
    publishLocal: changeLog.publishLocal,
    origin: changeLog.origin,
    clock: () => new Date(),
    pollMs: CHANGE_RELAY_POLL_MS,
    retentionMs: CHANGE_EVENT_RETENTION_MS,
    pruneEveryMs: CHANGE_EVENT_PRUNE_EVERY_MS,
    onError: reportChangeError,
  }).catch((cause: unknown) => {
    reportChangeError(cause);
    return null;
  });
