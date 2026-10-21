import { describe, expect, it } from 'vitest';
import {
  ownedTableApplier,
  VersionConflict,
  versionedTableApplier,
  type EntityApplier,
} from '../../../../src/diplomat/db/effects.js';
import { currencyRates, tags, transactions } from '../../../../src/diplomat/db/schema.js';
import { query, rejecting, txReturning } from './fake-tx.js';

const OWNER = 'user-1';
const row = { id: 'row-1', version: 0 };

describe('the table applier — loud invariants and driver quirks, pinned', () => {
  it('refuses an owner scope on a table with no "userId" column', () => {
    expect(() => ownedTableApplier(currencyRates as never, OWNER)).toThrow(
      'versionedTableApplier: an owner scope needs a "userId" column',
    );
  });

  it('throws when a deduped insert finds no surviving row holding the key (an invariant, not a miss)', async () => {
    const applier = ownedTableApplier(transactions, OWNER, { readBack: async () => ({}) as never });
    const tx = txReturning({ insert: { rowsAffected: 0 }, select: [] });

    await expect(applier.insert(tx, { id: 'minted' }, 'key-1')).rejects.toThrow(
      'runEffects: no surviving row holds idempotency key "key-1" after a duplicate insert',
    );
  });

  it('reads back the surviving row, not the discarded mint, after an idempotent duplicate', async () => {
    const readBackIds: string[] = [];
    const applier = ownedTableApplier(transactions, OWNER, {
      readBack: async (_tx, id) => {
        readBackIds.push(id);
        return {} as never;
      },
    });
    const tx = txReturning({ insert: { rowsAffected: 0 }, select: [{ id: 'survivor' }] });

    expect(await applier.insert(tx, { id: 'minted' }, 'key-1')).toMatchObject({ applied: false });
    expect(readBackIds).toEqual(['survivor']);
  });

  it('rethrows a delete failure that is not a foreign-key violation as it was', async () => {
    const failure = new Error('disk I/O error');
    const tx = { delete: () => query(rejecting(failure)) } as never;

    await expect(versionedTableApplier(tags).delete(tx, 'id', 0)).rejects.toBe(failure);
  });

  it('turns a foreign-key violation on delete into a VersionConflict', async () => {
    const { LibsqlError } = await import('@libsql/client');
    const fk = new LibsqlError('FOREIGN KEY constraint failed', 'SQLITE_CONSTRAINT', 'SQLITE_CONSTRAINT_FOREIGNKEY');
    const tx = { delete: () => query(rejecting(fk)) } as never;

    await expect(versionedTableApplier(tags).delete(tx, 'id', 0)).rejects.toBeInstanceOf(VersionConflict);
  });

  it.each([
    ['insert', (a: EntityApplier, tx: never) => a.insert(tx, row, undefined)],
    ['update', (a: EntityApplier, tx: never) => a.update(tx, row)],
    ['delete', (a: EntityApplier, tx: never) => a.delete(tx, row.id, row.version)],
  ])('reports %s as not applied when the driver reports no rowsAffected', async (_verb, run) => {
    const applier = ownedTableApplier(tags, OWNER);

    expect(await run(applier, txReturning({}))).toEqual({ applied: false });
  });
});
