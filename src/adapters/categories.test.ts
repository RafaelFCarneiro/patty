import { describe, expect, it } from 'vitest'
import * as wireInCategories from '../wire/in/categories.js'
import * as categoryAdapters from './categories.js'

const node = (properties: Record<string, unknown>) => ({ properties })

describe('dbToModel', () => {
  it('decodes the category node', () => {
    expect(
      categoryAdapters.dbToModel({ c: node({ id: 'cat-1', name: 'Transporte', kind: 'expense' }) }),
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
