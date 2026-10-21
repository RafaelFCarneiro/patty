import { LibsqlError } from '@libsql/client';

// A UNIQUE-constraint error on an `id`-keyed insert can only be some OTHER unique column on the
// table — an `id` collision is already absorbed by `versionedTableApplier`'s own
// `onConflictDoNothing` (scoped to `id`) and never throws in the first place.
const SQLITE_UNIQUE_CONSTRAINT_CODE = 'SQLITE_CONSTRAINT_UNIQUE';

// A row referencing the one a versioned delete is removing was inserted after that delete's own
// flow read its point-in-time state — the same kind of "the world changed since we read" race a
// stale `version` reports, just surfaced by the FK check instead.
const SQLITE_FOREIGN_KEY_CONSTRAINT_CODE = 'SQLITE_CONSTRAINT_FOREIGNKEY';

// The base result code shared by every busy variant (plain SQLITE_BUSY, and the more specific
// SQLITE_BUSY_SNAPSHOT/SQLITE_BUSY_RECOVERY WAL raises under checkpoint starvation) — matched on
// `.code`, not `.extendedCode`, so all of them are caught by one check (ADR-024).
const SQLITE_BUSY_CODE = 'SQLITE_BUSY';

const matchesExtendedCode = (cause: unknown, extendedCode: string): boolean => {
  for (let current = cause; current instanceof Error; current = current.cause) {
    if (current instanceof LibsqlError) return current.extendedCode === extendedCode;
  }
  return false;
};

const matchesCode = (cause: unknown, code: string): boolean => {
  for (let current = cause; current instanceof Error; current = current.cause) {
    if (current instanceof LibsqlError) return current.code === code;
  }
  return false;
};

/** Walks the `.cause` chain rather than assuming exactly one level of wrapping (drizzle's
 *  `DrizzleQueryError` wraps the driver's own `LibsqlError`) — robust to an extra or missing
 *  wrapping layer. Used by appliers that need to recognize a non-`id` unique-constraint race and
 *  rethrow it as a `VersionConflict` instead of a raw 500. */
export const isUniqueConstraintViolation = (cause: unknown): boolean =>
  matchesExtendedCode(cause, SQLITE_UNIQUE_CONSTRAINT_CODE);

/** Same `.cause`-chain walk as `isUniqueConstraintViolation`, for a versioned delete that failed
 *  because some other row now references the one being removed. */
export const isForeignKeyConstraintViolation = (cause: unknown): boolean =>
  matchesExtendedCode(cause, SQLITE_FOREIGN_KEY_CONSTRAINT_CODE);

/** Same `.cause`-chain walk, matched on the base `.code` so every busy variant is covered by one
 *  check. A transient physical lock-contention condition (busy_timeout exhausted, or a WAL
 *  checkpoint-starvation snapshot conflict) — `applyBatch` (`diplomat/db/effects.ts`) treats it as
 *  retryable the same way it treats a `VersionConflict` (ADR-024). */
export const isSqliteBusy = (cause: unknown): boolean => matchesCode(cause, SQLITE_BUSY_CODE);
