import { LibsqlError } from '@libsql/client';
import { describe, expect, it } from 'vitest';
import type { Tx } from '../../../../src/diplomat/db/effects.js';
import { transactionTagApplier } from '../../../../src/diplomat/db/repos/transactionTags.js';
import { tags, transactions } from '../../../../src/diplomat/db/schema.js';

type WriteLog = { deletes: number; inserted: unknown[] };

/** What the user owns, as the applier's ownership check will find it: the transaction (or not) and which tags. */
type Owned = { transaction: boolean; tagIds: string[] };
const ALL_OWNED = (tagIds: string[]): Owned => ({ transaction: true, tagIds });

// A Tx stub with the two reads the ownership check makes (the transaction, then the tags — each answered from `owned`)
// and the two writes set-replace needs. `insertError` simulates the driver raising on the link insert.
const stubTx = (log: WriteLog, owned: Owned, insertError?: Error): Tx => {
  const unexpected = () => {
    throw new Error('transactionTagApplier reached for something other than its ownership check and its writes');
  };
  return {
    select: () => ({
      from: (table: unknown) => ({
        where: async () => {
          if (table === transactions) return owned.transaction ? [{ id: 'tx-1' }] : [];
          if (table === tags) return owned.tagIds.map((id) => ({ id }));
          return unexpected();
        },
      }),
    }),
    all: unexpected,
    get: unexpected,
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

const applier = transactionTagApplier('user-a');

describe('transactionTagApplier', () => {
  it('applies the set to the given transaction id — links inserted, stale links deleted', async () => {
    const log: WriteLog = { deletes: 0, inserted: [] };

    const outcome = await applier.insert(stubTx(log, ALL_OWNED(['tag-a', 'tag-b'])), {
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

    const outcome = await applier.insert(stubTx(log, ALL_OWNED([])), { transactionId: 'tx-1', tagIds: [] });

    expect(outcome).toEqual({ applied: true });
    expect(log.inserted).toEqual([]);
    expect(log.deletes).toBe(1);
  });

  it('a transaction that is not the user’s (another’s, or a duplicate replay’s) is a no-op', async () => {
    const log: WriteLog = { deletes: 0, inserted: [] };

    const outcome = await applier.insert(stubTx(log, { transaction: false, tagIds: ['tag-a'] }), {
      transactionId: 'someone-elses-or-never-inserted',
      tagIds: ['tag-a'],
    });

    expect(outcome).toEqual({ applied: false });
    expect(log.deletes).toBe(0);
    expect(log.inserted).toEqual([]);
  });

  it('a tag that is not the user’s links and clears nothing, even on the user’s own transaction', async () => {
    const log: WriteLog = { deletes: 0, inserted: [] };

    const outcome = await applier.insert(stubTx(log, ALL_OWNED(['tag-a'])), {
      transactionId: 'tx-1',
      tagIds: ['tag-a', 'tag-of-another-user'],
    });

    expect(outcome).toEqual({ applied: false });
    expect(log.deletes).toBe(0);
    expect(log.inserted).toEqual([]);
  });

  it('an FK miss on the link insert no-ops with applied:false, before any link was deleted', async () => {
    // A parent removed between the ownership check and the insert. Insert-first ordering means nothing has been
    // removed when the miss fires — existing links stay exactly as-is.
    const log: WriteLog = { deletes: 0, inserted: [] };

    const outcome = await applier.insert(stubTx(log, ALL_OWNED(['tag-a']), foreignKeyMiss()), {
      transactionId: 'tx-1',
      tagIds: ['tag-a'],
    });

    expect(outcome).toEqual({ applied: false });
    expect(log.deletes).toBe(0);
    expect(log.inserted).toEqual([]);
  });

  it('any other insert error still propagates — only the FK miss is translated', async () => {
    const log: WriteLog = { deletes: 0, inserted: [] };

    await expect(
      applier.insert(stubTx(log, ALL_OWNED(['tag-a']), new Error('disk I/O error')), {
        transactionId: 'tx-1',
        tagIds: ['tag-a'],
      }),
    ).rejects.toThrow('disk I/O error');
  });
});
