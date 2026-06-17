import * as R from 'remeda'
import { ClassificationMethod } from '../models/transaction.js'
import type { ClassifyOutcome } from '../models/transaction.js'

/** A merchant→category candidate from the merchant_category lookup. */
export type MerchantMatch = {
  merchantKey: string
  categoryId: string
  categoryName: string
  weight: number
  /** seeded rules vs learned-from-user-history associations */
  origin: typeof ClassificationMethod.enum.rule | typeof ClassificationMethod.enum.history
}

/**
 * Weight → confidence: monotonic, saturating.
 * weight 1 → 0.6, 3 (seed) → 0.8, 7+ → capped at 0.95.
 */
export const weightToConfidence = (weight: number): number =>
  Math.min(0.95, 0.5 + 0.1 * Math.max(0, weight))

/** An explicit category from the user is a classification with full confidence. */
export const userClassification = (category: { id: string; name: string }): ClassifyOutcome => ({
  method: 'user',
  confidence: 1,
  categoryId: category.id,
  categoryName: category.name,
})

export const pickClassification = (matches: readonly MerchantMatch[]): ClassifyOutcome => {
  const best = R.firstBy(matches, [(m) => m.weight, 'desc'])
  if (!best) return { method: 'none', confidence: 0 }
  return {
    method: best.origin,
    confidence: weightToConfidence(best.weight),
    categoryId: best.categoryId,
    categoryName: best.categoryName,
    merchantKey: best.merchantKey,
  }
}
