import { randomUUID } from 'node:crypto';
import { createRelayedChangeBus, startChangeRelay, type ChangeBus, type ChangeRelay } from '@rfc0/effect-runner';
import { changeLogStore, type SqliteChangeLog } from '../diplomat/db/change-events.js';
import type { Db } from '../diplomat/db/driver.js';
import { isWorthAnnouncing } from '../logic/change-events.js';
import {
  CHANGE_EVENT_PRUNE_EVERY_MS,
  CHANGE_EVENT_RETENTION_MS,
  CHANGE_RELAY_BATCH_LIMIT,
  CHANGE_RELAY_POLL_MS,
} from '../models/change-events.js';
import type { ChangeEvent } from '../models/tenancy.js';

/** stderr only — stdout carries the stdio MCP protocol (ADR-007). */
export const reportChangeError = (cause: unknown): void => {
  console.error('[patty] change notification failed:', cause);
};

/** What a relay and a clean shutdown need of the relayed bus (ADR-036): this process's id, the store, the local-only
 *  publish that never appends, and `close` — wait for the appends in flight, then release the store. */
export type ChangeLog = {
  origin: string;
  store: SqliteChangeLog;
  publishLocal: (event: ChangeEvent) => void;
  settled: () => Promise<void>;
  close: () => Promise<void>;
};

/** The process's change bus (ADR-036 §2): `@rfc0/effect-runner`'s relayed bus over the SQLite store, so a publish
 *  reaches this process's subscribers first and the other processes' relays after. A subscriber's failure and a failed
 *  append go to `onError`, never to the write. */
export const createChangeLog = (
  db: Db,
  onError: (cause: unknown) => void,
): { changeBus: ChangeBus<ChangeEvent>; changeLog: ChangeLog } => {
  const origin = randomUUID();
  const store = changeLogStore(db);
  const { bus, publishLocal, settled } = createRelayedChangeBus({
    store,
    origin,
    onError,
    shouldAppend: isWorthAnnouncing,
  });
  const close = async (): Promise<void> => {
    await settled();
    await store.close();
  };
  return { changeBus: bus, changeLog: { origin, store, publishLocal, settled, close } };
};

/**
 * The relay of a process that serves a dashboard (ADR-036 §3), with PATTY's policy values: `@rfc0/effect-runner`
 * owns the loop, PATTY the store and these numbers. A relay that cannot start — a failing store, or the package's
 * `RangeError` for invalid options — is reported and answers `null`: the dashboard then updates from this process's own
 * writes only, as before.
 */
export const startServingRelay = ({ changeLog }: { changeLog: ChangeLog }): Promise<ChangeRelay | null> =>
  startChangeRelay({
    store: changeLog.store,
    publishLocal: changeLog.publishLocal,
    origin: changeLog.origin,
    pollMs: CHANGE_RELAY_POLL_MS,
    retentionMs: CHANGE_EVENT_RETENTION_MS,
    pruneEveryMs: CHANGE_EVENT_PRUNE_EVERY_MS,
    batchLimit: CHANGE_RELAY_BATCH_LIMIT,
    onError: reportChangeError,
  }).catch((cause: unknown) => {
    reportChangeError(cause);
    return null;
  });
