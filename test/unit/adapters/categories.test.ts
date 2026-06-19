import { describe, expect, it } from 'vitest'
import { CategoryKind } from '../../../src/models/category.js'
import * as wireInCategories from '../../../src/wire/in/categories.js'
import * as categoryAdapters from '../../../src/adapters/categories.js'

describe('dbToModel', () => {
  it('decodes flat SQL row for a category', () => {
    expect(
      categoryAdapters.dbToModel({ id: 'cat-1', name: 'Transport', kind: CategoryKind.enum.expense, parentId: null, names: null }),
    ).toEqual({ id: 'cat-1', name: 'Transport', kind: CategoryKind.enum.expense, names: null })
  })

  it('parses valid JSON names from DB row', () => {
    const result = categoryAdapters.dbToModel({
      id: 'cat-food', name: 'Food', kind: CategoryKind.enum.expense, parentId: null,
      names: '{"pt":"Alimentação","es":"Alimentación"}',
    })
    expect(result.names).toEqual({ pt: 'Alimentação', es: 'Alimentación' })
  })

  it('throws on invalid JSON in names', () => {
    expect(() =>
      categoryAdapters.dbToModel({
        id: 'cat-broken', name: 'Broken', kind: CategoryKind.enum.expense, parentId: null,
        names: '{not valid json}',
      }),
    ).toThrow(SyntaxError)
  })
})

describe('wireInToModel', () => {
  it('applies expense kind default when omitted', () => {
    const parsed = wireInCategories.CreateCategory.parse({ name: 'Salário' })
    expect(categoryAdapters.wireInToModel(parsed)).toEqual({ name: 'Salário', kind: CategoryKind.enum.expense })
  })

  it('preserves explicit kind when provided', () => {
    const parsed = wireInCategories.CreateCategory.parse({ name: 'Salário', kind: CategoryKind.enum.income })
    expect(categoryAdapters.wireInToModel(parsed)).toEqual({ name: 'Salário', kind: CategoryKind.enum.income })
  })
})
