import { afterEach, describe, expect, it } from 'vitest'
import { callTool, deleteTransactions, makeClient, preferredAccount } from './helpers.js'

describe('MCP integration > pending transactions', () => {
  let createdTxIds: string[] = []

  afterEach(async () => {
    await deleteTransactions(createdTxIds)
    createdTxIds = []
  })

  it('pending transaction is excluded from balances and summaries; confirm flips it', async () => {
    const stamp = Date.now()
    const { client, transport } = makeClient()

    try {
      await client.connect(transport)

      let accountName: string
      if (preferredAccount) {
        accountName = preferredAccount
      } else {
        await callTool(client, {
          name: 'create_account',
          args: { name: `Pending Test ${stamp}`, type: 'checking', currency: 'BRL', initialBalance: 0 },
        })
        accountName = `Pending Test ${stamp}`
      }

      // Create an effective income so balances can be tested meaningfully
      const effective = (await callTool(client, {
        name: 'create_transaction',
        args: {
          description: `PTEST EFFECTIVE ${stamp}`,
          amount: 1000,
          type: 'income',
          date: '2026-01-15',
          account: accountName,
          idempotencyKey: `ptest-eff-${stamp}`,
        },
      })) as { transaction?: { id?: string; status?: string } }
      const effId = effective.transaction?.id
      if (!effId) throw new Error('missing effective tx id')
      createdTxIds.push(effId)
      expect(effective.transaction?.status).toBe('effective')

      // Create a pending expense
      const pending = (await callTool(client, {
        name: 'create_transaction',
        args: {
          description: `PTEST PENDING ${stamp}`,
          amount: 300,
          type: 'expense',
          date: '2026-01-20',
          account: accountName,
          status: 'pending',
          idempotencyKey: `ptest-pend-${stamp}`,
        },
      })) as { transaction?: { id?: string; status?: string } }
      const pendId = pending.transaction?.id
      if (!pendId) throw new Error('missing pending tx id')
      createdTxIds.push(pendId)
      expect(pending.transaction?.status).toBe('pending')

      // Balance should reflect only the effective income (1000), NOT the pending expense
      const balances = (await callTool(client, {
        name: 'get_account_balances',
        args: { account: accountName },
      })) as Array<{ balance?: number; projectedBalance?: number }>
      const acct = balances[0]
      expect(acct?.balance).toBe(1000)
      expect(acct?.projectedBalance).toBeUndefined()

      // projectedAsOf includes the pending expense
      const projected = (await callTool(client, {
        name: 'get_account_balances',
        args: { account: accountName, projectedAsOf: '2026-01-31' },
      })) as Array<{ balance?: number; projectedBalance?: number }>
      expect(projected[0]?.balance).toBe(1000)
      expect(projected[0]?.projectedBalance).toBe(700)

      // Spending summary for Jan 2026 should NOT include the pending expense
      const summary = (await callTool(client, {
        name: 'get_spending_summary',
        args: { month: 1, year: 2026 },
      })) as { currencies?: Array<{ totalExpenses?: number }> }
      const brlSummary = summary.currencies?.find(
        (c: Record<string, unknown>) => c.currency === 'BRL',
      ) as { totalExpenses?: number } | undefined
      expect(brlSummary?.totalExpenses ?? 0).toBe(0)

      // search with status filter returns only pending
      const pendingList = (await callTool(client, {
        name: 'search_transactions',
        args: { status: 'pending', account: accountName, limit: 50 },
      })) as Array<{ id?: string }>
      expect(pendingList.some((t) => t.id === pendId)).toBe(true)
      expect(pendingList.some((t) => t.id === effId)).toBe(false)

      // confirm flips pending → effective
      const confirmed = (await callTool(client, {
        name: 'confirm_transaction',
        args: { id: pendId },
      })) as { id?: string; status?: string }
      expect(confirmed.status).toBe('effective')

      // confirming again is a no-op (returns effective)
      const reconfirm = (await callTool(client, {
        name: 'confirm_transaction',
        args: { id: pendId },
      })) as { status?: string }
      expect(reconfirm.status).toBe('effective')

      // Now balance drops by 300
      const afterConfirm = (await callTool(client, {
        name: 'get_account_balances',
        args: { account: accountName },
      })) as Array<{ balance?: number }>
      expect(afterConfirm[0]?.balance).toBe(700)
    } finally {
      await transport.close()
    }
  })
})
