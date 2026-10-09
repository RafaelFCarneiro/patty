import { closeSync, existsSync, openSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from './driver.js';
import { DATA_REWRITING_MIGRATIONS } from './migrations.js';
import { withMigrationLock } from './migrationLock.js';

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

// SQLite's own snapshot: `VACUUM INTO` copies the committed state in ONE read transaction, so it is consistent
// even while another process keeps writing, and it carries the same encryption key (a plain file copy after a
// WAL checkpoint cannot promise either — a running writer can commit, or auto-checkpoint, mid-copy). The target
// must be empty or absent; creating it ourselves first, 0600, means it is never readable by anyone else.
const snapshotTo = async (db: Db, destination: string): Promise<void> => {
  rmSync(destination, { force: true });
  closeSync(openSync(destination, 'wx', BACKUP_FILE_MODE));
  await db.run(sql`VACUUM INTO ${destination}`);
};

/**
 * Applies `migrate` — taking the safety copy first when a data-rewriting migration is pending. The copy and
 * the migration run under one cross-process lock, and "is it still pending?" is re-asked once the lock is
 * held, so concurrent starters can neither interleave their copies nor back up an already-migrated file.
 */
export const migrateWithSafetyCopy = async (
  db: Db,
  migrationsFolder: string,
  migrate: () => Promise<void>,
): Promise<void> => {
  const dbFile = await databaseFile(db);
  const needsCopy = (await pendingRewritingTags(db, migrationsFolder)).length > 0;
  if (!needsCopy || dbFile === '' || !existsSync(dbFile)) return migrate();

  return withMigrationLock(dbFile, async () => {
    await backupBeforeRewriting(db, migrationsFolder);
    await migrate();
  });
};

/**
 * Before applying a migration flagged as rewriting existing data (`DATA_REWRITING_MIGRATIONS`), snapshot the
 * database to `<db>.pre-<tag>.bak` (a standalone, consistent, still-encrypted file — no `-wal` needed to
 * restore), logging the path to stderr (never the key). A no-op for a brand-new database, an in-memory one, or
 * when nothing flagged is pending — so a second startup never writes a second backup.
 */
export const backupBeforeRewriting = async (db: Db, migrationsFolder: string): Promise<string[]> => {
  const tags = await pendingRewritingTags(db, migrationsFolder);
  const dbFile = await databaseFile(db);
  if (tags.length === 0 || dbFile === '' || !existsSync(dbFile)) return [];

  const copied: string[] = [];
  for (const tag of tags) {
    const destination = backupPath(dbFile, tag);
    // Snapshot then rename: a crash mid-snapshot never leaves a truncated file under the final name.
    const partial = `${destination}${TEMP_SUFFIX}`;
    await snapshotTo(db, partial);
    renameSync(partial, destination);
    console.error(`fintrack: backed up the database before migration ${tag} → ${destination}`);
    copied.push(destination);
  }
  return copied;
};
