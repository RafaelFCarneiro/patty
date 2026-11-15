import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../../../src/diplomat/db/driver.js';
import type { ChangeEventEntry } from '../../../src/models/change-events.js';

const mocks = vi.hoisted(() => ({
  openChangeLog: vi.fn(),
  dataVersion: vi.fn(),
  latestId: vi.fn(),
  readAfter: vi.fn(),
  pruneBefore: vi.fn(),
  closeDatabase: vi.fn(),
}));

vi.mock('../../../src/diplomat/db/change-events.js', () => ({
  openChangeLog: mocks.openChangeLog,
  dataVersion: mocks.dataVersion,
  latestId: mocks.latestId,
  readAfter: mocks.readAfter,
  pruneBefore: mocks.pruneBefore,
}));
vi.mock('../../../src/diplomat/db/driver.js', () => ({ closeDatabase: mocks.closeDatabase }));

const { startChangeRelay } = await import('../../../src/composition/change-relay.js');

const LOG = { tag: 'log' } as unknown as Db;
const NOW = new Date('2026-11-14T12:00:00.000Z');
const POLL_MS = 100;
const PRUNE_MS = 1000;
const RETENTION_MS = 5000;

const entry = (id: number, entities: string[]): ChangeEventEntry => ({
  id,
  origin: 'other',
  event: { userId: 'u1', entities },
});

const start = () => {
  const publishLocal = vi.fn();
  const onError = vi.fn();
  const relay = startChangeRelay({
    db: {} as Db,
    publishLocal,
    origin: 'me',
    clock: () => NOW,
    pollMs: POLL_MS,
    retentionMs: RETENTION_MS,
    pruneEveryMs: PRUNE_MS,
    onError,
  });
  return { relay, publishLocal, onError };
};

beforeEach(() => {
  vi.useFakeTimers();
  mocks.openChangeLog.mockResolvedValue(LOG);
  mocks.latestId.mockResolvedValue(10);
  mocks.dataVersion.mockResolvedValue(1);
  mocks.readAfter.mockResolvedValue([]);
  mocks.pruneBefore.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  Object.values(mocks).forEach((mock) => mock.mockReset());
});

describe('startChangeRelay', () => {
  it('starts after the newest row and reads the other origins’ rows past it on the first tick', async () => {
    const { relay, publishLocal } = start();
    const { stop } = await relay;
    mocks.readAfter.mockResolvedValueOnce([entry(11, ['account'])]);

    await vi.advanceTimersByTimeAsync(POLL_MS);

    expect(mocks.readAfter).toHaveBeenCalledWith(LOG, 10, 'me', expect.any(Number));
    expect(publishLocal).toHaveBeenCalledExactlyOnceWith({ userId: 'u1', entities: ['account'] });
    await stop();
  });

  it('reads nothing while the data version has not moved, and again once it does', async () => {
    const { relay } = start();
    const { stop } = await relay;
    await vi.advanceTimersByTimeAsync(POLL_MS);
    mocks.readAfter.mockClear();

    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    expect(mocks.readAfter).not.toHaveBeenCalled();

    mocks.dataVersion.mockResolvedValue(2);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(mocks.readAfter).toHaveBeenCalledTimes(1);
    await stop();
  });

  it('moves the cursor past the rows it handled, skipped ones included, and reports the skipped', async () => {
    const { relay, publishLocal, onError } = start();
    const { stop } = await relay;
    mocks.readAfter.mockResolvedValueOnce([{ id: 11, skipped: 'entities is not valid JSON' }, entry(12, ['tag'])]);
    await vi.advanceTimersByTimeAsync(POLL_MS);

    mocks.dataVersion.mockResolvedValue(2);
    await vi.advanceTimersByTimeAsync(POLL_MS);

    expect(publishLocal).toHaveBeenCalledExactlyOnceWith({ userId: 'u1', entities: ['tag'] });
    expect(onError).toHaveBeenCalledExactlyOnceWith(
      new Error('change_events row 11 skipped: entities is not valid JSON'),
    );
    expect(mocks.readAfter).toHaveBeenLastCalledWith(LOG, 12, 'me', expect.any(Number));
    await stop();
  });

  it('reports a failing tick and still runs the next one, retrying the same rows', async () => {
    const { relay, publishLocal, onError } = start();
    const { stop } = await relay;
    const failure = new Error('database is locked');
    mocks.readAfter.mockRejectedValueOnce(failure).mockResolvedValueOnce([entry(11, ['bill'])]);

    await vi.advanceTimersByTimeAsync(POLL_MS * 2);

    expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
    expect(publishLocal).toHaveBeenCalledExactlyOnceWith({ userId: 'u1', entities: ['bill'] });
    expect(mocks.readAfter).toHaveBeenNthCalledWith(2, LOG, 10, 'me', expect.any(Number));
    await stop();
  });

  it('never starts a tick while the previous one is still running', async () => {
    const { relay } = start();
    const { stop } = await relay;
    let finish: () => void = () => undefined;
    mocks.readAfter.mockImplementation(() => new Promise<never[]>((resolve) => (finish = () => resolve([]))));

    await vi.advanceTimersByTimeAsync(POLL_MS * 5);
    expect(mocks.readAfter).toHaveBeenCalledTimes(1);

    finish();
    await stop();
  });

  it('prunes rows older than retention on its own interval, and reports a failing prune', async () => {
    const { relay, onError } = start();
    const { stop } = await relay;
    const failure = new Error('prune failed');
    mocks.pruneBefore.mockRejectedValueOnce(failure).mockResolvedValue(undefined);

    await vi.advanceTimersByTimeAsync(PRUNE_MS * 2);

    expect(mocks.pruneBefore).toHaveBeenCalledWith(LOG, '2026-11-14T11:59:55.000Z');
    expect(mocks.pruneBefore).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
    await stop();
  });

  it('stop clears both timers and releases the connection once the run in flight has finished', async () => {
    const { relay } = start();
    const { stop } = await relay;

    await stop();
    await vi.advanceTimersByTimeAsync(PRUNE_MS * 3);

    expect(mocks.dataVersion).not.toHaveBeenCalled();
    expect(mocks.pruneBefore).not.toHaveBeenCalled();
    expect(mocks.closeDatabase).toHaveBeenCalledExactlyOnceWith(LOG);
  });

  it('keeps reading while a full batch may have left rows behind, even if the version stood still', async () => {
    const { relay } = start();
    const { stop } = await relay;
    const full = Array.from({ length: 200 }, (_, index) => entry(11 + index, ['tag']));
    mocks.readAfter.mockResolvedValueOnce(full);
    await vi.advanceTimersByTimeAsync(POLL_MS);

    await vi.advanceTimersByTimeAsync(POLL_MS);

    expect(mocks.readAfter).toHaveBeenCalledTimes(2);
    expect(mocks.readAfter).toHaveBeenLastCalledWith(LOG, 210, 'me', expect.any(Number));
    await stop();
  });

  it('releases the log connection when initialization fails after it opened', async () => {
    mocks.latestId.mockRejectedValue(new Error('no such table'));

    await expect(start().relay).rejects.toThrow('no such table');

    expect(mocks.closeDatabase).toHaveBeenCalledExactlyOnceWith(LOG);
  });

  it('does not start when the log connection cannot be opened', async () => {
    mocks.openChangeLog.mockRejectedValue(new Error('cannot open'));

    await expect(start().relay).rejects.toThrow('cannot open');
  });
});
