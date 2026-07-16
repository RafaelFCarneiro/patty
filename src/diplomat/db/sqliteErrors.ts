import { LibsqlError } from '@libsql/client';

// A UNIQUE-constraint error on an `id`-keyed insert can only be some OTHER unique column on the
// table — an `id` collision is already absorbed by `versionedTableApplier`'s own
// `onConflictDoNothing` (scoped to `id`) and never throws in the first place.
const SQLITE_UNIQUE_CONSTRAINT_CODE = 'SQLITE_CONSTRAINT_UNIQUE';

/** Walks the `.cause` chain rather than assuming exactly one level of wrapping (today: drizzle's
 *  `DrizzleQueryError` wrapping the driver's own `LibsqlError`) — robust to the driver ever
 *  throwing `LibsqlError` directly, or to an extra wrapping layer. Shared by every entity applier
 *  that needs to recognize a genuine non-`id` unique-constraint race and rethrow it as a
 *  `VersionConflict` (ADR-021 rule 4) instead of letting it surface as a raw 500 — e.g.
 *  `diplomat/db/repos/bills.ts`'s cycle-uniqueness race, `diplomat/db/repos/tags.ts`'s
 *  name-uniqueness race. */
export const isUniqueConstraintViolation = (cause: unknown): boolean => {
  for (let current = cause; current instanceof Error; current = current.cause) {
    if (current instanceof LibsqlError) return current.extendedCode === SQLITE_UNIQUE_CONSTRAINT_CODE;
  }
  return false;
};
