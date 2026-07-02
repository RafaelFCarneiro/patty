import { describe, expect, it } from 'vitest';
import { expectPresent, rowNotFoundAfterWrite } from '../../../../src/diplomat/db/present.js';

describe('expectPresent', () => {
  it('returns the value when present', () => {
    expect(expectPresent('row', 'unreachable')).toBe('row');
    expect(expectPresent(0, 'unreachable')).toBe(0);
    expect(expectPresent(false, 'unreachable')).toBe(false);
  });

  it('throws the given message when the value is null', () => {
    expect(() => expectPresent(null, 'dashboards: row not found after upsert')).toThrow(
      'dashboards: row not found after upsert',
    );
  });

  it('throws the given message when the value is undefined', () => {
    expect(() => expectPresent(undefined, 'accounts: row not found after insert')).toThrow(
      'accounts: row not found after insert',
    );
  });
});

describe('rowNotFoundAfterWrite', () => {
  it('builds the "<table>: row not found after <verb>" message', () => {
    expect(rowNotFoundAfterWrite('dashboards', 'upsert')).toBe('dashboards: row not found after upsert');
    expect(rowNotFoundAfterWrite('accounts', 'insert')).toBe('accounts: row not found after insert');
    expect(rowNotFoundAfterWrite('accounts', 'update')).toBe('accounts: row not found after update');
    expect(rowNotFoundAfterWrite('transactions', 'write')).toBe('transactions: row not found after write');
  });
});
