import type { Classification } from '../models/transaction.js'
import { normalizeMerchant } from './merchant.js'

/** Stable key from the statement line itself: re-importing the same statement is a no-op. */
export const deriveIdempotencyKey = (item: {
  date: string
  description: string
  amount: number
}): string =>
  `${item.date}-${normalizeMerchant(item.description).replace(/\s+/g, '-') || 'tx'}-${item.amount.toFixed(2)}`

/** Items the agent should surface to the user for category confirmation. */
export const needsReview = (c: Classification): boolean => c.method === 'none' || c.confidence < 0.6
