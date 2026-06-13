import { afterEach, describe, expect, it } from 'vitest'
import { callTool, deleteTransactions, makeClient } from './helpers.js'

describe('MCP integration > recurring', () => {
  let createdTxIds: string[] = []

  afterEach(async () => {
    await deleteTransactions(createdTxIds)
    createdTxIds = []
  })

  it('materializes overdue transactions via apply_due_recurring', async () => {
    const stamp = Date.now()
    const accountName = `Recurring Test ${stamp}`
    const ruleDescription = `Monthly sub ${stamp}`
    const pastDate = new Date()
    pastDate.setDate(pastDate.getDate() - 7)
    const startDate = pastDate.toISOString().slice(0, 10)

    const { client, transport } = makeClient()

    try {
      await client.connect(transport)

      await callTool(client, {
        name: 'create_account',
        args: { name: accountName, type: 'checking', currency: 'BRL', initialBalance: 0 },
      })

      await callTool(client, {
        name: 'create_recurring',
        args: {
          description: ruleDescription,
          amount: 29.9,
          type: 'expense',
          period: 'monthly',
          startDate,
          account: accountName,
          category: 'Assinaturas',
        },
      })

      const result = (await callTool(client, {
        name: 'apply_due_recurring',
        args: {},
      })) as { applied?: Array<{ rule?: string; transaction?: { id?: string } }>; count?: number }

      const ours = result.applied?.filter((a) => a.rule === ruleDescription) ?? []
      for (const a of ours) {
        if (a.transaction?.id) createdTxIds.push(a.transaction.id)
      }

      expect(ours.length).toBeGreaterThan(0)
      expect(result.count).toBeGreaterThan(0)
    } finally {
      await transport.close()
    }
  })
})
