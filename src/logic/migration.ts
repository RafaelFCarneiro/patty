/**
 * Whether a database has been migrated by a newer build than this one. Drizzle stamps every applied migration with
 * its journal entry's `when`, so "newer" is simply a larger stamp than the newest this build ships. A database the
 * migrator has never run on (`undefined`) is fresh, and one at or below the newest is current or behind: both proceed.
 */
export const isDatabaseAhead = (lastAppliedMillis: number | undefined, newestKnownMillis: number): boolean =>
  lastAppliedMillis !== undefined && lastAppliedMillis > newestKnownMillis;
