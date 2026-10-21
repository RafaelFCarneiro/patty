import * as R from 'remeda';
import { version } from '../../common/build-version.js';
import { errAsync, okAsync, ResultAsync } from 'neverthrow';
import { isDatabaseAhead } from '../../logic/migration.js';
import { databaseErrors, type DatabaseAhead } from '../../models/database.js';
import type { Db } from './driver.js';
import { lastAppliedMillis, readJournal } from './migration-journal.js';

/**
 * Says whether to go on: an error when the database's newest applied migration is newer than the newest this build
 * ships — a stale `npx` or global install pointed at a database a later release has migrated. Read-only: the only
 * things it touches are `__drizzle_migrations` and the journal, and it runs before anything is copied, migrated or
 * seeded (`bootstrap` calls it first), so a refusal writes nothing.
 */
export const checkDatabaseNotAhead = (db: Db, migrationsFolder: string): ResultAsync<void, DatabaseAhead> =>
  ResultAsync.fromSafePromise(lastAppliedMillis(db)).andThen((applied) => {
    const newestKnown = R.firstBy(readJournal(migrationsFolder), [({ when }) => when, 'desc'])?.when ?? 0;
    return isDatabaseAhead(applied, newestKnown) ? errAsync(databaseErrors.ahead(version)) : okAsync(undefined);
  });
