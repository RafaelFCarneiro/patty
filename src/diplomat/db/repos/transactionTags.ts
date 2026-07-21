import { eq } from 'drizzle-orm';
import type { TransactionTagSet } from '../../../models/transactionTag.js';
import { expectPresent } from '../present.js';
import { transactions, transactionTags } from '../schema.js';
import type { EntityApplier, Tx } from '../effects.js';

// Mechanical identity resolution, not a business decision — the row always exists by the time this
// runs, since the transaction Persistable this tag set travels with applies earlier in the batch.
const resolveTransactionId = async (tx: Tx, idempotencyKey: string): Promise<string> => {
  const [row] = await tx
    .select({ id: transactions.id })
    .from(transactions)
    .where(eq(transactions.idempotencyKey, idempotencyKey));
  return expectPresent(row, `transactions: no row found for idempotencyKey "${idempotencyKey}"`).id;
};

const replaceLinks = async (tx: Tx, transactionId: string, tagIds: string[]): Promise<void> => {
  await tx.delete(transactionTags).where(eq(transactionTags.transactionId, transactionId));
  if (tagIds.length > 0) await tx.insert(transactionTags).values(tagIds.map((tagId) => ({ transactionId, tagId })));
};

export const transactionTagApplier: EntityApplier = {
  insert: async (tx, model) => {
    const { idempotencyKey, tagIds } = model as TransactionTagSet;
    const transactionId = await resolveTransactionId(tx, idempotencyKey);
    await replaceLinks(tx, transactionId, tagIds);
    return { applied: true };
  },
  update: async () => {
    throw new Error('transactionTagApplier: update is unsupported — every write is an insert (set-replace)');
  },
  delete: async () => {
    throw new Error('transactionTagApplier: delete is unsupported — links are removed via the transaction cascade');
  },
};
