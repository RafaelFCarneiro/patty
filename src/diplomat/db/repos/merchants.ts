import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { MerchantMatch } from '../../../logic/classify.js';
import type { MerchantCategoryEdge } from '../../../models/merchant.js';
import { ClassificationMethod } from '../../../models/transaction.js';
import type { Db } from '../driver.js';
import { merchantCategory, merchants } from '../schema.js';
import type { EntityApplier } from '../unitOfWork.js';

const MatchRow = z.object({
  merchantKey: z.string(),
  categoryId: z.string(),
  categoryName: z.string(),
  weight: z.number(),
  origin: z.enum([ClassificationMethod.enum.rule, ClassificationMethod.enum.history]),
});

export type MerchantsRepo = {
  /** Find merchant→category candidates whose key appears in the normalized description. */
  matchCandidates: (normalizedDescription: string) => Promise<MerchantMatch[]>;
  /** Learning write-back: a user correction strengthens the merchant→category edge. */
  strengthenFromTransaction: (transactionId: string, categoryId: string) => Promise<void>;
};

export const merchantsRepo = (db: Db): MerchantsRepo => ({
  matchCandidates: async (normalizedDescription) => {
    const rows = await db.all<Record<string, unknown>>(sql`
      SELECT mc.merchant_key AS "merchantKey", mc.category_id AS "categoryId",
             c.name AS "categoryName", mc.weight, COALESCE(mc.origin, ${ClassificationMethod.enum.history}) AS origin
      FROM merchant_category mc
      JOIN categories c ON c.id = mc.category_id
      WHERE ${normalizedDescription} LIKE '%' || mc.merchant_key || '%'
      ORDER BY mc.weight DESC, length(mc.merchant_key) DESC
      LIMIT 5
    `);
    return rows.map((r) => MatchRow.parse(r));
  },

  strengthenFromTransaction: async (transactionId, categoryId) => {
    // Resolve the merchant key from the transaction
    const [tx] = await db.all<{ merchant_key: string | null }>(sql`
      SELECT merchant_key FROM transactions WHERE id = ${transactionId}
    `);
    if (!tx?.merchant_key) return;

    const merchantKey = tx.merchant_key;
    // Ensure merchant row exists (may have been created on transaction write)
    await db.insert(merchants).values({ key: merchantKey }).onConflictDoNothing();
    // Upsert the edge: insert weight=1 on first user correction, increment on repeat
    await db
      .insert(merchantCategory)
      .values({ merchantKey, categoryId, weight: 1, origin: ClassificationMethod.enum.history })
      .onConflictDoUpdate({
        target: [merchantCategory.merchantKey, merchantCategory.categoryId],
        set: { weight: sql`${merchantCategory.weight} + 1` },
      });
  },
});

/**
 * The merchant-category edge's `EntityApplier` (ADR-021), registered under `models/merchant.ts`'s
 * `MERCHANT_CATEGORY_ENTITY_TAG` — the same upsert-increment mechanics as `strengthenFromTransaction`
 * above, just driven by a `Persistable` (merchantKey/categoryId already known to the caller) instead
 * of re-reading the transaction row to find them. Always an `insert` (no `id`/`version` — see
 * `models/merchant.ts`) — `update`/`delete` are structurally unreachable for this entity.
 */
export const merchantCategoryApplier: EntityApplier = {
  insert: async (tx, model) => {
    const { merchantKey, categoryId } = model as MerchantCategoryEdge;
    await tx.insert(merchants).values({ key: merchantKey }).onConflictDoNothing();
    await tx
      .insert(merchantCategory)
      .values({ merchantKey, categoryId, weight: 1, origin: ClassificationMethod.enum.history })
      .onConflictDoUpdate({
        target: [merchantCategory.merchantKey, merchantCategory.categoryId],
        set: { weight: sql`${merchantCategory.weight} + 1` },
      });
    return { applied: true };
  },
  update: async () => {
    throw new Error('merchantCategoryApplier: update is unsupported — every write is an insert (upsert-increment)');
  },
  delete: async () => {
    throw new Error('merchantCategoryApplier: delete is unsupported — merchant-category edges are never removed');
  },
};
