import { LibsqlError } from '@libsql/client';
import { describe, expect, it } from 'vitest';
import {
  isForeignKeyConstraintViolation,
  isSqliteBusy,
  isUniqueConstraintViolation,
} from '../../../../src/diplomat/db/sqliteErrors.js';

describe('isSqliteBusy (ADR-024)', () => {
  it('classifies a plain SQLITE_BUSY (busy_timeout exhausted) as busy', () => {
    expect(isSqliteBusy(new LibsqlError('database is locked', 'SQLITE_BUSY'))).toBe(true);
  });

  it('classifies the more specific SQLITE_BUSY_SNAPSHOT (WAL checkpoint starvation) as busy — same base code', () => {
    expect(isSqliteBusy(new LibsqlError('database is locked', 'SQLITE_BUSY', 'SQLITE_BUSY_SNAPSHOT'))).toBe(true);
  });

  it('walks the .cause chain — drizzle wraps the driver error one level deep', () => {
    const wrapped = new Error('query failed', { cause: new LibsqlError('database is locked', 'SQLITE_BUSY') });
    expect(isSqliteBusy(wrapped)).toBe(true);
  });

  it('does not misclassify an unrelated constraint violation as busy', () => {
    const cause = new LibsqlError('UNIQUE constraint failed', 'SQLITE_CONSTRAINT', 'SQLITE_CONSTRAINT_UNIQUE');
    expect(isSqliteBusy(cause)).toBe(false);
  });

  it('does not misclassify a plain non-libsql error', () => {
    expect(isSqliteBusy(new Error('boom'))).toBe(false);
  });
});

// Regression guard: isSqliteBusy is a new check alongside these two — confirm none of the three
// cross-classify a case that belongs to one of the others.
describe('isSqliteBusy does not overlap the existing constraint-violation checks', () => {
  it('a unique-constraint violation is unique, not busy or foreign-key', () => {
    const cause = new LibsqlError('UNIQUE constraint failed', 'SQLITE_CONSTRAINT', 'SQLITE_CONSTRAINT_UNIQUE');
    expect(isUniqueConstraintViolation(cause)).toBe(true);
    expect(isSqliteBusy(cause)).toBe(false);
    expect(isForeignKeyConstraintViolation(cause)).toBe(false);
  });

  it('a foreign-key violation is foreign-key, not busy or unique', () => {
    const cause = new LibsqlError('FOREIGN KEY constraint failed', 'SQLITE_CONSTRAINT', 'SQLITE_CONSTRAINT_FOREIGNKEY');
    expect(isForeignKeyConstraintViolation(cause)).toBe(true);
    expect(isSqliteBusy(cause)).toBe(false);
    expect(isUniqueConstraintViolation(cause)).toBe(false);
  });
});
