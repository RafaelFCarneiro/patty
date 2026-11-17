import type { Client } from '@libsql/client';
import type { Db } from '../../../src/diplomat/db/driver.js';

/** Holds the database's write lock from `db`'s own connection until released. It takes the client's write
 *  transaction: a raw `BEGIN IMMEDIATE` through `execute` stopped holding in @libsql/client 0.18. */
export const holdWriteLock = async (db: Db): Promise<{ release: () => Promise<void> }> => {
  const { $client } = db as Db & { $client: Client };
  const tx = await $client.transaction('write');
  return { release: () => tx.rollback() };
};
