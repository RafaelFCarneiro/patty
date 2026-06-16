import { describe, expect, it } from 'vitest'
import * as wireInCategories from '../../../src/wire/in/categories.js'
import * as categoryAdapters from '../../../src/adapters/categories.js'

describe('dbToModel', () => {
  it('decodes flat SQL row for a category', () => {
    expect(
      categoryAdapters.dbToModel({ id: 'cat-1', name: 'Transporte', kind: 'expense', parentId: null }),
    ).toEqual({ id: 'cat-1', name: 'Transporte', kind: 'expense' })
  })
})

describe('wireInToModel', () => {
  it('applies expense kind default when omitted', () => {
    const parsed = wireInCategories.CreateCategory.parse({ name: 'Salário' })
    expect(categoryAdapters.wireInToModel(parsed)).toEqual({ name: 'Salário', kind: 'expense' })
  })

  it('preserves explicit kind when provided', () => {
    const parsed = wireInCategories.CreateCategory.parse({ name: 'Salário', kind: 'income' })
    expect(categoryAdapters.wireInToModel(parsed)).toEqual({ name: 'Salário', kind: 'income' })
  })
})
