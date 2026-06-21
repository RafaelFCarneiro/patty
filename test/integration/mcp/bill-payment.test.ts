import { describe, expect, it } from 'vitest'
import { toIsoDate } from '../../../src/logic/period.js'
import { callTool, callToolError, makeClient } from './helpers.js'

describe('MCP integration > bill payment (Design 003)', () => {
  const now = new Date()
  const stamp = now.getTime()
  const cardName = `BillPay Card ${stamp}`
  const bankName = `BillPay Bank ${stamp}`
  // Pin to day 15 so the purchase always falls within the closingDay=28 cycle
  const pinned = new Date(now.getFullYear(), now.getMonth(), 15)
  const today = toIsoDate(pinned)
  const month = pinned.getMonth() + 1
  const year = pinned.getFullYear()

  it('pay_bill creates a transfer, debits payer, credits card account, marks bill paid', async () => {
    const { client, transport } = makeClient()

    try {
      await client.connect(transport)

      await callTool(client, {
        name: 'create_account',
        args: { name: bankName, type: 'checking', currency: 'BRL', initialBalance: 5000 },
      })

      await callTool(client, {
        name: 'create_credit_card',
        args: { name: cardName, closingDay: 28, dueDay: 5, currency: 'BRL', paymentAccount: bankName },
      })

      // Make a purchase
      await callTool(client, {
        name: 'create_transaction',
        args: {
          description: `BillPay purchase ${stamp}`,
          amount: 300,
          type: 'expense',
          date: today,
          card: cardName,
          idempotencyKey: `billpay-purchase-${stamp}`,
        },
      })

      // Capture expenses before payment to prove the transfer doesn't inflate them
      const preSummary = (await callTool(client, {
        name: 'get_spending_summary',
        args: { month, year },
      })) as { currencies?: Array<{ currency?: string; expenses?: number }> }
      const preExpenses = preSummary.currencies?.find((s) => s.currency === 'BRL')?.expenses ?? 0

      // Pay the bill
      const paidBill = (await callTool(client, {
        name: 'pay_bill',
        args: { card: cardName, month, year },
      })) as { status?: string }
      expect(paidBill.status).toBe('paid')

      // Payer balance should be reduced
      const balances = (await callTool(client, {
        name: 'get_account_balances',
        args: {},
      })) as Array<{ name?: string; balance?: number }>

      const bank = balances.find((b) => b.name === bankName)
      expect(bank?.balance).toBe(4700) // 5000 - 300

      // Card account balance should be 0 (debt paid off)
      const cardAccount = balances.find((b) => b.name === `Card: ${cardName}`)
      expect(cardAccount?.balance).toBe(0) // -300 + 300 transfer in

      // Expenses unchanged after pay_bill — transfer is not counted as expense
      const postSummary = (await callTool(client, {
        name: 'get_spending_summary',
        args: { month, year },
      })) as { currencies?: Array<{ currency?: string; expenses?: number }> }
      const postExpenses = postSummary.currencies?.find((s) => s.currency === 'BRL')?.expenses ?? 0
      expect(postExpenses).toBe(preExpenses)

      // Idempotency: re-calling pay_bill on a paid bill is a no-op
      const idempotent = (await callTool(client, {
        name: 'pay_bill',
        args: { card: cardName, month, year },
      })) as { status?: string }
      expect(idempotent.status).toBe('paid')
    } finally {
      await transport.close()
    }
  })

  it('pay_bill without account and without card default returns validation error', async () => {
    const noDefaultCard = `NoDefault Card ${stamp}`
    const { client, transport } = makeClient()

    try {
      await client.connect(transport)

      await callTool(client, {
        name: 'create_credit_card',
        args: { name: noDefaultCard, closingDay: 28, dueDay: 5, currency: 'BRL' },
      })

      await callTool(client, {
        name: 'create_transaction',
        args: {
          description: `NoDefault purchase ${stamp}`,
          amount: 50,
          type: 'expense',
          date: today,
          card: noDefaultCard,
          idempotencyKey: `nodefault-purchase-${stamp}`,
        },
      })

      const err = (await callToolError(client, {
        name: 'pay_bill',
        args: { card: noDefaultCard, month, year },
      })) as { error?: { code?: string } }
      expect(err.error?.code).toBe('validation')
    } finally {
      await transport.close()
    }
  })

  it('pay_bill with currency mismatch returns validation error', async () => {
    const usdCard = `USD Card ${stamp}`
    const brlBank = `Mismatch Bank ${stamp}`
    const { client, transport } = makeClient()

    try {
      await client.connect(transport)

      await callTool(client, {
        name: 'create_account',
        args: { name: brlBank, type: 'checking', currency: 'BRL', initialBalance: 1000 },
      })

      await callTool(client, {
        name: 'create_credit_card',
        args: { name: usdCard, closingDay: 28, dueDay: 5, currency: 'USD' },
      })

      await callTool(client, {
        name: 'create_transaction',
        args: {
          description: `USD purchase ${stamp}`,
          amount: 25,
          type: 'expense',
          date: today,
          card: usdCard,
          idempotencyKey: `usd-purchase-${stamp}`,
        },
      })

      // Try to pay with a BRL account
      const err = (await callToolError(client, {
        name: 'pay_bill',
        args: { card: usdCard, month, year, account: brlBank },
      })) as { error?: { code?: string } }
      expect(err.error?.code).toBe('validation')
    } finally {
      await transport.close()
    }
  })

  it('delete_credit_card dry run returns counts, confirm deletes everything', async () => {
    const delCard = `Del Card ${stamp}`
    const delBank = `Del Bank ${stamp}`
    const { client, transport } = makeClient()

    try {
      await client.connect(transport)

      await callTool(client, {
        name: 'create_account',
        args: { name: delBank, type: 'checking', currency: 'BRL', initialBalance: 2000 },
      })

      await callTool(client, {
        name: 'create_credit_card',
        args: { name: delCard, closingDay: 28, dueDay: 5, currency: 'BRL', paymentAccount: delBank },
      })

      await callTool(client, {
        name: 'create_transaction',
        args: {
          description: `Del purchase ${stamp}`,
          amount: 100,
          type: 'expense',
          date: today,
          card: delCard,
          idempotencyKey: `del-purchase-${stamp}`,
        },
      })

      // Pay the bill (creates a transfer)
      await callTool(client, {
        name: 'pay_bill',
        args: { card: delCard, month, year },
      })

      // Dry run
      const dryRun = (await callTool(client, {
        name: 'delete_credit_card',
        args: { card: delCard },
      })) as { deleted?: boolean; dryRun?: boolean; wouldDelete?: { transactions?: number; bills?: number } }
      expect(dryRun.deleted).toBe(false)
      expect(dryRun.dryRun).toBe(true)
      expect(dryRun.wouldDelete?.transactions).toBeGreaterThanOrEqual(2) // purchase + payment
      expect(dryRun.wouldDelete?.bills).toBeGreaterThanOrEqual(1)

      // Confirm delete
      const deleted = (await callTool(client, {
        name: 'delete_credit_card',
        args: { card: delCard, confirm: true },
      })) as { deleted?: boolean; card?: string }
      expect(deleted.deleted).toBe(true)
      expect(deleted.card).toBe(delCard)

      // Card should be gone
      const err = (await callToolError(client, {
        name: 'delete_credit_card',
        args: { card: delCard },
      })) as { error?: { code?: string } }
      expect(err.error?.code).toBe('unknown_card')

      // Bank account balance should be restored (payment transfer removed)
      const balances = (await callTool(client, {
        name: 'get_account_balances',
        args: { account: delBank },
      })) as Array<{ balance?: number }>
      expect(balances[0]?.balance).toBe(2000) // back to initial
    } finally {
      await transport.close()
    }
  })
})
