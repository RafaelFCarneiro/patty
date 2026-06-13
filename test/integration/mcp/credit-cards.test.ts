import { afterEach, describe, expect, it } from 'vitest'
import { callTool, deleteTransactions, makeClient } from './helpers.js'

describe('MCP integration > credit cards', () => {
  let createdTxIds: string[] = []

  afterEach(async () => {
    await deleteTransactions(createdTxIds)
    createdTxIds = []
  })

  it('groups purchases into a bill and allows marking it paid', async () => {
    const stamp = Date.now()
    const cardName = `Test Card ${stamp}`
    const today = new Date().toISOString().slice(0, 10)
    const now = new Date()
    const month = now.getMonth() + 1
    const year = now.getFullYear()

    const { client, transport } = makeClient()

    try {
      await client.connect(transport)

      await callTool(client, {
        name: 'create_credit_card',
        args: { name: cardName, closingDay: 28, dueDay: 28, currency: 'BRL' },
      })

      const tx = (await callTool(client, {
        name: 'create_transaction',
        args: {
          description: `Card purchase ${stamp}`,
          amount: 99.9,
          type: 'expense',
          date: today,
          card: cardName,
          category: 'Outros',
          idempotencyKey: `integration-card-${stamp}`,
        },
      })) as { transaction?: { id?: string } }
      if (tx.transaction?.id) createdTxIds.push(tx.transaction.id)

      const bill = (await callTool(client, {
        name: 'get_bill',
        args: { card: cardName, month, year },
      })) as { bill?: { status?: string }; total?: number; transactions?: Array<{ id?: string }> }

      expect(bill.bill?.status).toBe('open')
      expect(bill.total).toBeCloseTo(99.9, 2)
      expect(bill.transactions?.some((t) => t.id === tx.transaction?.id)).toBe(true)

      await callTool(client, { name: 'pay_bill', args: { card: cardName, month, year } })

      const paid = (await callTool(client, {
        name: 'get_bill',
        args: { card: cardName, month, year },
      })) as { bill?: { status?: string } }
      expect(paid.bill?.status).toBe('paid')
    } finally {
      await transport.close()
    }
  })
})
