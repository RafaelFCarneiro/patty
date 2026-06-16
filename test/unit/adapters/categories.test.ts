import { describe, expect, it } from 'vitest'
import { CategoryKind } from '../../../src/models/category.js'
import * as wireInCategories from '../../../src/wire/in/categories.js'
import * as categoryAdapters from '../../../src/adapters/categories.js'

describe('dbToModel', () => {
  it('decodes flat SQL row for a category', () => {
    expect(
      categoryAdapters.dbToModel({ id: 'cat-1', name: 'Transporte', kind: CategoryKind.enum.expense, parentId: null }),
    ).toEqual({ id: 'cat-1', name: 'Transporte', kind: CategoryKind.enum.expense })
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
