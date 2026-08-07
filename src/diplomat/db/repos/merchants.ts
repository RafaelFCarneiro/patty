import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { MerchantMatch } from '../../../logic/classify.js';
import type { Merchant, MerchantCategoryEdge } from '../../../models/merchant.js';
import { ClassificationMethod } from '../../../models/transaction.js';
import { MerchantTopDbRowSchema, type MerchantTopDbRow } from '../../../wire/db/merchants.js';
import type { Db } from '../driver.js';
import { merchantCategory, merchants } from '../schema.js';
import { txPredicates } from '../txPredicates.js';
import type { EntityApplier } from '../effects.js';

const MatchRow = z.object({
  merchantKey: z.string(),
  categoryId: z.string(),
  categoryName: z.string(),
  weight: z.number(),
  origin: z.enum([ClassificationMethod.enum.rule, ClassificationMethod.enum.history]),
});

/** The `limit` merchants with the most effective, non-transfer transactions, plus each one's
 *  dominant *classified* category (the category it's most often classified into, among those same
 *  transactions) — Feature Design 018. `merchant_totals` picks the merchants first, so
 *  `category_counts` only ever aggregates over that already-limited set; it excludes
 *  `category_id IS NULL` so an uncategorized transaction never outweighs a real category — a
 *  merchant with 2 classified "Food" and 5 uncategorized transactions must still resolve to
 *  "Food", not `null`. The dominant-category join breaks ties deterministically via
 *  `MIN(c.name)`/`MIN(c.names)` (alphabetically first), rather than relying on SQLite's
 *  unspecified bare-column pick; a merchant with *no classified* transactions at all has no rows
 *  in `category_counts`, so the `LEFT JOIN` never matches and both `MIN`s come back `NULL` — the
 *  "resolves gracefully" case. */
const MERCHANTS_TOP_SELECT = (limit: number) => sql`
  WITH merchant_totals AS (
    SELECT t.merchant_key, COUNT(*) AS transaction_count
    FROM transactions t
    WHERE ${txPredicates.effective()}
      AND ${txPredicates.nonTransfer()}
      AND t.merchant_key IS NOT NULL
    GROUP BY t.merchant_key
    ORDER BY transaction_count DESC
    LIMIT ${limit}
  ),
  category_counts AS (
    SELECT t.merchant_key, t.category_id, COUNT(*) AS category_count
    FROM transactions t
    JOIN merchant_totals mt ON mt.merchant_key = t.merchant_key
    WHERE ${txPredicates.effective()}
      AND ${txPredicates.nonTransfer()}
      AND t.category_id IS NOT NULL
    GROUP BY t.merchant_key, t.category_id
  )
  SELECT mt.merchant_key AS merchant, mt.transaction_count AS transaction_count,
         MIN(c.name) AS category_name, MIN(c.names) AS category_names
  FROM merchant_totals mt
  LEFT JOIN category_counts cc
    ON cc.merchant_key = mt.merchant_key
    AND cc.category_count = (
      SELECT MAX(cc2.category_count) FROM category_counts cc2 WHERE cc2.merchant_key = mt.merchant_key
    )
  LEFT JOIN categories c ON c.id = cc.category_id
  GROUP BY mt.merchant_key, mt.transaction_count
  ORDER BY mt.transaction_count DESC
`;

export type MerchantsRepo = {
  /** Find merchant→category candidates whose key appears in the normalized description. */
  matchCandidates: (normalizedDescription: string) => Promise<MerchantMatch[]>;
  /** The `limit` most-transacted merchants (effective, non-transfer), each with its dominant
   *  category — backs `fintrack://merchants/top`. */
  top: (limit: number) => Promise<MerchantTopDbRow[]>;
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

  top: async (limit) => {
    const rows = await db.all<Record<string, unknown>>(MERCHANTS_TOP_SELECT(limit));
    return rows.map((r) => MerchantTopDbRowSchema.parse(r));
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
