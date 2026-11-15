import type { ChangeLogStore } from '@rfc0/effect-runner';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../../../src/diplomat/db/driver.js';
import {
  CHANGE_EVENT_PRUNE_EVERY_MS,
  CHANGE_EVENT_RETENTION_MS,
  CHANGE_RELAY_BATCH_LIMIT,
  CHANGE_RELAY_POLL_MS,
} from '../../../src/models/change-events.js';
import type { ChangeEvent } from '../../../src/models/tenancy.js';

const mocks = vi.hoisted(() => ({ changeLogStore: vi.fn() }));

vi.mock('../../../src/diplomat/db/change-events.js', () => ({ changeLogStore: mocks.changeLogStore }));

const { createChangeLog, startServingRelay } = await import('../../../src/composition/change-log.js');

const fakeStore = (overrides: Partial<ChangeLogStore<ChangeEvent> & { close: () => Promise<void> }> = {}) => ({
  append: vi.fn(async () => undefined),
  latestId: vi.fn(async () => 0),
  readAfter: vi.fn(async () => []),
  pruneBefore: vi.fn(async () => undefined),
  close: vi.fn(async () => undefined),
  ...overrides,
});

afterEach(() => {
  mocks.changeLogStore.mockReset();
  vi.restoreAllMocks();
});

describe('PATTY’s relay policy', () => {
  it('keeps every row for at least twice the poll interval, as the package requires', () => {
    expect(CHANGE_EVENT_RETENTION_MS).toBeGreaterThanOrEqual(2 * CHANGE_RELAY_POLL_MS);
    expect(CHANGE_EVENT_PRUNE_EVERY_MS).toBeGreaterThan(0);
    expect(CHANGE_RELAY_BATCH_LIMIT).toBeGreaterThan(0);
  });
});

describe('startServingRelay', () => {
  it('starts a relay on the runtime’s store with PATTY’s values, and stop releases its timers', async () => {
    const store = fakeStore();
    mocks.changeLogStore.mockReturnValue(store);
    const { changeLog } = createChangeLog({} as Db, vi.fn());

    const relay = await startServingRelay({ changeLog });

    expect(relay).not.toBeNull();
    expect(store.latestId).toHaveBeenCalledOnce();
    await relay?.stop();
  });

  it('reports a relay that cannot start and answers null, so the process runs without it', async () => {
    const report = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failure = new Error('no such table');
    mocks.changeLogStore.mockReturnValue(fakeStore({ latestId: vi.fn(async () => Promise.reject(failure)) }));
    const { changeLog } = createChangeLog({} as Db, vi.fn());

    expect(await startServingRelay({ changeLog })).toBeNull();

    expect(report).toHaveBeenCalledWith('[patty] change notification failed:', failure);
  });
});

describe('createChangeLog', () => {
  it('close waits for the queued appends, then releases the store', async () => {
    const order: string[] = [];
    const store = fakeStore({
      append: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push('append');
      }),
      close: vi.fn(async () => void order.push('close')),
    });
    mocks.changeLogStore.mockReturnValue(store);
    const { changeBus, changeLog } = createChangeLog({} as Db, vi.fn());

    changeBus.publish({ userId: 'u1', entities: ['account'] });
    await changeLog.close();

    expect(order).toEqual(['append', 'close']);
  });

  it('gives every process its own origin and announces only events that name an entity', async () => {
    const store = fakeStore();
    mocks.changeLogStore.mockReturnValue(store);
    const first = createChangeLog({} as Db, vi.fn());
    const second = createChangeLog({} as Db, vi.fn());

    first.changeBus.publish({ userId: null, entities: [] });
    first.changeBus.publish({ userId: 'u1', entities: ['tag'] });
    await first.changeLog.settled();

    expect(first.changeLog.origin).not.toBe(second.changeLog.origin);
    expect(store.append).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ origin: first.changeLog.origin, event: { userId: 'u1', entities: ['tag'] } }),
    );
  });
});
