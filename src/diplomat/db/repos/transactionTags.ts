import { eq } from 'drizzle-orm';
import type { TransactionTagSet } from '../../../models/transactionTag.js';
import { expectPresent } from '../present.js';
import { transactions, transactionTags } from '../schema.js';
import type { EntityApplier, Tx } from '../effects.js';

/** Resolves the real, persisted transaction id for `idempotencyKey` — mechanical identity
 *  resolution, not a business decision (see the model's own doc comment). Always present by the
 *  time this applier runs: the transaction `Persistable` this tag set travels with is applied
 *  earlier in the same batch (ADR-023 step 2), so a row with this idempotency key already exists,
 *  whether it was just inserted or this is a duplicate resubmission. */
const resolveTransactionId = async (tx: Tx, idempotencyKey: string): Promise<string> => {
  const [row] = await tx
    .select({ id: transactions.id })
    .from(transactions)
    .where(eq(transactions.idempotencyKey, idempotencyKey));
  return expectPresent(row, `transactions: no row found for idempotencyKey "${idempotencyKey}"`).id;
};

/** Makes `transaction_tags` match the given `tagIds` for one transaction — delete-then-insert
 *  within its own write is safe here because the core already stated the exact desired end-state
 *  (ADR-023 decision 3), not a diff strategy this applier invents. */
const replaceLinks = async (tx: Tx, transactionId: string, tagIds: string[]): Promise<void> => {
  await tx.delete(transactionTags).where(eq(transactionTags.transactionId, transactionId));
  if (tagIds.length > 0) await tx.insert(transactionTags).values(tagIds.map((tagId) => ({ transactionId, tagId })));
};

/** No `id`/`version` — like `merchantCategoryApplier`, every write is an `insert` op (a
 *  set-replace, not an upsert-increment); `update`/`delete` are structurally unreachable. */
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
