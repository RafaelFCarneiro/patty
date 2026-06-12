import { describe, expect, it } from 'vitest'
import * as categoryAdapters from './categories.js'

const node = (properties: Record<string, unknown>) => ({ properties })

describe('dbToModel', () => {
  it('decodes the category node', () => {
    expect(
      categoryAdapters.dbToModel({ c: node({ id: 'cat-1', name: 'Transporte', kind: 'expense' }) }),
    ).toEqual({ id: 'cat-1', name: 'Transporte', kind: 'expense' })
  })
})
