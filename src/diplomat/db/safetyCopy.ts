import { createReadStream, createWriteStream, existsSync, readFileSync, renameSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from './driver.js';
import { DATA_REWRITING_MIGRATIONS } from './migrations.js';

const BACKUP_FILE_MODE = 0o600;
const TEMP_SUFFIX = '.tmp';

const JournalSchema = z.object({ entries: z.array(z.object({ tag: z.string(), when: z.number() })) });

/** Where the pre-migration copy of `dbFile` goes (ADR-033 §7) — next to the database, same encrypted
 *  bytes under the same key, so it adds no new exposure. */
export const backupPath = (dbFile: string, migrationTag: string): string => `${dbFile}.pre-${migrationTag}.bak`;

const MIGRATIONS_TABLE = '__drizzle_migrations';
const MAIN_SCHEMA = 'main';

// `undefined` = the migrator has never run here (nothing in the file worth protecting).
const lastAppliedMillis = async (db: Db): Promise<number | undefined> => {
  const [table] = await db.all<{ name: string }>(
    sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${MIGRATIONS_TABLE}`,
  );
  if (!table) return undefined;
  const [last] = await db.all<{ created_at: number }>(
    sql`SELECT created_at FROM ${sql.identifier(MIGRATIONS_TABLE)} ORDER BY created_at DESC LIMIT 1`,
  );
  return last?.created_at;
};

/** Tags of the data-rewriting migrations that are about to run against a database that already holds
 *  applied migrations — i.e. against data worth a safety copy. Mirrors drizzle's own "pending" rule
 *  (a journal entry newer than the last applied one). Empty for a brand-new database. */
export const pendingRewritingTags = async (db: Db, migrationsFolder: string): Promise<string[]> => {
  const lastApplied = await lastAppliedMillis(db);
  if (lastApplied === undefined) return [];
  const journal = JournalSchema.parse(
    JSON.parse(readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8')),
  );
  return journal.entries
    .filter(({ when }) => when > lastApplied)
    .map(({ tag }) => tag)
    .filter((tag) => DATA_REWRITING_MIGRATIONS.includes(tag));
};

const databaseFile = async (db: Db): Promise<string> => {
  const rows = await db.all<{ name: string; file: string }>(sql`PRAGMA database_list`);
  return rows.find(({ name }) => name === MAIN_SCHEMA)?.file ?? '';
};

// TRUNCATE folds the WAL into the main file so a plain file copy is a complete snapshot. A busy
// checkpoint means another connection is mid-transaction — copying then could miss committed pages,
// so refuse to proceed rather than migrate with a safety copy that might be incomplete.
const checkpointWal = async (db: Db): Promise<void> => {
  const [result] = await db.all<{ busy: number }>(sql`PRAGMA wal_checkpoint(TRUNCATE)`);
  if (result && result.busy !== 0) {
    throw new Error(
      'fintrack: cannot take the pre-migration backup — the database is busy (another FinTrack process is ' +
        'writing). Stop the other process and retry.',
    );
  }
};

/**
 * Before applying a migration flagged as rewriting existing data (`DATA_REWRITING_MIGRATIONS`),
 * checkpoint the WAL and copy the database file to `<db>.pre-<tag>.bak`, logging the path to stderr
 * (never the key). A no-op for a brand-new database, an in-memory one, or when nothing flagged is
 * pending — so a second startup never writes a second backup.
 */
export const backupBeforeRewriting = async (db: Db, migrationsFolder: string): Promise<string[]> => {
  const tags = await pendingRewritingTags(db, migrationsFolder);
  const dbFile = await databaseFile(db);
  if (tags.length === 0 || dbFile === '' || !existsSync(dbFile)) return [];

  await checkpointWal(db);
  const copied: string[] = [];
  for (const tag of tags) {
    const destination = backupPath(dbFile, tag);
    // Copy then rename: a crash mid-copy never leaves a truncated file under the final name. The file is
    // created 0600 from the start (`mode`), so there is no moment it is readable by anyone else.
    const partial = `${destination}${TEMP_SUFFIX}`;
    await pipeline(createReadStream(dbFile), createWriteStream(partial, { mode: BACKUP_FILE_MODE }));
    renameSync(partial, destination);
    console.error(`fintrack: backed up the database before migration ${tag} → ${destination}`);
    copied.push(destination);
  }
  return copied;
};
