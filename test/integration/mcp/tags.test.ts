import { afterEach, describe, expect, it } from 'vitest'
import { callTool, ensure, makeClient } from './helpers.js'

const createdTagIds: string[] = []

afterEach(async () => {
  if (!createdTagIds.length) return
  const { client, transport } = makeClient()
  try {
    await client.connect(transport)
    for (const id of [...createdTagIds]) {
      try {
        await callTool(client, { name: 'delete_tag', args: { id } })
      } catch {
        // best-effort
      }
    }
  } finally {
    await transport.close()
    createdTagIds.length = 0
  }
})

describe('MCP integration > tags', () => {
  it('create_tag returns new tag with id and name', async () => {
    const stamp = Date.now()
    const { client, transport } = makeClient()
    try {
      await client.connect(transport)
      const tag = (await callTool(client, { name: 'create_tag', args: { name: `work-${stamp}` } })) as {
        id?: string
        name?: string
      }
      ensure(tag.id, 'Tag id missing')
      expect(tag.name).toBe(`work-${stamp}`)
      createdTagIds.push(tag.id)
    } finally {
      await transport.close()
    }
  })

  it('create_tag rejects duplicate name', async () => {
    const stamp = Date.now()
    const { client, transport } = makeClient()
    try {
      await client.connect(transport)
      const tag = (await callTool(client, { name: 'create_tag', args: { name: `dup-tag-${stamp}` } })) as {
        id?: string
      }
      ensure(tag.id, 'Tag id missing')
      createdTagIds.push(tag.id)

      await expect(
        callTool(client, { name: 'create_tag', args: { name: `dup-tag-${stamp}` } }),
      ).rejects.toThrow()
    } finally {
      await transport.close()
    }
  })

  it('list_tags includes the created tag', async () => {
    const stamp = Date.now()
    const { client, transport } = makeClient()
    try {
      await client.connect(transport)
      const tag = (await callTool(client, { name: 'create_tag', args: { name: `list-tag-${stamp}` } })) as {
        id?: string
        name?: string
      }
      ensure(tag.id, 'Tag id missing')
      createdTagIds.push(tag.id)

      const tags = (await callTool(client, { name: 'list_tags', args: {} })) as Array<{ id?: string; name?: string }>
      expect(Array.isArray(tags)).toBe(true)
      expect(tags.some((t) => t.id === tag.id)).toBe(true)
    } finally {
      await transport.close()
    }
  })

  it('delete_tag removes the tag and it no longer appears in list', async () => {
    const stamp = Date.now()
    const { client, transport } = makeClient()
    try {
      await client.connect(transport)
      const tag = (await callTool(client, { name: 'create_tag', args: { name: `del-tag-${stamp}` } })) as {
        id?: string
      }
      ensure(tag.id, 'Tag id missing')
      const tagId = tag.id

      const result = (await callTool(client, { name: 'delete_tag', args: { id: tagId } })) as { deleted?: boolean }
      expect(result.deleted).toBe(true)

      const tags = (await callTool(client, { name: 'list_tags', args: {} })) as Array<{ id?: string }>
      expect(tags.some((t) => t.id === tagId)).toBe(false)
      // already deleted — no need to clean up
    } finally {
      await transport.close()
    }
  })

  it('delete_tag returns deleted:false for non-existent id', async () => {
    const { client, transport } = makeClient()
    try {
      await client.connect(transport)
      const result = (await callTool(client, { name: 'delete_tag', args: { id: 'tag-does-not-exist' } })) as {
        deleted?: boolean
      }
      expect(result.deleted).toBe(false)
    } finally {
      await transport.close()
    }
  })
})
