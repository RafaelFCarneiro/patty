import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Driver from '../../../../src/diplomat/db/driver.js';
import type { Db } from '../../../../src/diplomat/db/driver.js';

const mocks = vi.hoisted(() => ({ openSibling: vi.fn(), closeDatabase: vi.fn() }));

vi.mock('../../../../src/diplomat/db/driver.js', async (importOriginal) => ({
  ...(await importOriginal<typeof Driver>()),
  openSibling: mocks.openSibling,
  closeDatabase: mocks.closeDatabase,
}));

const { NEVER_BLOCK_IN_SQLITE_MS } = await import('../../../../src/diplomat/db/driver.js');
const { changeLogStore } = await import('../../../../src/diplomat/db/change-events.js');

const connection = (version: number) => ({ all: vi.fn(async () => [{ data_version: version }]) }) as unknown as Db;

afterEach(() => Object.values(mocks).forEach((mock) => mock.mockReset()));

describe('changeLogStore connection', () => {
  it('opens its connection lazily, once, and shares it between statements', async () => {
    mocks.openSibling.mockResolvedValue(connection(7));
    const store = changeLogStore({} as Db);
    expect(mocks.openSibling).not.toHaveBeenCalled();

    await store.changeToken!();
    await store.changeToken!();

    expect(mocks.openSibling).toHaveBeenCalledTimes(1);
  });

  it('opens its connection with no lock wait inside SQLite (the loop is never blocked)', async () => {
    mocks.openSibling.mockResolvedValue(connection(1));
    const db = {} as Db;

    await changeLogStore(db).changeToken!();

    expect(mocks.openSibling).toHaveBeenCalledWith(db, NEVER_BLOCK_IN_SQLITE_MS);
  });

  it('opens again after a failed open instead of remembering the failure', async () => {
    mocks.openSibling.mockRejectedValueOnce(new Error('cannot open')).mockResolvedValue(connection(9));
    const store = changeLogStore({} as Db);

    await expect(store.changeToken!()).rejects.toThrow('cannot open');

    expect(await store.changeToken!()).toBe(9);
    expect(mocks.openSibling).toHaveBeenCalledTimes(2);
  });

  it('close with nothing opened has no connection to release', async () => {
    await changeLogStore({} as Db).close();

    expect(mocks.closeDatabase).not.toHaveBeenCalled();
  });
});
