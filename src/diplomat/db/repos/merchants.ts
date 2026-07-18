import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { MerchantMatch } from '../../../logic/classify.js';
import type { MerchantCategoryEdge } from '../../../models/merchant.js';
import { ClassificationMethod } from '../../../models/transaction.js';
import type { Db } from '../driver.js';
import { merchantCategory, merchants } from '../schema.js';
import type { EntityApplier, Tx } from '../effects.js';

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
};

/** Upsert-increment: insert weight=1 on first correction, increment on repeat. Only called from
 *  `merchantCategoryApplier.insert` below, inside `runEffects`'s own transaction (`Tx`). */
const upsertCategoryWeight = async (db: Tx, merchantKey: string, categoryId: string): Promise<void> => {
  await db.insert(merchants).values({ key: merchantKey }).onConflictDoNothing();
  await db
    .insert(merchantCategory)
    .values({ merchantKey, categoryId, weight: 1, origin: ClassificationMethod.enum.history })
    .onConflictDoUpdate({
      target: [merchantCategory.merchantKey, merchantCategory.categoryId],
      set: { weight: sql`${merchantCategory.weight} + 1` },
    });
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
});

/** Always an `insert` (no `id`/`version` — see `models/merchant.ts`) — `update`/`delete` are
 *  structurally unreachable for this entity. */
export const merchantCategoryApplier: EntityApplier = {
  insert: async (tx, model) => {
    const { merchantKey, categoryId } = model as MerchantCategoryEdge;
    await upsertCategoryWeight(tx, merchantKey, categoryId);
    return { applied: true };
  },
  update: async () => {
    throw new Error('merchantCategoryApplier: update is unsupported — every write is an insert (upsert-increment)');
  },
  delete: async () => {
    throw new Error('merchantCategoryApplier: delete is unsupported — merchant-category edges are never removed');
  },
};
