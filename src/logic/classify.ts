import * as R from 'remeda'
import type { Classification } from '../models/transaction.js'

/** A merchant→category edge candidate returned by the graph. */
export type MerchantMatch = {
  merchantKey: string
  categoryId: string
  categoryName: string
  weight: number
  /** seeded rules vs learned-from-history edges */
  origin: 'rule' | 'graph'
}

export type ClassifyOutcome = Classification & {
  categoryId?: string
  categoryName?: string
  merchantKey?: string
}

/**
 * Weight → confidence: monotonic, saturating.
 * weight 1 → 0.6, 3 (seed) → 0.8, 7+ → capped at 0.95.
 */
export const weightToConfidence = (weight: number): number =>
  Math.min(0.95, 0.5 + 0.1 * Math.max(0, weight))

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
