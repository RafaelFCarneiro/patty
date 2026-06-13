import { afterEach, describe, expect, it } from 'vitest'
import { ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { callTool, deleteTransactions, ensure, makeClient, preferredAccount } from './helpers.js'

describe('MCP integration > transactions', () => {
  let createdTxIds: string[] = []

  afterEach(async () => {
    await deleteTransactions(createdTxIds)
    createdTxIds = []
  })

  it('executes a full create/search/update/delete flow', async () => {
    const stamp = Date.now()
    const txDescription = `INTEGRATION MCP ${stamp}`
    const txDescriptionUpdated = `${txDescription} UPDATED`
    const txKey = `integration-mcp-${stamp}-0.01`
    const today = new Date().toISOString().slice(0, 10)

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
          category: 'Outros',
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

  it('bulk import returns per-item status and treats re-imports as duplicates', async () => {
    const stamp = Date.now()
    const accountName = `Bulk Import ${stamp}`
    const today = new Date().toISOString().slice(0, 10)

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
})
