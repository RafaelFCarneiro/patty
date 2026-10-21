import { createClient } from '@libsql/client';
import { count, getTableName } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { pathToFileURL } from 'node:url';
import type { ExportedRowCounts } from '../../models/export.js';
import { accounts, transactions } from './schema.js';

const COUNTED_TABLES = [accounts, transactions];

const countOf = async (db: ReturnType<typeof drizzle>, table: (typeof COUNTED_TABLES)[number]) => {
  const [row] = await db.select({ rows: count() }).from(table);
  return [getTableName(table), row?.rows ?? 0] as const;
};

/** Reads the row counts of a snapshot with its key, on a connection of its own: no WAL switch, no migration, so the
 *  file stays exactly what `VACUUM INTO` wrote. Doubles as proof that the snapshot opens with the key. */
export const countSnapshotRows = async (file: string, encryptionKey: string): Promise<ExportedRowCounts> => {
  const client = createClient({ url: pathToFileURL(file).href, encryptionKey });
  try {
    const db = drizzle(client);
    return Object.fromEntries(await Promise.all(COUNTED_TABLES.map((table) => countOf(db, table))));
  } finally {
    client.close();
  }
};
