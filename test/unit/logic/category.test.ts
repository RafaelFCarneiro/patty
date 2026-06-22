import { describe, expect, it } from 'vitest'
import { CategoryKind, type Category } from '../../../src/models/category.js'
import { Locale } from '../../../src/models/locale.js'
import { allNames, buildSynonyms, hasNameCollision, resolveAndSort, resolveDisplayName, withKindLabel } from '../../../src/logic/category.js'

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
