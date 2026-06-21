import { afterEach, describe, expect, it } from 'vitest'
import { ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { toIsoDate } from '../../../src/logic/period.js'
import { callTool, deleteTransactions, ensure, makeClient, preferredAccount } from './helpers.js'

describe('MCP integration > transactions', () => {
  let createdTxIds: string[] = []
  const createdTagIds: string[] = []

  afterEach(async () => {
    await deleteTransactions(createdTxIds)
    createdTxIds = []

    if (createdTagIds.length) {
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
    }
  })

  it('executes a full create/search/update/delete flow', async () => {
    const stamp = Date.now()
    const txDescription = `INTEGRATION MCP ${stamp}`
    const txDescriptionUpdated = `${txDescription} UPDATED`
    const txKey = `integration-mcp-${stamp}-0.01`
    const today = toIsoDate(new Date())

    const { client, transport } = makeClient()

    try {
      await client.connect(transport)

      const toolsResult = await client.request({ method: 'tools/list', params: {} }, ListToolsResultSchema)
      const toolNames = new Set(toolsResult.tools.map((t) => t.name))
      expect(toolNames.has('create_transaction')).toBe(true)
      expect(toolNames.has('search_transactions')).toBe(true)
      expect(toolNames.has('update_transaction')).toBe(true)
      expect(toolNames.has('delete_transaction')).toBe(true)

      let accountName: string
      if (preferredAccount) {
        accountName = preferredAccount
      } else {
        await callTool(client, {
          name: 'create_account',
          args: { name: `Integration Test ${stamp}`, type: 'checking', currency: 'BRL', initialBalance: 0 },
        })
        accountName = `Integration Test ${stamp}`
      }

      const created = (await callTool(client, {
        name: 'create_transaction',
        args: {
          description: txDescription,
          amount: 0.01,
          type: 'expense',
          date: today,
          account: accountName,
          category: 'Other',
          idempotencyKey: txKey,
        },
      })) as { transaction?: { id?: string }; created?: boolean }

      const txId = created.transaction?.id
      ensure(txId, 'Transaction id missing')
      createdTxIds.push(txId)
      expect(created.created).toBe(true)

      const found = (await callTool(client, {
        name: 'search_transactions',
        args: { text: txDescription, limit: 10 },
      })) as Array<{ id?: string }>
      expect(found.some((tx) => tx.id === txId)).toBe(true)

      const updated = (await callTool(client, {
        name: 'update_transaction',
        args: { id: txId, description: txDescriptionUpdated },
      })) as { description?: string }
      expect(updated.description).toBe(txDescriptionUpdated)

      const dryRun = (await callTool(client, {
        name: 'delete_transaction',
        args: { id: txId },
      })) as { dryRun?: boolean; deleted?: boolean }
      expect(dryRun.dryRun).toBe(true)
      expect(dryRun.deleted).toBe(false)

      const deleted = (await callTool(client, {
        name: 'delete_transaction',
        args: { id: txId, confirm: true },
      })) as { deleted?: boolean }
      expect(deleted.deleted).toBe(true)
      createdTxIds = createdTxIds.filter((id) => id !== txId)

      const afterDelete = (await callTool(client, {
        name: 'search_transactions',
        args: { text: txDescriptionUpdated, limit: 10 },
      })) as Array<{ id?: string }>
      expect(afterDelete.some((tx) => tx.id === txId)).toBe(false)
    } finally {
      await transport.close()
    }
  })

  it('search_transactions treats whitespace-only text as no text filter, not as match-nothing', async () => {
    const stamp = Date.now()
    const { client, transport } = makeClient()
    try {
      await client.connect(transport)
      const created = (await callTool(client, {
        name: 'create_transaction',
        args: {
          description: `Whitespace search ${stamp}`,
          amount: 1,
          type: 'expense',
          category: 'Other',
          idempotencyKey: `test-ws-search-${stamp}`,
        },
      })) as { transaction?: { id?: string } }
      const txId = created.transaction?.id
      ensure(txId, 'Transaction id missing')
      createdTxIds.push(txId)

      const results = (await callTool(client, {
        name: 'search_transactions',
        args: { text: '   ', limit: 200 },
      })) as Array<{ id?: string }>

      expect(results.some((tx) => tx.id === txId)).toBe(true)
    } finally {
      await transport.close()
    }
  })

  it('bulk import returns per-item status and treats re-imports as duplicates', async () => {
    const stamp = Date.now()
    const accountName = `Bulk Import ${stamp}`
    const today = toIsoDate(new Date())

    const { client, transport } = makeClient()

    try {
      await client.connect(transport)

      await callTool(client, {
        name: 'create_account',
        args: { name: accountName, type: 'checking', currency: 'BRL', initialBalance: 0 },
      })

      const result = (await callTool(client, {
        name: 'create_transactions_bulk',
        args: {
          account: accountName,
          items: [
            { description: 'iFood refeição', amount: 45, type: 'expense', date: today, idempotencyKey: `bulk-${stamp}-1` },
            { description: 'Salário empresa', amount: 5000, type: 'income', date: today, idempotencyKey: `bulk-${stamp}-2` },
            { description: 'Uber corrida', amount: 22.5, type: 'expense', date: today, idempotencyKey: `bulk-${stamp}-3` },
          ],
        },
      })) as {
        summary?: { created?: number; needsReview?: number; duplicates?: number; errors?: number }
        items?: Array<{ status?: string; transaction?: { id?: string } }>
      }

      expect(result.items?.length).toBe(3)
      for (const item of result.items ?? []) {
        expect(['created', 'needs_review']).toContain(item.status)
        if (item.transaction?.id) createdTxIds.push(item.transaction.id)
      }
      const { created = 0, needsReview = 0 } = result.summary ?? {}
      expect(created + needsReview).toBe(3)

      // Re-importing the same items is idempotent — returns duplicates, not new transactions
      const reimport = (await callTool(client, {
        name: 'create_transactions_bulk',
        args: {
          account: accountName,
          items: [
            { description: 'iFood refeição', amount: 45, type: 'expense', date: today, idempotencyKey: `bulk-${stamp}-1` },
          ],
        },
      })) as { summary?: { duplicates?: number } }
      expect(reimport.summary?.duplicates).toBe(1)
    } finally {
      await transport.close()
    }
  })

  it('creates transaction with tags and returns them in the view', async () => {
    const stamp = Date.now()
    const { client, transport } = makeClient()
    try {
      await client.connect(transport)

      const account = `Tags Tx ${stamp}`
      await callTool(client, { name: 'create_account', args: { name: account, type: 'checking', currency: 'BRL', initialBalance: 0 } })

      const workTag = (await callTool(client, { name: 'create_tag', args: { name: `work-${stamp}` } })) as { id?: string }
      const travelTag = (await callTool(client, { name: 'create_tag', args: { name: `travel-${stamp}` } })) as { id?: string }
      ensure(workTag.id, 'Work tag id missing')
      ensure(travelTag.id, 'Travel tag id missing')
      createdTagIds.push(workTag.id, travelTag.id)

      const created = (await callTool(client, {
        name: 'create_transaction',
        args: {
          description: `Tagged tx ${stamp}`,
          amount: 10,
          type: 'expense',
          account,
          category: 'Other',
          idempotencyKey: `tagged-${stamp}`,
          tags: [`work-${stamp}`, `travel-${stamp}`],
        },
      })) as { transaction?: { id?: string; tags?: string[] } }

      const txId = created.transaction?.id
      ensure(txId, 'Transaction id missing')
      createdTxIds.push(txId)

      expect(created.transaction?.tags).toContain(`work-${stamp}`)
      expect(created.transaction?.tags).toContain(`travel-${stamp}`)
    } finally {
      await transport.close()
    }
  })

  it('update_transaction replaces the tag set', async () => {
    const stamp = Date.now()
    const { client, transport } = makeClient()
    try {
      await client.connect(transport)

      const account = `Tags Update ${stamp}`
      await callTool(client, { name: 'create_account', args: { name: account, type: 'checking', currency: 'BRL', initialBalance: 0 } })

      const tagA = (await callTool(client, { name: 'create_tag', args: { name: `tag-a-${stamp}` } })) as { id?: string }
      const tagB = (await callTool(client, { name: 'create_tag', args: { name: `tag-b-${stamp}` } })) as { id?: string }
      ensure(tagA.id, 'Tag A id missing')
      ensure(tagB.id, 'Tag B id missing')
      createdTagIds.push(tagA.id, tagB.id)

      const created = (await callTool(client, {
        name: 'create_transaction',
        args: {
          description: `Update tags tx ${stamp}`,
          amount: 5,
          type: 'expense',
          account,
          category: 'Other',
          idempotencyKey: `update-tags-${stamp}`,
          tags: [`tag-a-${stamp}`],
        },
      })) as { transaction?: { id?: string } }

      const txId = created.transaction?.id
      ensure(txId, 'Transaction id missing')
      createdTxIds.push(txId)

      // Replace tag-a with tag-b
      const updated = (await callTool(client, {
        name: 'update_transaction',
        args: { id: txId, tags: [`tag-b-${stamp}`] },
      })) as { tags?: string[] }
      expect(updated.tags).toContain(`tag-b-${stamp}`)
      expect(updated.tags).not.toContain(`tag-a-${stamp}`)
    } finally {
      await transport.close()
    }
  })

  it('update_transaction with empty tags removes all tags', async () => {
    const stamp = Date.now()
    const { client, transport } = makeClient()
    try {
      await client.connect(transport)

      const account = `Tags Clear ${stamp}`
      await callTool(client, { name: 'create_account', args: { name: account, type: 'checking', currency: 'BRL', initialBalance: 0 } })

      const tag = (await callTool(client, { name: 'create_tag', args: { name: `clear-tag-${stamp}` } })) as { id?: string }
      ensure(tag.id, 'Tag id missing')
      createdTagIds.push(tag.id)

      const created = (await callTool(client, {
        name: 'create_transaction',
        args: {
          description: `Clear tags tx ${stamp}`,
          amount: 3,
          type: 'expense',
          account,
          category: 'Other',
          idempotencyKey: `clear-tags-${stamp}`,
          tags: [`clear-tag-${stamp}`],
        },
      })) as { transaction?: { id?: string } }

      const txId = created.transaction?.id
      ensure(txId, 'Transaction id missing')
      createdTxIds.push(txId)

      const updated = (await callTool(client, {
        name: 'update_transaction',
        args: { id: txId, tags: [] },
      })) as { tags?: string[] }
      expect(updated.tags).toEqual([])
    } finally {
      await transport.close()
    }
  })

  it('search_transactions filters by tag', async () => {
    const stamp = Date.now()
    const { client, transport } = makeClient()
    try {
      await client.connect(transport)

      const account = `Tags Search ${stamp}`
      await callTool(client, { name: 'create_account', args: { name: account, type: 'checking', currency: 'BRL', initialBalance: 0 } })

      const tag = (await callTool(client, { name: 'create_tag', args: { name: `search-tag-${stamp}` } })) as { id?: string }
      ensure(tag.id, 'Tag id missing')
      createdTagIds.push(tag.id)

      const today = toIsoDate(new Date())

      const taggedTx = (await callTool(client, {
        name: 'create_transaction',
        args: {
          description: `Tagged for search ${stamp}`,
          amount: 7,
          type: 'expense',
          date: today,
          account,
          category: 'Other',
          idempotencyKey: `tagged-search-${stamp}`,
          tags: [`search-tag-${stamp}`],
        },
      })) as { transaction?: { id?: string } }
      const taggedTxId = taggedTx.transaction?.id
      ensure(taggedTxId, 'Tagged transaction id missing')
      createdTxIds.push(taggedTxId)

      const untaggedTx = (await callTool(client, {
        name: 'create_transaction',
        args: {
          description: `Untagged for search ${stamp}`,
          amount: 8,
          type: 'expense',
          date: today,
          account,
          category: 'Other',
          idempotencyKey: `untagged-search-${stamp}`,
        },
      })) as { transaction?: { id?: string } }
      const untaggedTxId = untaggedTx.transaction?.id
      ensure(untaggedTxId, 'Untagged transaction id missing')
      createdTxIds.push(untaggedTxId)

      const results = (await callTool(client, {
        name: 'search_transactions',
        args: { tags: [`search-tag-${stamp}`], limit: 50 },
      })) as Array<{ id?: string }>

      const ids = results.map((t) => t.id)
      expect(ids).toContain(taggedTxId)
      expect(ids).not.toContain(untaggedTxId)
    } finally {
      await transport.close()
    }
  })

  // Issue #3: tag filter was applied per-row, truncating the tags[] of matched transactions
  // to only the matching subset instead of returning all tags.
  it('search_transactions returns the full tag set on matched transactions, not just the filter tag', async () => {
    const stamp = Date.now()
    const { client, transport } = makeClient()
    try {
      await client.connect(transport)

      const account = `Tags Full Set ${stamp}`
      await callTool(client, { name: 'create_account', args: { name: account, type: 'checking', currency: 'BRL', initialBalance: 0 } })

      const tagA = (await callTool(client, { name: 'create_tag', args: { name: `full-a-${stamp}` } })) as { id?: string }
      const tagB = (await callTool(client, { name: 'create_tag', args: { name: `full-b-${stamp}` } })) as { id?: string }
      ensure(tagA.id, 'Tag A id missing')
      ensure(tagB.id, 'Tag B id missing')
      createdTagIds.push(tagA.id, tagB.id)

      const created = (await callTool(client, {
        name: 'create_transaction',
        args: {
          description: `Full tagset tx ${stamp}`,
          amount: 11,
          type: 'expense',
          account,
          category: 'Other',
          idempotencyKey: `full-tagset-${stamp}`,
          tags: [`full-a-${stamp}`, `full-b-${stamp}`],
        },
      })) as { transaction?: { id?: string; tags?: string[] } }
      const txId = created.transaction?.id
      ensure(txId, 'Transaction id missing')
      createdTxIds.push(txId)

      // Search by only one of the two tags — the result must still carry both
      const results = (await callTool(client, {
        name: 'search_transactions',
        args: { tags: [`full-a-${stamp}`], limit: 50 },
      })) as Array<{ id?: string; tags?: string[] }>

      const match = results.find((tx) => tx.id === txId)
      expect(match).toBeDefined()
      expect(match?.tags).toContain(`full-a-${stamp}`)
      expect(match?.tags).toContain(`full-b-${stamp}`)
    } finally {
      await transport.close()
    }
  })

  // Issue #1: attachTags used MERGE instead of MATCH, creating orphan (:Tag) nodes without
  // id when a non-existent tag name was passed — violating the Tag schema.
  it('create_transaction silently ignores tag names that do not exist', async () => {
    const stamp = Date.now()
    const { client, transport } = makeClient()
    try {
      await client.connect(transport)

      const account = `Ghost Tag ${stamp}`
      await callTool(client, { name: 'create_account', args: { name: account, type: 'checking', currency: 'BRL', initialBalance: 0 } })

      const created = (await callTool(client, {
        name: 'create_transaction',
        args: {
          description: `Ghost tag tx ${stamp}`,
          amount: 1,
          type: 'expense',
          account,
          category: 'Other',
          idempotencyKey: `ghost-tag-${stamp}`,
          tags: [`nonexistent-tag-${stamp}`],
        },
      })) as { transaction?: { id?: string; tags?: string[] } }
      const txId = created.transaction?.id
      ensure(txId, 'Transaction id missing')
      createdTxIds.push(txId)

      // Non-existent tag must be silently dropped — no orphan node created
      expect(created.transaction?.tags).toEqual([])

      // Orphan node must not appear in list_tags
      const tags = (await callTool(client, { name: 'list_tags', args: {} })) as Array<{ name?: string }>
      expect(tags.some((t) => t.name === `nonexistent-tag-${stamp}`)).toBe(false)
    } finally {
      await transport.close()
    }
  })

  // Regression guard: collect(DISTINCT tag.name) on an OPTIONAL MATCH returns []
  // (not [null]) for transactions with no TAGGED_WITH edges, because Cypher's
  // collect() skips nulls by design. This test confirms untagged transactions
  // parse without error and expose tags: [].
  it('create_transaction without tags returns tags: [] — not null or [null]', async () => {
    const stamp = Date.now()
    const { client, transport } = makeClient()
    try {
      await client.connect(transport)

      const account = `No Tags ${stamp}`
      await callTool(client, { name: 'create_account', args: { name: account, type: 'checking', currency: 'BRL', initialBalance: 0 } })

      // Create with no tags field at all
      const created = (await callTool(client, {
        name: 'create_transaction',
        args: {
          description: `No tags tx ${stamp}`,
          amount: 5,
          type: 'expense',
          account,
          category: 'Other',
          idempotencyKey: `no-tags-${stamp}`,
        },
      })) as { transaction?: { id?: string; tags?: string[] } }

      const txId = created.transaction?.id
      ensure(txId, 'Transaction id missing')
      createdTxIds.push(txId)

      // create response: tags must be an empty array, not null or [null]
      expect(Array.isArray(created.transaction?.tags)).toBe(true)
      expect(created.transaction?.tags).toEqual([])

      // search response: same guarantee on the read path
      const results = (await callTool(client, {
        name: 'search_transactions',
        args: { text: `No tags tx ${stamp}`, limit: 10 },
      })) as Array<{ id?: string; tags?: string[] }>

      const match = results.find((tx) => tx.id === txId)
      expect(match).toBeDefined()
      expect(Array.isArray(match?.tags)).toBe(true)
      expect(match?.tags).toEqual([])
    } finally {
      await transport.close()
    }
  })

  // Tags are case-sensitive: "Work" and "work" are distinct tags.
  // Attaching with a different casing silently drops the tag (no match), and
  // search by a different casing returns no results.
  it('tags are case-sensitive — different casing does not match', async () => {
    const stamp = Date.now()
    const { client, transport } = makeClient()
    try {
      await client.connect(transport)

      const account = `Case Tag ${stamp}`
      await callTool(client, { name: 'create_account', args: { name: account, type: 'checking', currency: 'BRL', initialBalance: 0 } })

      // Create tag with uppercase name
      const tag = (await callTool(client, { name: 'create_tag', args: { name: `CASE-TAG-${stamp}` } })) as { id?: string }
      ensure(tag.id, 'Tag id missing')
      createdTagIds.push(tag.id)

      // Attach using exact same casing — must succeed
      const created = (await callTool(client, {
        name: 'create_transaction',
        args: {
          description: `Case tag tx ${stamp}`,
          amount: 4,
          type: 'expense',
          account,
          category: 'Other',
          idempotencyKey: `case-tag-${stamp}`,
          tags: [`CASE-TAG-${stamp}`],
        },
      })) as { transaction?: { id?: string; tags?: string[] } }
      const txId = created.transaction?.id
      ensure(txId, 'Transaction id missing')
      createdTxIds.push(txId)

      expect(created.transaction?.tags).toContain(`CASE-TAG-${stamp}`)

      // Search using wrong casing — must NOT find the transaction
      const results = (await callTool(client, {
        name: 'search_transactions',
        args: { tags: [`case-tag-${stamp}`], limit: 50 },
      })) as Array<{ id?: string }>
      expect(results.some((tx) => tx.id === txId)).toBe(false)
    } finally {
      await transport.close()
    }
  })
})
