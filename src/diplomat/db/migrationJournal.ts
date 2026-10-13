import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from './driver.js';
import { MIGRATIONS_TABLE } from './migrationBarrier.js';

/** Both halves of "where do migrations stand": what this build ships (its journal) and what a database has applied
 *  (drizzle's bookkeeping table). The safety copy and the version guard each compare the two. */
const JournalSchema = z.object({ entries: z.array(z.object({ tag: z.string(), when: z.number() })) });

/** The migrations this build ships, in journal order. */
export const readJournal = (migrationsFolder: string) =>
  JournalSchema.parse(JSON.parse(readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8'))).entries;

// `undefined` = the migrator has never run here (nothing in the file worth protecting).
export const lastAppliedMillis = async (db: Db): Promise<number | undefined> => {
  const [table] = await db.all<{ name: string }>(
    sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${MIGRATIONS_TABLE}`,
  );
  if (!table) return undefined;
  const [last] = await db.all<{ created_at: number }>(
    sql`SELECT created_at FROM ${sql.identifier(MIGRATIONS_TABLE)} ORDER BY created_at DESC LIMIT 1`,
  );
  return last?.created_at;
};
