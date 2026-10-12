import * as R from 'remeda';
import { version } from '../../common/buildVersion.js';
import { isDatabaseAhead } from '../../logic/migration.js';
import { databaseAheadMessage } from '../../models/database.js';
import type { Db } from './driver.js';
import { lastAppliedMillis, readJournal } from './safetyCopy.js';

/** Thrown by `assertDatabaseNotAhead`; an entrypoint prints `message` as is (it is already a complete diagnosis). */
export class DatabaseAheadError extends Error {
  constructor(version: string) {
    super(databaseAheadMessage(version));
    this.name = 'DatabaseAheadError';
  }
}

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
