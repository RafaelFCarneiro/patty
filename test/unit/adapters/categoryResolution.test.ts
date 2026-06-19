import { describe, expect, it } from 'vitest'
import type { Category } from '../../../src/models/category.js'
import { CategoryKind } from '../../../src/models/category.js'

const resolveDisplayName = (cat: Category, locale: string): string =>
  cat.names?.[locale] ?? cat.name

describe('category display name resolution', () => {
  const seeded: Category = {
    id: 'cat-food',
    name: 'Food',
    kind: CategoryKind.enum.expense,
    names: { pt: 'Alimentação', es: 'Alimentación' },
  }

  const userCreated: Category = {
    id: 'custom-1',
    name: 'My Custom',
    kind: CategoryKind.enum.expense,
    names: null,
  }

  it('returns locale-specific name when present', () => {
    expect(resolveDisplayName(seeded, 'pt')).toBe('Alimentação')
    expect(resolveDisplayName(seeded, 'es')).toBe('Alimentación')
  })

  it('falls back to canonical name for missing locale', () => {
    expect(resolveDisplayName(seeded, 'en')).toBe('Food')
    expect(resolveDisplayName(seeded, 'fr')).toBe('Food')
  })

  it('returns canonical name for user category (no names)', () => {
    expect(resolveDisplayName(userCreated, 'pt')).toBe('My Custom')
    expect(resolveDisplayName(userCreated, 'en')).toBe('My Custom')
  })
})
