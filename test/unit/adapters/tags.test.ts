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

  // Input is now the schema-derived TagRow, so missing/extra keys are a compile-time
  // error rather than a runtime case. Empty-string rejection is still enforced by Tag.parse.
  it('throws when id or name is an empty string', () => {
    expect(() => tagsAdapters.dbToModel({ id: '', name: 'work' })).toThrow()
    expect(() => tagsAdapters.dbToModel({ id: 'tag-1', name: '' })).toThrow()
  })
})
