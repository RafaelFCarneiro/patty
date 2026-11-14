import { createChangeBus, type ChangeBus } from '@rfc0/effect-runner';
import { append, openChangeLog } from '../diplomat/db/change-events.js';
import { closeDatabase, type Db } from '../diplomat/db/driver.js';
import { isWorthAnnouncing } from '../logic/change-events.js';
import type { ChangeEvent } from '../models/tenancy.js';

/** stderr only — stdout carries the stdio MCP protocol (ADR-007). */
export const reportChangeError = (cause: unknown): void => {
  console.error('[patty] change notification failed:', cause);
};

export type AppendingBusOptions = {
  db: Db;
  /** This process's id, written on every row so the relay of another process (and this one) can tell whose it is. */
  origin: string;
  clock: () => Date;
  /** Receives a failing listener (the bus's own) and a failed append: stderr, never stdout (ADR-007). */
  onError: (cause: unknown) => void;
};

export type AppendingBus = {
  /** The engine's `ChangeBus` over this process: `publish` tells local subscribers first, then appends a row. */
  bus: ChangeBus<ChangeEvent>;
  /** The local bus alone: what a relay publishes on, so a relayed event is never appended again (no echo). */
  publishLocal: (event: ChangeEvent) => void;
  /** Resolves once every append requested so far has been written or has failed. */
  settled: () => Promise<void>;
  /** Releases the log connection. */
  close: () => Promise<void>;
};

/**
 * ADR-036 §2: `@rfc0/effect-runner`'s `ChangeBus` implemented over the database. Local subscribers run first, so a
 * browser on this process still updates at once; the append that tells the other processes follows as a separate,
 * best-effort write on its own short-waiting connection. It is queued, never awaited by `publish`: a busy or closed
 * database costs one missed refresh (§4's resync repairs it), never a failed or delayed write. Appends keep
 * `publish` order.
 */
export const createAppendingBus = ({ db, origin, clock, onError }: AppendingBusOptions): AppendingBus => {
  const local = createChangeBus<ChangeEvent>({ onError });
  const log = { opened: undefined as Promise<Db> | undefined };
  // A failed open is forgotten, so the next append tries again; a failed insert keeps the connection (it is only busy).
  const openOnce = (): Promise<Db> =>
    (log.opened ??= openChangeLog(db).catch((cause: unknown) => {
      log.opened = undefined;
      throw cause;
    }));
  const queue = { tail: Promise.resolve() };

  const appendLater = (event: ChangeEvent): void => {
    queue.tail = queue.tail
      .then(async () => append(await openOnce(), { event, origin, createdAt: clock().toISOString() }))
      .catch(onError)
      // A reporter that throws (a closed stderr) must not poison every later append.
      .catch(() => undefined);
  };

  return {
    bus: {
      publish: (event) => {
        local.publish(event);
        if (isWorthAnnouncing(event)) appendLater(event);
      },
      subscribe: local.subscribe,
    },
    publishLocal: local.publish,
    settled: () => queue.tail,
    close: async () => {
      await queue.tail;
      const opened = log.opened;
      log.opened = undefined;
      if (opened) closeDatabase(await opened);
    },
  };
};
