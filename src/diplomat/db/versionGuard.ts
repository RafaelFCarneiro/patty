import * as R from 'remeda';
import { version } from '../../common/buildVersion.js';
import { DatabaseAheadError } from '../../common/databaseAhead.js';
import { isDatabaseAhead } from '../../logic/migration.js';
import type { Db } from './driver.js';
import { lastAppliedMillis, readJournal } from './migrationJournal.js';

/**
 * Refuses to go on when the database's newest applied migration is newer than the newest this build ships — a
 * stale `npx` or global install pointed at a database a later release has migrated. Read-only: the only things it
 * touches are `__drizzle_migrations` and the journal, and it runs before anything is copied, migrated or seeded
 * (`bootstrap` calls it first), so a refusal writes nothing.
 */
export const assertDatabaseNotAhead = async (db: Db, migrationsFolder: string): Promise<void> => {
  const newestKnown = R.firstBy(readJournal(migrationsFolder), [({ when }) => when, 'desc'])?.when ?? 0;
  if (isDatabaseAhead(await lastAppliedMillis(db), newestKnown)) throw new DatabaseAheadError(version);
};
