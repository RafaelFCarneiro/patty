import { LibsqlError } from '@libsql/client';
import type * as LibsqlClient from '@libsql/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const execute = vi.fn();
const close = vi.fn();

vi.mock('@libsql/client', async (importOriginal) => ({
  ...(await importOriginal<typeof LibsqlClient>()),
  createClient: () => ({ execute, close }),
}));

const { NEVER_BLOCK_IN_SQLITE_MS, tryExclusiveLock, waitForExclusiveLock } =
  await import('../../../../src/diplomat/db/file-lock.js');
const { withMigrationLock } = await import('../../../../src/diplomat/db/migration-lock.js');

const wrappedBusy = () => new Error('query failed', { cause: new LibsqlError('database is locked', 'SQLITE_BUSY') });
const statementsRun = (): string[] => execute.mock.calls.map(([sql]) => sql as string);

afterEach(() => {
  vi.useRealTimers();
  execute.mockReset();
  close.mockReset();
});

describe('tryExclusiveLock', () => {
  it('never blocks inside SQLite, then takes the exclusive transaction', async () => {
    execute.mockResolvedValue(undefined);
    const lock = await tryExclusiveLock('/data/demo.db.lock');
    expect(lock).not.toBeNull();
    expect(statementsRun()).toEqual([`PRAGMA busy_timeout = ${NEVER_BLOCK_IN_SQLITE_MS}`, 'BEGIN EXCLUSIVE']);
  });

  it('is null, with the client closed, when the busy error arrives wrapped as a cause', async () => {
    execute.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN EXCLUSIVE') throw wrappedBusy();
    });
    expect(await tryExclusiveLock('/data/demo.db.lock')).toBeNull();
    expect(close).toHaveBeenCalledOnce();
  });

  it('rethrows what is not busy, with the client closed', async () => {
    const failure = new Error('disk I/O error');
    execute.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN EXCLUSIVE') throw failure;
    });
    await expect(tryExclusiveLock('/data/demo.db.lock')).rejects.toBe(failure);
    expect(close).toHaveBeenCalledOnce();
  });

  it('releases without throwing when the rollback fails, and still closes the client', async () => {
    execute.mockImplementation(async (sql: string) => {
      if (sql === 'ROLLBACK') throw new Error('rollback failed');
    });
    const lock = await tryExclusiveLock('/data/demo.db.lock');
    await expect(lock?.release()).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledOnce();
  });
});

describe('withMigrationLock on the shared helper', () => {
  it('treats a wrapped busy error as busy, polling until the deadline with it as the cause', async () => {
    vi.useFakeTimers();
    const busy = wrappedBusy();
    execute.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN EXCLUSIVE') throw busy;
    });
    const outcome = withMigrationLock('/data/fintrack.db', vi.fn()).then(
      () => undefined,
      (cause: Error) => cause,
    );
    await vi.advanceTimersByTimeAsync(61_000);
    expect((await outcome)?.cause).toBe(busy);
  });

  it('never lets a failing rollback hide the error the work threw', async () => {
    const failure = new Error('the work failed');
    execute.mockImplementation(async (sql: string) => {
      if (sql === 'ROLLBACK') throw new Error('rollback failed');
    });
    await expect(
      withMigrationLock('/data/fintrack.db', async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(close).toHaveBeenCalledOnce();
  });
});

describe('waitForExclusiveLock', () => {
  const wait = { waitMs: 200, retryMs: 50, timeoutMessage: 'the lock stayed busy' };

  it('polls to the deadline, then fails with the given message, the busy error as cause, client closed', async () => {
    vi.useFakeTimers();
    const busy = wrappedBusy();
    execute.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN EXCLUSIVE') throw busy;
    });
    const outcome = waitForExclusiveLock('/data/x.lock', wait).then(
      () => undefined,
      (cause: Error) => cause,
    );
    await vi.advanceTimersByTimeAsync(300);
    const failure = await outcome;
    expect(failure?.message).toBe(wait.timeoutMessage);
    expect(failure?.cause).toBe(busy);
    expect(close).toHaveBeenCalledTimes(statementsRun().filter((sql) => sql === 'BEGIN EXCLUSIVE').length);
  });

  it('closes the client of every busy attempt, not only the one that takes the lock', async () => {
    vi.useFakeTimers();
    let busyAttempts = 2;
    execute.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN EXCLUSIVE' && busyAttempts-- > 0) throw wrappedBusy();
    });
    const acquiring = waitForExclusiveLock('/data/x.lock', wait);
    await vi.advanceTimersByTimeAsync(100);
    const lock = await acquiring;
    await lock.release();
    expect(statementsRun().filter((sql) => sql === 'BEGIN EXCLUSIVE')).toHaveLength(3);
    expect(statementsRun()).toContain('ROLLBACK');
    expect(close).toHaveBeenCalledTimes(3);
  });
});
