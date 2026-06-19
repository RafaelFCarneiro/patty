import type { MerchantRule } from './types.js'

/** English generic-keyword rules. Keys are normalized substrings of statement descriptions. */
export const enRules: MerchantRule[] = [
  // Food
  { key: 'restaurant', category: 'cat-food' },
  { key: 'grocery', category: 'cat-food' },
  { key: 'supermarket', category: 'cat-food' },
  { key: 'bakery', category: 'cat-food' },
  { key: 'coffee', category: 'cat-food' },

  // Transport (avoid bare 'gas' — it embeds in 'gasoline'; use specific keys)
  { key: 'gas station', category: 'cat-transport' },
  { key: 'gasoline', category: 'cat-transport' },
  { key: 'fuel', category: 'cat-transport' },
  { key: 'parking', category: 'cat-transport' },
  { key: 'taxi', category: 'cat-transport' },

  // Housing
  { key: 'rent', category: 'cat-housing' },
  { key: 'mortgage', category: 'cat-housing' },

  // Utilities
  { key: 'electric', category: 'cat-utilities' },
  { key: 'water bill', category: 'cat-utilities' },
  { key: 'internet', category: 'cat-utilities' },
  { key: 'mobile', category: 'cat-utilities' },

  // Health
  { key: 'pharmacy', category: 'cat-health' },
  { key: 'doctor', category: 'cat-health' },
  { key: 'dentist', category: 'cat-health' },
  { key: 'hospital', category: 'cat-health' },

  // Education
  { key: 'school', category: 'cat-education' },
  { key: 'university', category: 'cat-education' },
  { key: 'tuition', category: 'cat-education' },

  // Leisure
  { key: 'cinema', category: 'cat-leisure' },
  { key: 'theater', category: 'cat-leisure' },

  // Travel
  { key: 'hotel', category: 'cat-travel' },
  { key: 'airline', category: 'cat-travel' },
  { key: 'flight', category: 'cat-travel' },

  // Income
  { key: 'salary', category: 'cat-salary' },
  { key: 'payroll', category: 'cat-salary' },

  // Taxes (avoid bare 'tax' — it embeds in 'taxi')
  { key: 'income tax', category: 'cat-taxes' },
]
