import { LibsqlError } from '@libsql/client';

// A UNIQUE-constraint error on an `id`-keyed insert can only be some OTHER unique column on the
// table — an `id` collision is already absorbed by `versionedTableApplier`'s own
// `onConflictDoNothing` (scoped to `id`) and never throws in the first place.
const SQLITE_UNIQUE_CONSTRAINT_CODE = 'SQLITE_CONSTRAINT_UNIQUE';

const SQLITE_PRIMARY_KEY_CONSTRAINT_CODE = 'SQLITE_CONSTRAINT_PRIMARYKEY';

// A row referencing the one a versioned delete is removing was inserted after that delete's own
// flow read its point-in-time state — the same kind of "the world changed since we read" race a
// stale `version` reports, just surfaced by the FK check instead.
const SQLITE_FOREIGN_KEY_CONSTRAINT_CODE = 'SQLITE_CONSTRAINT_FOREIGNKEY';

const matchesExtendedCode = (cause: unknown, extendedCode: string): boolean => {
  for (let current = cause; current instanceof Error; current = current.cause) {
    if (current instanceof LibsqlError) return current.extendedCode === extendedCode;
  }
  return false;
};

/** Walks the `.cause` chain rather than assuming exactly one level of wrapping (drizzle's
 *  `DrizzleQueryError` wraps the driver's own `LibsqlError`) — robust to an extra or missing
 *  wrapping layer. Used by appliers that need to recognize a non-`id` unique-constraint race and
 *  rethrow it as a `VersionConflict` instead of a raw 500. */
export const isUniqueConstraintViolation = (cause: unknown): boolean =>
  matchesExtendedCode(cause, SQLITE_UNIQUE_CONSTRAINT_CODE);

/** A duplicate on a non-`id` PRIMARY KEY (e.g. `dashboards.name`) raises this distinct extended
 *  code, never `SQLITE_CONSTRAINT_UNIQUE` (which only covers a secondary unique column). */
export const isPrimaryKeyConstraintViolation = (cause: unknown): boolean =>
  matchesExtendedCode(cause, SQLITE_PRIMARY_KEY_CONSTRAINT_CODE);

/** Same `.cause`-chain walk as `isUniqueConstraintViolation`, for a versioned delete that failed
 *  because some other row now references the one being removed. */
export const isForeignKeyConstraintViolation = (cause: unknown): boolean =>
  matchesExtendedCode(cause, SQLITE_FOREIGN_KEY_CONSTRAINT_CODE);
