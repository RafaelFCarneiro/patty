import type { MerchantRule } from './types.js'

/**
 * Language-agnostic brand merchants — recognised regardless of the user's locale.
 * Seeded for every user so a mixed statement (e.g. a Brazilian with Uber, Netflix and
 * iFood) classifies out of the box. Add the brand's normalized name as it appears on
 * statements; `uber eats`/`mercado livre` are listed longer-first so the length tiebreak
 * routes them to the right category.
 */
export const brandRules: MerchantRule[] = [
  // Ride-hailing & mobility
  { key: 'uber eats', category: 'cat-food' }, // longer than 'uber' → wins the tiebreak
  { key: 'uber', category: 'cat-transport' },
  { key: 'lyft', category: 'cat-transport' },
  { key: 'cabify', category: 'cat-transport' },
  { key: 'didi', category: 'cat-transport' },

  // Food delivery
  { key: 'ifood', category: 'cat-food' },
  { key: 'rappi', category: 'cat-food' },
  { key: 'doordash', category: 'cat-food' },
  { key: 'deliveroo', category: 'cat-food' },
  { key: 'glovo', category: 'cat-food' },

  // Streaming & subscriptions
  { key: 'netflix', category: 'cat-subscriptions' },
  { key: 'spotify', category: 'cat-subscriptions' },
  { key: 'disney', category: 'cat-subscriptions' },
  { key: 'youtube premium', category: 'cat-subscriptions' },
  { key: 'hbo', category: 'cat-subscriptions' },
  { key: 'paramount', category: 'cat-subscriptions' },

  // Marketplaces & retail
  { key: 'amazon prime', category: 'cat-subscriptions' }, // longer than 'amazon' → wins
  { key: 'amazon', category: 'cat-shopping' },
  { key: 'mercado livre', category: 'cat-shopping' }, // longer than 'mercado' (food) → wins
  { key: 'mercado libre', category: 'cat-shopping' },
  { key: 'aliexpress', category: 'cat-shopping' },
  { key: 'shopee', category: 'cat-shopping' },
  { key: 'walmart', category: 'cat-shopping' },

  // Travel
  { key: 'airbnb', category: 'cat-travel' },
  { key: 'booking com', category: 'cat-travel' },
  { key: 'latam', category: 'cat-travel' },
]
