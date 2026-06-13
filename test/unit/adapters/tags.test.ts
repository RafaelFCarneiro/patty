import { describe, expect, it } from 'vitest'
import * as tagsAdapters from '../../../src/adapters/tags.js'

const node = (properties: Record<string, unknown>) => ({ properties })

describe('dbToModel', () => {
  it('maps db node to Tag model', () => {
    const tag = tagsAdapters.dbToModel({ t: node({ id: 'tag-1', name: 'work' }) })
    expect(tag).toEqual({ id: 'tag-1', name: 'work' })
  })

  it('throws when required fields are missing', () => {
    expect(() => tagsAdapters.dbToModel({ t: node({ id: 'tag-1' }) })).toThrow()
    expect(() => tagsAdapters.dbToModel({ t: node({ name: 'work' }) })).toThrow()
  })

  it('ignores extra db properties not in the model', () => {
    const tag = tagsAdapters.dbToModel({ t: node({ id: 'tag-2', name: 'travel', extra: 'ignored' }) })
    expect(tag).toEqual({ id: 'tag-2', name: 'travel' })
    expect(tag).not.toHaveProperty('extra')
  })
})
