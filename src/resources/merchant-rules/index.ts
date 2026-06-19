import { brandRules } from './brands.js'
import { enRules } from './en.js'
import { esRules } from './es.js'
import { ptRules } from './pt.js'
import type { MerchantRule } from './types.js'

export type { CategoryId, MerchantRule } from './types.js'

/**
 * All seed merchant rules, additive across languages. Brands plus en/pt/es keyword packs are
 * unioned and loaded for every user — locale drives display names (Design 002), never which
 * rules apply, so classification works equally well in any supported language. Keys are
 * re-normalized and deduped at seed time (`bootstrap.ts`).
 */
export const MERCHANT_RULES: MerchantRule[] = [
  ...brandRules,
  ...enRules,
  ...ptRules,
  ...esRules,
]
