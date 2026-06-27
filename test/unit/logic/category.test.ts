import { describe, expect, it } from 'vitest'
import { CategoryKind, type Category } from '../../../src/models/category.js'
import { Locale } from '../../../src/models/locale.js'
import { allNames, buildSynonyms, hasNameCollision, hasSubCategoryNameCollision, isCategoryUnreferenced, isKindCompatible, localizeCategoryName, parentExists, resolveAndSort, resolveDisplayName, withKindLabel } from '../../../src/logic/category.js'

const seeded: Category = {
  id: 'cat-food', name: 'Food', kind: CategoryKind.enum.expense,
  names: { pt: 'Alimentação', es: 'Alimentación' },
}

const userCreated: Category = {
  id: 'custom-1', name: 'My Custom', kind: CategoryKind.enum.expense, names: null,
}

describe('resolveDisplayName', () => {
  it('returns locale-specific name when present', () => {
    expect(resolveDisplayName(seeded, 'pt').name).toBe('Alimentação')
  })

  it('falls back to canonical name for missing locale', () => {
    expect(resolveDisplayName(seeded, 'fr').name).toBe('Food')
  })

  it('returns canonical name for user category', () => {
    expect(resolveDisplayName(userCreated, 'pt').name).toBe('My Custom')
  })
})

describe('allNames', () => {
  it('returns canonical + all locale names for seeded category', () => {
    expect(allNames(seeded)).toEqual(['Food', 'Alimentação', 'Alimentación'])
  })

  it('returns only canonical name for user category', () => {
    expect(allNames(userCreated)).toEqual(['My Custom'])
  })
})

describe('hasNameCollision', () => {
  const categories = [seeded, userCreated]

  it('detects exact canonical name collision', () => {
    expect(hasNameCollision(categories, 'Food')).toBe(true)
  })

  it('detects accent-insensitive collision with locale name', () => {
    expect(hasNameCollision(categories, 'Alimentacao')).toBe(true)
  })

  it('detects case-insensitive collision', () => {
    expect(hasNameCollision(categories, 'food')).toBe(true)
  })

  it('returns false for non-colliding name', () => {
    expect(hasNameCollision(categories, 'Travel')).toBe(false)
  })
})

describe('resolveAndSort', () => {
  const transport: Category = {
    id: 'cat-transport', name: 'Transport', kind: CategoryKind.enum.expense,
    names: { pt: 'Transporte', es: 'Transporte' },
  }
  const health: Category = {
    id: 'cat-health', name: 'Health', kind: CategoryKind.enum.expense,
    names: { pt: 'Saúde', es: 'Salud' },
  }
  const categories = [transport, seeded, health]

  it('sorts by locale-resolved name in en', () => {
    const result = resolveAndSort(categories, 'en')
    expect(result.map((c) => c.name)).toEqual(['Food', 'Health', 'Transport'])
  })

  it('sorts by locale-resolved name in pt', () => {
    const result = resolveAndSort(categories, 'pt')
    expect(result.map((c) => c.name)).toEqual(['Alimentação', 'Saúde', 'Transporte'])
  })

  it('sorts by locale-resolved name in es', () => {
    const result = resolveAndSort(categories, 'es')
    expect(result.map((c) => c.name)).toEqual(['Alimentación', 'Salud', 'Transporte'])
  })
})

describe('buildSynonyms', () => {
  it('returns canonical name + locale names for resolved category', () => {
    const synonyms = buildSynonyms([seeded])
    const resolved: Category = { ...seeded, name: 'Alimentação' }
    expect(synonyms(resolved)).toEqual(['Food', 'Alimentação', 'Alimentación'])
  })

  it('returns only canonical name for user category with no locale names', () => {
    const synonyms = buildSynonyms([userCreated])
    expect(synonyms(userCreated)).toEqual(['My Custom'])
  })
})

describe('localizeCategoryName', () => {
  it('resolves to locale-specific name', () => {
    expect(localizeCategoryName('Food', { pt: 'Alimentação', es: 'Alimentación' }, 'pt')).toBe('Alimentação')
  })

  it('falls back to canonical name for missing locale', () => {
    expect(localizeCategoryName('Food', { pt: 'Alimentação' }, 'es')).toBe('Food')
  })

  it('returns canonical name when names is null', () => {
    expect(localizeCategoryName('My Custom', null, 'pt')).toBe('My Custom')
  })

  it('returns undefined when name is undefined', () => {
    expect(localizeCategoryName(undefined, { pt: 'Alimentação' }, 'pt')).toBeUndefined()
  })
})

describe('withKindLabel', () => {
  it('adds kindLabel for the given locale (data-first)', () => {
    const labeled = withKindLabel(seeded, Locale.enum.pt)
    expect(labeled.kindLabel).toBe('Despesa')
  })

  it('works as data-last for pipes', () => {
    const labeled = withKindLabel(Locale.enum.es)(seeded)
    expect(labeled.kindLabel).toBe('Gasto')
  })

  it('preserves original kind value', () => {
    const labeled = withKindLabel(seeded, Locale.enum.pt)
    expect(labeled.kind).toBe(CategoryKind.enum.expense)
  })

  it('labels income kind', () => {
    const income: Category = { id: 'cat-inc', name: 'Salary', kind: CategoryKind.enum.income, names: null }
    expect(withKindLabel(income, Locale.enum.en).kindLabel).toBe('Income')
  })
})

describe('hasSubCategoryNameCollision', () => {
  const siblings = [{ name: 'Fast Food' }, { name: 'Delivery' }]

  it('detects case-insensitive collision', () => {
    expect(hasSubCategoryNameCollision(siblings, 'fast food')).toBe(true)
  })

  it('returns false for non-colliding name', () => {
    expect(hasSubCategoryNameCollision(siblings, 'Dine-in')).toBe(false)
  })
})

describe('isCategoryUnreferenced', () => {
  it('returns true when all counts are zero', () => {
    expect(isCategoryUnreferenced({ transactions: 0, recurring: 0, subCategories: 0 })).toBe(true)
  })

  it('returns false when any count is non-zero', () => {
    expect(isCategoryUnreferenced({ transactions: 1, recurring: 0, subCategories: 0 })).toBe(false)
    expect(isCategoryUnreferenced({ transactions: 0, recurring: 1, subCategories: 0 })).toBe(false)
    expect(isCategoryUnreferenced({ transactions: 0, recurring: 0, subCategories: 1 })).toBe(false)
  })
})

describe('parentExists', () => {
  const categories = [seeded, userCreated]

  it('returns true when parent id is found', () => {
    expect(parentExists(categories, 'cat-food')).toBe(true)
  })

  it('returns false when parent id is not found', () => {
    expect(parentExists(categories, 'nonexistent')).toBe(false)
  })
})

describe('isKindCompatible', () => {
  it('returns true when kind is both', () => {
    expect(isKindCompatible('both', 'expense')).toBe(true)
    expect(isKindCompatible('both', 'income')).toBe(true)
  })

  it('returns true when kind matches transaction type', () => {
    expect(isKindCompatible('expense', 'expense')).toBe(true)
    expect(isKindCompatible('income', 'income')).toBe(true)
  })

  it('returns false when kind conflicts with transaction type', () => {
    expect(isKindCompatible('expense', 'income')).toBe(false)
    expect(isKindCompatible('income', 'expense')).toBe(false)
  })
})
