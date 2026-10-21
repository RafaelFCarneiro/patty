import { LibsqlError } from '@libsql/client';
import { describe, expect, it } from 'vitest';
import {
  isForeignKeyConstraintViolation,
  isSqliteBusy,
  isUniqueConstraintViolation,
} from '../../../../src/diplomat/db/sqlite-errors.js';

const sqliteBusy = (extendedCode?: string) => new LibsqlError('database is locked', 'SQLITE_BUSY', extendedCode);
const uniqueConstraintViolation = () =>
  new LibsqlError('UNIQUE constraint failed', 'SQLITE_CONSTRAINT', 'SQLITE_CONSTRAINT_UNIQUE');
const foreignKeyConstraintViolation = () =>
  new LibsqlError('FOREIGN KEY constraint failed', 'SQLITE_CONSTRAINT', 'SQLITE_CONSTRAINT_FOREIGNKEY');

describe('isSqliteBusy (ADR-024)', () => {
  it('classifies a plain SQLITE_BUSY (busy_timeout exhausted) as busy', () => {
    expect(isSqliteBusy(sqliteBusy())).toBe(true);
  });

  it('classifies the more specific SQLITE_BUSY_SNAPSHOT (WAL checkpoint starvation) as busy — same base code', () => {
    expect(isSqliteBusy(sqliteBusy('SQLITE_BUSY_SNAPSHOT'))).toBe(true);
  });

  it('walks the .cause chain — drizzle wraps the driver error one level deep', () => {
    const wrapped = new Error('query failed', { cause: sqliteBusy() });
    expect(isSqliteBusy(wrapped)).toBe(true);
  });

  it('does not misclassify an unrelated constraint violation as busy', () => {
    expect(isSqliteBusy(uniqueConstraintViolation())).toBe(false);
  });

  it('does not misclassify a plain non-libsql error', () => {
    expect(isSqliteBusy(new Error('boom'))).toBe(false);
  });
});

// Regression guard: isSqliteBusy is a new check alongside these two — confirm none of the three
// cross-classify a case that belongs to one of the others.
describe('isSqliteBusy does not overlap the existing constraint-violation checks', () => {
  it('a unique-constraint violation is unique, not busy or foreign-key', () => {
    const cause = uniqueConstraintViolation();
    expect(isUniqueConstraintViolation(cause)).toBe(true);
    expect(isSqliteBusy(cause)).toBe(false);
    expect(isForeignKeyConstraintViolation(cause)).toBe(false);
  });

  it('a foreign-key violation is foreign-key, not busy or unique', () => {
    const cause = foreignKeyConstraintViolation();
    expect(isForeignKeyConstraintViolation(cause)).toBe(true);
    expect(isSqliteBusy(cause)).toBe(false);
    expect(isUniqueConstraintViolation(cause)).toBe(false);
  });
});
