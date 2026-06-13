import { describe, expect, it } from 'vitest'
import { Tag } from '../../../src/models/tag.js'
import * as tagsAdapters from '../../../src/adapters/tags.js'

const node = (properties: Record<string, unknown>) => ({ properties })

describe('Tag model schema', () => {
  // Issue #4: z.string() was used instead of z.string().min(1), allowing empty strings
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
    const tag = tagsAdapters.dbToModel({ t: node({ id: 'tag-1', name: 'work' }) })
    expect(tag).toEqual({ id: 'tag-1', name: 'work' })
  })

  it('throws when required fields are missing', () => {
    expect(() => tagsAdapters.dbToModel({ t: node({ id: 'tag-1' }) })).toThrow()
    expect(() => tagsAdapters.dbToModel({ t: node({ name: 'work' }) })).toThrow()
  })

  // Issue #4: empty strings from a malformed db node must also be rejected
  it('throws when id or name is an empty string', () => {
    expect(() => tagsAdapters.dbToModel({ t: node({ id: '', name: 'work' }) })).toThrow()
    expect(() => tagsAdapters.dbToModel({ t: node({ id: 'tag-1', name: '' }) })).toThrow()
  })

  it('ignores extra db properties not in the model', () => {
    const tag = tagsAdapters.dbToModel({ t: node({ id: 'tag-2', name: 'travel', extra: 'ignored' }) })
    expect(tag).toEqual({ id: 'tag-2', name: 'travel' })
    expect(tag).not.toHaveProperty('extra')
  })
})
