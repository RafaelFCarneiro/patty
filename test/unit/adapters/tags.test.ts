import { describe, expect, it } from 'vitest'
import { Tag } from '../../../src/models/tag.js'
import * as tagsAdapters from '../../../src/adapters/tags.js'

describe('Tag model schema', () => {
  it('rejects empty id', () => {
    expect(() => Tag.parse({ id: '', name: 'work' })).toThrow()
  })

  it('rejects empty name', () => {
    expect(() => Tag.parse({ id: 'tag-1', name: '' })).toThrow()
  })

  it('accepts valid tag', () => {
    expect(Tag.parse({ id: 'tag-1', name: 'work' })).toEqual({ id: 'tag-1', name: 'work' })
  })
})

describe('dbToModel', () => {
  it('maps db node to Tag model', () => {
    const tag = tagsAdapters.dbToModel({ id: 'tag-1', name: 'work' })
    expect(tag).toEqual({ id: 'tag-1', name: 'work' })
  })

  it('throws when required fields are missing', () => {
    expect(() => tagsAdapters.dbToModel({ id: 'tag-1' })).toThrow()
    expect(() => tagsAdapters.dbToModel({ name: 'work' })).toThrow()
  })

  it('throws when id or name is an empty string', () => {
    expect(() => tagsAdapters.dbToModel({ id: '', name: 'work' })).toThrow()
    expect(() => tagsAdapters.dbToModel({ id: 'tag-1', name: '' })).toThrow()
  })

  it('ignores extra db properties not in the model', () => {
    const tag = tagsAdapters.dbToModel({ id: 'tag-2', name: 'travel', extra: 'ignored' })
    expect(tag).toEqual({ id: 'tag-2', name: 'travel' })
    expect(tag).not.toHaveProperty('extra')
  })
})
