import { LibsqlError } from '@libsql/client';

// A UNIQUE-constraint error on an `id`-keyed insert can only be some OTHER unique column on the
// table — an `id` collision is already absorbed by `versionedTableApplier`'s own
// `onConflictDoNothing` (scoped to `id`) and never throws in the first place.
const SQLITE_UNIQUE_CONSTRAINT_CODE = 'SQLITE_CONSTRAINT_UNIQUE';

/** Walks the `.cause` chain rather than assuming exactly one level of wrapping (drizzle's
 *  `DrizzleQueryError` wraps the driver's own `LibsqlError`) — robust to an extra or missing
 *  wrapping layer. Used by appliers that need to recognize a non-`id` unique-constraint race and
 *  rethrow it as a `VersionConflict` instead of a raw 500. */
export const isUniqueConstraintViolation = (cause: unknown): boolean => {
  for (let current = cause; current instanceof Error; current = current.cause) {
    if (current instanceof LibsqlError) return current.extendedCode === SQLITE_UNIQUE_CONSTRAINT_CODE;
  }
  return false;
};
