import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { callTool, callToolError, deleteTransactions, makeClient } from './helpers.js'

type Category = { id: string; name: string; kind: string; names: Record<string, string> | null }
type ErrorPayload<T = unknown> = { error: T }
type InUseError = { code: string; entity: string; name: string; references: { transactions: number; recurring: number; subCategories: number } }

describe('MCP integration > categories', () => {
  let client: Client
  let transport: StreamableHTTPClientTransport
  const stamp = Date.now()
  const accountName = `cat-test-acct-${stamp}`
  const createdTxIds: string[] = []

  beforeAll(async () => {
    const c = makeClient()
    client = c.client
    transport = c.transport
    await client.connect(transport)
    await callTool(client, { name: 'create_account', args: { name: accountName, type: 'checking', currency: 'BRL', initialBalance: 0 } })
  })

  afterAll(async () => {
    await deleteTransactions(createdTxIds)
    await callTool(client, { name: 'set_locale', args: { locale: 'en', source: 'explicit' } })
    await transport.close()
  })

  it('list_categories returns results sorted by locale-resolved name', async () => {
    await callTool(client, { name: 'set_locale', args: { locale: 'pt', source: 'explicit' } })
    const categories = await callTool(client, { name: 'list_categories' }) as Category[]
    const names = categories.map((c) => c.name)
    const sorted = [...names].sort((a, b) => a.localeCompare(b, 'pt', { sensitivity: 'base' }))
    expect(names).toEqual(sorted)
  })

  it('delete_category succeeds for an unreferenced user category', async () => {
    const cat = (await callTool(client, {
      name: 'create_category',
      args: { name: `del-cat-${stamp}`, kind: 'expense' },
    })) as Category

    const result = (await callTool(client, { name: 'delete_category', args: { name: cat.name } })) as { deleted: boolean }
    expect(result.deleted).toBe(true)

    const all = (await callTool(client, { name: 'list_categories' })) as Category[]
    expect(all.some((c) => c.id === cat.id)).toBe(false)
  })

  it('delete_category blocked when a transaction references it', async () => {
    const cat = (await callTool(client, {
      name: 'create_category',
      args: { name: `in-use-cat-${stamp}`, kind: 'expense' },
    })) as Category

    const txResult = (await callTool(client, {
      name: 'create_transaction',
      args: {
        description: `test-del-cat-${stamp}`,
        amount: 10,
        type: 'expense',
        date: '2026-01-15',
        account: accountName,
        category: cat.name,
        idempotencyKey: `del-cat-tx-${stamp}`,
      },
    })) as { transaction: { id: string } }
    createdTxIds.push(txResult.transaction.id)

    const { error } = (await callToolError(client, { name: 'delete_category', args: { name: cat.name } })) as ErrorPayload<InUseError>
    expect(error.code).toBe('in_use')
    expect(error.entity).toBe('category')
    expect(error.references.transactions).toBeGreaterThanOrEqual(1)

    const all = (await callTool(client, { name: 'list_categories' })) as Category[]
    expect(all.some((c) => c.id === cat.id)).toBe(true)
  })

  it('delete_category blocked when it has sub-categories', async () => {
    const cat = (await callTool(client, {
      name: 'create_category',
      args: { name: `parent-cat-${stamp}`, kind: 'expense' },
    })) as Category

    await callTool(client, {
      name: 'create_sub_category',
      args: { name: `child-sub-${stamp}`, parentId: cat.id },
    })

    const { error } = (await callToolError(client, { name: 'delete_category', args: { name: cat.name } })) as ErrorPayload<InUseError>
    expect(error.code).toBe('in_use')
    expect(error.references.subCategories).toBeGreaterThanOrEqual(1)
  })

  it('delete_category succeeds for a seeded category whose only references are merchant rules', async () => {
    const allBefore = (await callTool(client, { name: 'list_categories' })) as Category[]
    const target = allBefore.find((c) => c.name === 'Subscriptions')
    if (!target) return

    const result = (await callTool(client, { name: 'delete_category', args: { name: target.name } })) as { deleted: boolean }
    expect(result.deleted).toBe(true)

    const allAfter = (await callTool(client, { name: 'list_categories' })) as Category[]
    expect(allAfter.some((c) => c.id === target.id)).toBe(false)
  })

  it('delete_category returns unknown_category for non-existent name', async () => {
    const { error } = (await callToolError(client, {
      name: 'delete_category',
      args: { name: 'nonexistent-category-xyz-999' },
    })) as ErrorPayload<{ code: string }>
    expect(error.code).toBe('unknown_category')
  })
})
