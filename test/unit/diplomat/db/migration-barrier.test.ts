import { fileURLToPath } from 'node:url';
import { LibsqlError } from '@libsql/client';
import { describe, expect, it, vi } from 'vitest';
import { applyPendingMigrationsHolding } from '../../../../src/diplomat/db/migration-barrier.js';
import type { Db } from '../../../../src/diplomat/db/driver.js';

const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../../../drizzle', import.meta.url));

const fakeDb = (client: unknown): Db => ({ $client: client }) as unknown as Db;

describe('applyPendingMigrationsHolding — failure paths', () => {
  it('rethrows a non-busy failure to open the write barrier untouched', async () => {
    const failure = new Error('disk I/O error');
    const client = {
      execute: vi.fn().mockResolvedValue({ rows: [] }),
      transaction: vi.fn().mockRejectedValue(failure),
    };

    await expect(applyPendingMigrationsHolding(fakeDb(client), MIGRATIONS_FOLDER, async () => undefined)).rejects.toBe(
      failure,
    );
  });

  it('explains a busy database in operator terms, keeping the driver error as the cause', async () => {
    const busy = new LibsqlError('database is locked', 'SQLITE_BUSY');
    const client = { execute: vi.fn().mockResolvedValue({ rows: [] }), transaction: vi.fn().mockRejectedValue(busy) };

    const failure = await applyPendingMigrationsHolding(fakeDb(client), MIGRATIONS_FOLDER, async () => undefined).then(
      () => {
        throw new Error('expected the upgrade to fail');
      },
      (cause: unknown) => cause as Error,
    );

    expect(failure.message).toContain('another FinTrack process is writing to the database');
    expect(failure.cause).toBe(busy);
  });

  it('never lets a failing rollback hide the error that caused it, and still releases the connection', async () => {
    const cause = new Error('migration exploded');
    const barrier = {
      execute: vi.fn().mockRejectedValue(cause),
      rollback: vi.fn().mockRejectedValue(new Error('transaction closed')),
      commit: vi.fn(),
      close: vi.fn(),
    };
    const client = {
      execute: vi.fn().mockResolvedValue({ rows: [] }),
      transaction: vi.fn().mockResolvedValue(barrier),
    };

    await expect(applyPendingMigrationsHolding(fakeDb(client), MIGRATIONS_FOLDER, async () => undefined)).rejects.toBe(
      cause,
    );
    expect(barrier.rollback).toHaveBeenCalledOnce();
    expect(barrier.commit).not.toHaveBeenCalled();
    expect(barrier.close).toHaveBeenCalledOnce();
    expect(client.execute).toHaveBeenLastCalledWith(expect.stringContaining('PRAGMA busy_timeout'));
  });
});
