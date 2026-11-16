import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as LibsqlClient from '@libsql/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const libsql = vi.hoisted(() => ({ createClient: vi.fn() }));

vi.mock('@libsql/client', async (importOriginal) => ({
  ...(await importOriginal<typeof LibsqlClient>()),
  createClient: libsql.createClient,
}));

const { openDatabaseWithKey, openSibling } = await import('../../../../src/diplomat/db/driver.js');

const client = (execute: () => Promise<unknown>) => ({ execute: vi.fn(execute), close: vi.fn() });
const WAL_ROW = { rows: [{ journal_mode: 'wal' }] };

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'patty-sibling-'));
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  libsql.createClient.mockReset();
  rmSync(dir, { recursive: true, force: true });
});

describe('openSibling — releasing what it opened', () => {
  it('closes the sibling client when its busy_timeout setup fails, then rethrows', async () => {
    const main = client(async () => WAL_ROW);
    const failure = new Error('database is locked');
    const sibling = client(async () => Promise.reject(failure));
    libsql.createClient.mockReturnValueOnce(main).mockReturnValueOnce(sibling);
    const db = await openDatabaseWithKey({ DB_PATH: join(dir, 'p.db') }, 'a'.repeat(64));

    await expect(openSibling(db, 50)).rejects.toBe(failure);

    expect(sibling.close).toHaveBeenCalledOnce();
    expect(main.close).not.toHaveBeenCalled();
  });

  it('keeps the sibling open when its setup succeeds: closing is the caller’s', async () => {
    const main = client(async () => WAL_ROW);
    const sibling = client(async () => ({ rows: [] }));
    libsql.createClient.mockReturnValueOnce(main).mockReturnValueOnce(sibling);
    const db = await openDatabaseWithKey({ DB_PATH: join(dir, 'p.db') }, 'a'.repeat(64));

    await openSibling(db, 50);

    expect(sibling.execute).toHaveBeenCalledWith('PRAGMA busy_timeout = 50');
    expect(sibling.close).not.toHaveBeenCalled();
  });
});
