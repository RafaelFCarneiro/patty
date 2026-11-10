import { LibsqlError } from '@libsql/client';
import type * as LibsqlClient from '@libsql/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const execute = vi.fn();
const close = vi.fn();

vi.mock('@libsql/client', async (importOriginal) => ({
  ...(await importOriginal<typeof LibsqlClient>()),
  createClient: () => ({ execute, close }),
}));

const { withMigrationLock } = await import('../../../../src/diplomat/db/migration-lock.js');

const failureOf = (run: Promise<unknown>): Promise<Error> =>
  run.then(
    () => {
      throw new Error('expected the lock to fail');
    },
    (cause: unknown) => cause as Error,
  );

const busy = () => new LibsqlError('database is locked', 'SQLITE_BUSY');

afterEach(() => {
  vi.useRealTimers();
  execute.mockReset();
  close.mockReset();
});

describe('withMigrationLock — failure paths', () => {
  it('rethrows a failure that is not "busy" at once, never retrying it, and closes the client', async () => {
    const failure = new Error('disk I/O error');
    execute.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN EXCLUSIVE') throw failure;
    });
    const work = vi.fn();

    await expect(withMigrationLock('/data/patty.db', work)).rejects.toBe(failure);
    expect(execute.mock.calls.filter(([sql]) => sql === 'BEGIN EXCLUSIVE')).toHaveLength(1);
    expect(work).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it('gives up after 60 seconds of busy, naming the lock file and keeping the busy error as cause', async () => {
    vi.useFakeTimers();
    const lastBusy = busy();
    execute.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN EXCLUSIVE') throw lastBusy;
    });
    const work = vi.fn();

    const outcome = failureOf(withMigrationLock('/data/patty.db', work));
    await vi.advanceTimersByTimeAsync(61_000);
    const failure = await outcome;

    expect(failure.message).toBe(
      'patty: another PATTY process has held the migration lock (/data/patty.db.migrate.lock) for over 60s. ' +
        'Stop it and retry.',
    );
    expect(failure.cause).toBe(lastBusy);
    expect(work).not.toHaveBeenCalled();
    const attempts = execute.mock.calls.filter(([sql]) => sql === 'BEGIN EXCLUSIVE').length;
    expect(close).toHaveBeenCalledTimes(attempts);
  });
});
