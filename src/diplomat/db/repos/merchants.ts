import { sql } from 'drizzle-orm'
import { z } from 'zod'
import type { MerchantMatch } from '../../../logic/classify.js'
import { ClassificationMethod } from '../../../models/transaction.js'
import type { Db } from '../driver.js'
import { merchantCategory, merchants } from '../schema.js'

const MatchRow = z.object({
  merchantKey:  z.string(),
  categoryId:   z.string(),
  categoryName: z.string(),
  weight:       z.number(),
  origin:       z.enum([ClassificationMethod.enum.rule, ClassificationMethod.enum.history]),
})

export type MerchantsRepo = {
  /** Find merchant→category candidates whose key appears in the normalized description. */
  matchCandidates: (normalizedDescription: string) => Promise<MerchantMatch[]>
  /** Learning write-back: a user correction strengthens the merchant→category edge. */
  strengthenFromTransaction: (transactionId: string, categoryId: string) => Promise<void>
}

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
    `)
    return rows.map((r) => MatchRow.parse(r))
  },

  strengthenFromTransaction: async (transactionId, categoryId) => {
    // Resolve the merchant key from the transaction
    const [tx] = await db.all<{ merchant_key: string | null }>(sql`
      SELECT merchant_key FROM transactions WHERE id = ${transactionId}
    `)
    if (!tx?.merchant_key) return

    const merchantKey = tx.merchant_key
    // Ensure merchant row exists (may have been created on transaction write)
    await db.insert(merchants).values({ key: merchantKey }).onConflictDoNothing()
    // Upsert the edge: insert weight=1 on first user correction, increment on repeat
    await db.insert(merchantCategory)
      .values({ merchantKey, categoryId, weight: 1, origin: ClassificationMethod.enum.history })
      .onConflictDoUpdate({
        target: [merchantCategory.merchantKey, merchantCategory.categoryId],
        set: { weight: sql`${merchantCategory.weight} + 1` },
      })
  },
})
