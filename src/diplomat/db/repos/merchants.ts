import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { MerchantMatch } from '../../../logic/classify.js';
import type { Merchant, MerchantCategoryEdge } from '../../../models/merchant.js';
import { ClassificationMethod } from '../../../models/transaction.js';
import type { Db } from '../driver.js';
import { merchantCategory, merchants } from '../schema.js';
import type { EntityApplier } from '../effects.js';

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

/** Hand-written rather than `versionedTableApplier` because `merchants` keys on `key` with no
 *  `version` — like `dashboards`, but simpler: only ever inserted, idempotently. */
export const merchantApplier: EntityApplier = {
  insert: async (tx, model) => {
    const { key } = model as Merchant;
    const result = await tx.insert(merchants).values({ key }).onConflictDoNothing();
    return { applied: (result.rowsAffected ?? 0) > 0 };
  },
  update: async () => {
    throw new Error('merchantApplier: update is unsupported — a merchant is only ever inserted');
  },
  delete: async () => {
    throw new Error('merchantApplier: delete is unsupported — merchants are never removed');
  },
};

/** Always an `insert` (no `id`/`version`) — `update`/`delete` are structurally unreachable. The
 *  `set` below deliberately omits `origin`: it must stay insert-only, or an edge first learned as
 *  `rule` would flip to `history` the next time a correction reinforces it. */
export const merchantCategoryApplier: EntityApplier = {
  insert: async (tx, model) => {
    const { merchantKey, categoryId, weightDelta, origin } = model as MerchantCategoryEdge;
    await tx
      .insert(merchantCategory)
      .values({ merchantKey, categoryId, weight: weightDelta, origin })
      .onConflictDoUpdate({
        target: [merchantCategory.merchantKey, merchantCategory.categoryId],
        set: { weight: sql`${merchantCategory.weight} + ${weightDelta}` },
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
