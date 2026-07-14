import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { MerchantMatch } from '../../../logic/classify.js';
import type { MerchantCategoryEdge } from '../../../models/merchant.js';
import { ClassificationMethod } from '../../../models/transaction.js';
import type { Db } from '../driver.js';
import { merchantCategory, merchants } from '../schema.js';
import type { EntityApplier, Tx } from '../unitOfWork.js';

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
  /** Learning write-back: strengthens (or creates, at weight 1) a merchant→category edge. Pure
   *  mechanics — which edge to strengthen, and whether to at all, is the caller's own decision
   *  (`logic/merchant.ts`'s `isMerchantCorrection`), never resolved here. */
  incrementCategoryWeight: (merchantKey: string, categoryId: string) => Promise<void>;
};

/** Shared upsert-increment mechanics (ADR-021): "insert weight=1 on first correction, increment on
 *  repeat" — the one place this SQL is written, run identically whether reached through the plain
 *  repo (`merchantsRepo`, for the still-unconverted credit-card aggregate) or the unit-of-work
 *  applier (`merchantCategoryApplier`, for the FC/IS account aggregate) below. `Db | Tx`: the
 *  latter runs it inside an existing `db.transaction` callback. */
const upsertCategoryWeight = async (db: Db | Tx, merchantKey: string, categoryId: string): Promise<void> => {
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

  incrementCategoryWeight: (merchantKey, categoryId) => upsertCategoryWeight(db, merchantKey, categoryId),
});

/**
 * The merchant-category edge's `EntityApplier` (ADR-021), registered under `models/merchant.ts`'s
 * `MERCHANT_CATEGORY_ENTITY_TAG` — `upsertCategoryWeight` above, driven by a `Persistable`
 * (`merchantKey`/`categoryId` already known to the caller) instead of the plain repo call. Always
 * an `insert` (no `id`/`version` — see `models/merchant.ts`) — `update`/`delete` are structurally
 * unreachable for this entity.
 */
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
