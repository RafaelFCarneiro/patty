import { describe, expect, it } from 'vitest'
import { Locale } from '../../../src/models/locale.js'
import { allNamesForKey, defaultCategoryKeys, translate, translateWithFallback } from '../../../src/logic/i18n.js'

describe('translate', () => {
  it('returns English name for a known key', () => {
    expect(translate('cat-food', Locale.enum.en)).toBe('Food')
  })

  it('returns Portuguese name for a known key', () => {
    expect(translate('cat-food', Locale.enum.pt)).toBe('Alimentação')
  })

  it('returns Spanish name for a known key', () => {
    expect(translate('cat-food', Locale.enum.es)).toBe('Alimentación')
  })

  it('returns undefined for an unknown key', () => {
    expect(translate('cat-unknown', Locale.enum.en)).toBeUndefined()
  })
})

describe('translateWithFallback', () => {
  it('returns translation when available', () => {
    expect(translateWithFallback('cat-salary', Locale.enum.pt, 'Salary')).toBe('Salário')
  })

  it('returns fallback for unknown key', () => {
    expect(translateWithFallback('cat-unknown', Locale.enum.en, 'My Custom')).toBe('My Custom')
  })
})

describe('allNamesForKey', () => {
  it('returns all locale names for a key', () => {
    const names = allNamesForKey('cat-food')
    expect(names).toContain('Food')
    expect(names).toContain('Alimentação')
    expect(names).toContain('Alimentación')
  })

  it('deduplicates shared names', () => {
    const names = allNamesForKey('cat-transport')
    expect(names.filter((n) => n === 'Transporte').length).toBe(1)
  })

  it('returns empty array for unknown key', () => {
    expect(allNamesForKey('cat-unknown')).toEqual([])
  })
})

describe('defaultCategoryKeys', () => {
  it('contains 15 keys', () => {
    expect(defaultCategoryKeys).toHaveLength(15)
  })

  it('every key has pt, es, and en translations', () => {
    for (const key of defaultCategoryKeys) {
      expect(translate(key, Locale.enum.en)).toBeDefined()
      expect(translate(key, Locale.enum.pt)).toBeDefined()
      expect(translate(key, Locale.enum.es)).toBeDefined()
    }
  })
})
