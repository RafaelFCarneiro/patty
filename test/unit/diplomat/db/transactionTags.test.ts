import { LibsqlError } from '@libsql/client';
import { describe, expect, it } from 'vitest';
import type { Tx } from '../../../../src/diplomat/db/effects.js';
import { transactionTagApplier } from '../../../../src/diplomat/db/repos/transactionTags.js';

type WriteLog = { deletes: number; inserted: unknown[] };

// A Tx stub whose only affordances are the two writes set-replace needs — any read attempt
// throws, proving the applier performs zero reads (ADR-023 decision 6): the set applies to the
// row id the core named, never to anything looked up here. `insertError` simulates the driver
// raising on the link insert (e.g. an FK miss).
const writesOnlyTx = (log: WriteLog, insertError?: Error): Tx => {
  const readAttempted = () => {
    throw new Error('transactionTagApplier must not read');
  };
  return {
    select: readAttempted,
    all: readAttempted,
    get: readAttempted,
    delete: () => ({
      where: async () => {
        log.deletes += 1;
      },
    }),
    insert: () => ({
      values: (rows: unknown) => ({
        onConflictDoNothing: async () => {
          if (insertError) throw insertError;
          log.inserted.push(rows);
        },
      }),
    }),
  } as unknown as Tx;
};

const foreignKeyMiss = () =>
  new LibsqlError('FOREIGN KEY constraint failed', 'SQLITE_CONSTRAINT', 'SQLITE_CONSTRAINT_FOREIGNKEY');

describe('transactionTagApplier', () => {
  it('applies the set to the given transaction id — links inserted, stale links deleted, zero reads', async () => {
    const log: WriteLog = { deletes: 0, inserted: [] };

    const outcome = await transactionTagApplier.insert(writesOnlyTx(log), {
      transactionId: 'tx-1',
      tagIds: ['tag-a', 'tag-b'],
    });

    expect(outcome).toEqual({ applied: true });
    expect(log.inserted).toEqual([
      [
        { transactionId: 'tx-1', tagId: 'tag-a' },
        { transactionId: 'tx-1', tagId: 'tag-b' },
      ],
    ]);
    expect(log.deletes).toBe(1);
  });

  it('an empty tag set only clears — no insert issued at all', async () => {
    const log: WriteLog = { deletes: 0, inserted: [] };

    const outcome = await transactionTagApplier.insert(writesOnlyTx(log), { transactionId: 'tx-1', tagIds: [] });

    expect(outcome).toEqual({ applied: true });
    expect(log.inserted).toEqual([]);
    expect(log.deletes).toBe(1);
  });

  it('an FK miss on the link insert no-ops with applied:false, before any link was deleted', async () => {
    // The duplicate-replay signature: the addressed row was never inserted. Insert-first ordering
    // means nothing has been removed when the miss fires — existing links stay exactly as-is.
    const log: WriteLog = { deletes: 0, inserted: [] };

    const outcome = await transactionTagApplier.insert(writesOnlyTx(log, foreignKeyMiss()), {
      transactionId: 'never-inserted-mint',
      tagIds: ['tag-a'],
    });

    expect(outcome).toEqual({ applied: false });
    expect(log.deletes).toBe(0);
    expect(log.inserted).toEqual([]);
  });

  it('any other insert error still propagates — only the FK miss is translated', async () => {
    const log: WriteLog = { deletes: 0, inserted: [] };

    await expect(
      transactionTagApplier.insert(writesOnlyTx(log, new Error('disk I/O error')), {
        transactionId: 'tx-1',
        tagIds: ['tag-a'],
      }),
    ).rejects.toThrow('disk I/O error');
  });
});
