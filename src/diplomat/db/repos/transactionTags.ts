import { and, eq, inArray, notInArray } from 'drizzle-orm';
import type { TransactionTagSet } from '../../../models/transactionTag.js';
import { tags, transactions, transactionTags } from '../schema.js';
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

/** `transaction_tags` has no owner column: a link is owned through its two parents (ADR-033 §5), which a flow of one
 *  user always names from that user's own rows. The applier checks it anyway — the transaction and every tag must
 *  belong to the user — and treats a parent that is not theirs exactly like a parent that does not exist. */
const belongsToUser = async (tx: Tx, userId: string, transactionId: string, tagIds: string[]): Promise<boolean> => {
  const [transaction] = await tx
    .select({ id: transactions.id })
    .from(transactions)
    .where(and(eq(transactions.id, transactionId), eq(transactions.userId, userId)));
  if (!transaction) return false;
  const distinct = [...new Set(tagIds)];
  if (distinct.length === 0) return true;
  const owned = await tx
    .select({ id: tags.id })
    .from(tags)
    .where(and(inArray(tags.id, distinct), eq(tags.userId, userId)));
  return owned.length === distinct.length;
};

export const transactionTagApplier = (userId: string): EntityApplier => ({
  // Zero decisions (ADR-023 decision 6): the set applies to the row id the core already named. A parent that is
  // missing — the signature of a duplicate-idempotency-key replay, whose transaction insert no-op'd and left the
  // minted id uninserted — or that is not the user's own makes the set a no-op, reported as `applied: false`: a
  // duplicate replay never touches the surviving row's tags, and a link can never join another user's rows.
  insert: async (tx, model) => {
    const { transactionId, tagIds } = model as TransactionTagSet;
    if (!(await belongsToUser(tx, userId, transactionId, tagIds))) return { applied: false };
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
});
