import { and, eq, notInArray } from 'drizzle-orm';
import type { TransactionTagSet } from '../../../models/transactionTag.js';
import { transactionTags } from '../schema.js';
import { isForeignKeyConstraintViolation } from '../sqliteErrors.js';
import type { EntityApplier, Tx } from '../effects.js';

// Insert first, delete-stale second, so an FK miss on the insert (see the applier note below)
// fires before anything was removed — a set that can't apply leaves the existing links exactly as
// they were. A link already present just hits the (transactionId, tagId) primary key and no-ops.
const replaceLinks = async (tx: Tx, transactionId: string, tagIds: string[]): Promise<void> => {
  if (tagIds.length > 0)
    await tx
      .insert(transactionTags)
      .values(tagIds.map((tagId) => ({ transactionId, tagId })))
      .onConflictDoNothing({ target: [transactionTags.transactionId, transactionTags.tagId] });
  const stale =
    tagIds.length > 0
      ? and(eq(transactionTags.transactionId, transactionId), notInArray(transactionTags.tagId, tagIds))
      : eq(transactionTags.transactionId, transactionId);
  await tx.delete(transactionTags).where(stale);
};

export const transactionTagApplier: EntityApplier = {
  // Zero reads (ADR-023 decision 6): the set applies to the row id the core already named. An FK
  // miss on the link insert means a referenced row doesn't exist — the signature of a
  // duplicate-idempotency-key replay, whose transaction insert no-op'd and left the minted id
  // uninserted — so the set is a no-op, reported as `applied: false`: a duplicate replay never
  // touches the surviving row's tags. The same error-translation registration billApplier uses
  // for its cycle-uniqueness race, not a decision.
  insert: async (tx, model) => {
    const { transactionId, tagIds } = model as TransactionTagSet;
    try {
      await replaceLinks(tx, transactionId, tagIds);
      return { applied: true };
    } catch (cause) {
      if (isForeignKeyConstraintViolation(cause)) return { applied: false };
      throw cause;
    }
  },
  update: async () => {
    throw new Error('transactionTagApplier: update is unsupported — every write is an insert (set-replace)');
  },
  delete: async () => {
    throw new Error('transactionTagApplier: delete is unsupported — links are removed via the transaction cascade');
  },
};
