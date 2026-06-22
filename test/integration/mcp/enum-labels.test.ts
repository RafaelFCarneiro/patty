import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { callTool, makeClient } from './helpers.js'

type Account = { id: string; name: string; type: string; typeLabel?: string }
type AccountBalance = Account & { balance: number }
type Category = { id: string; name: string; kind: string; kindLabel?: string }
type SubCategory = { id: string; name: string; kind: string; kindLabel?: string }
type RecurringRule = { id: string; period: string; periodLabel?: string }
type Bill = { id: string; status: string; statusLabel?: string }
type BillView = { bill: Bill; total: number; transactions: TransactionView[] }
type TransactionView = { id: string; type: string; typeLabel?: string; status: string; statusLabel?: string }

describe('MCP integration > localized enum labels', () => {
  let client: Client
  let transport: StreamableHTTPClientTransport
  const stamp = Date.now()
  const accountName = `LabelAcct ${stamp}`

  beforeAll(async () => {
    const c = makeClient()
    client = c.client
    transport = c.transport
    await client.connect(transport)
    await callTool(client, { name: 'set_locale', args: { locale: 'en', source: 'explicit' } })
    await callTool(client, {
      name: 'create_account',
      args: { name: accountName, type: 'checking', currency: 'BRL', initialBalance: 1000 },
    })
    await callTool(client, {
      name: 'create_transaction',
      args: {
        description: `Label seed ${stamp}`,
        amount: 10,
        type: 'expense',
        account: accountName,
        idempotencyKey: `label-seed-${stamp}`,
      },
    })
  })

  afterAll(async () => {
    await callTool(client, { name: 'set_locale', args: { locale: 'en', source: 'explicit' } })
    await transport.close()
  })

  it('list_accounts returns English typeLabel', async () => {
    const accounts = await callTool(client, { name: 'list_accounts' }) as Account[]
    const checking = accounts.find((a) => a.name === accountName)
    expect(checking).toBeDefined()
    expect(checking?.type).toBe('checking')
    expect(checking?.typeLabel).toBe('Checking')
  })

  it('get_account_balances returns typeLabel', async () => {
    const balances = await callTool(client, {
      name: 'get_account_balances',
      args: { account: accountName },
    }) as AccountBalance[]
    expect(balances).toHaveLength(1)
    expect(balances[0].typeLabel).toBe('Checking')
  })

  it('list_categories returns English kindLabel', async () => {
    const categories = await callTool(client, { name: 'list_categories' }) as Category[]
    expect(categories.length).toBeGreaterThan(0)
    const expense = categories.find((c) => c.kind === 'expense')
    expect(expense).toBeDefined()
    expect(expense?.kindLabel).toBe('Expense')
  })

  it('list_sub_categories returns kindLabel', async () => {
    const subs = await callTool(client, { name: 'list_sub_categories' }) as SubCategory[]
    if (subs.length > 0) {
      expect(subs[0].kindLabel).toBeTypeOf('string')
    }
  })

  it('list_recurring returns periodLabel', async () => {
    const rules = await callTool(client, { name: 'list_recurring' }) as RecurringRule[]
    for (const r of rules) {
      expect(r.periodLabel).toBeTypeOf('string')
    }
  })

  it('search_transactions returns typeLabel and statusLabel', async () => {
    const txs = await callTool(client, {
      name: 'search_transactions',
      args: { account: accountName, limit: 5 },
    }) as TransactionView[]
    expect(txs.length).toBeGreaterThan(0)
    for (const tx of txs) {
      expect(tx.typeLabel).toBeTypeOf('string')
      expect(tx.statusLabel).toBeTypeOf('string')
    }
  })

  it('get_bill returns statusLabel on bill and labels on transactions', async () => {
    const cardName = `LabelCard ${stamp}`
    const bankName = `LabelBank ${stamp}`
    const now = new Date()
    const month = now.getMonth() + 1
    const year = now.getFullYear()
    const today = now.toISOString().slice(0, 10)

    await callTool(client, {
      name: 'create_account',
      args: { name: bankName, type: 'checking', currency: 'BRL', initialBalance: 1000 },
    })
    await callTool(client, {
      name: 'create_credit_card',
      args: { name: cardName, closingDay: 28, dueDay: 28, currency: 'BRL', paymentAccount: bankName },
    })
    await callTool(client, {
      name: 'create_transaction',
      args: {
        description: `Label test ${stamp}`,
        amount: 50,
        type: 'expense',
        date: today,
        card: cardName,
        idempotencyKey: `label-bill-${stamp}`,
      },
    })

    const bill = await callTool(client, {
      name: 'get_bill',
      args: { card: cardName, month, year },
    }) as BillView

    expect(bill.bill.statusLabel).toBe('Open')
    expect(bill.transactions.length).toBeGreaterThan(0)
    for (const tx of bill.transactions) {
      expect(tx.typeLabel).toBeTypeOf('string')
      expect(tx.statusLabel).toBeTypeOf('string')
    }
  })

  it('set_locale to pt switches all labels to Portuguese', async () => {
    await callTool(client, { name: 'set_locale', args: { locale: 'pt', source: 'explicit' } })

    const accounts = await callTool(client, { name: 'list_accounts' }) as Account[]
    const checking = accounts.find((a) => a.name === accountName)
    expect(checking).toBeDefined()
    expect(checking?.typeLabel).toBe('Conta corrente')
    expect(checking?.type).toBe('checking')

    const categories = await callTool(client, { name: 'list_categories' }) as Category[]
    const expense = categories.find((c) => c.kind === 'expense')
    expect(expense).toBeDefined()
    expect(expense?.kindLabel).toBe('Despesa')
    expect(expense?.kind).toBe('expense')

    const txs = await callTool(client, {
      name: 'search_transactions',
      args: { account: accountName, limit: 1 },
    }) as TransactionView[]
    expect(txs.length).toBeGreaterThan(0)
    expect(txs[0].typeLabel).toBe('Despesa')
    expect(txs[0].statusLabel).toBe('Efetivada')
  })

  it('set_locale to es switches labels to Spanish', async () => {
    await callTool(client, { name: 'set_locale', args: { locale: 'es', source: 'explicit' } })

    const accounts = await callTool(client, { name: 'list_accounts' }) as Account[]
    const checking = accounts.find((a) => a.name === accountName)
    expect(checking).toBeDefined()
    expect(checking?.typeLabel).toBe('Cuenta corriente')

    const categories = await callTool(client, { name: 'list_categories' }) as Category[]
    const income = categories.find((c) => c.kind === 'income')
    expect(income).toBeDefined()
    expect(income?.kindLabel).toBe('Ingreso')
  })

  it('enum values remain unchanged across locale switches', async () => {
    await callTool(client, { name: 'set_locale', args: { locale: 'pt', source: 'explicit' } })
    const accounts = await callTool(client, { name: 'list_accounts' }) as Account[]
    for (const a of accounts) {
      expect(['checking', 'savings', 'wallet', 'investment', 'credit']).toContain(a.type)
    }
    const categories = await callTool(client, { name: 'list_categories' }) as Category[]
    for (const c of categories) {
      expect(['expense', 'income', 'both']).toContain(c.kind)
    }
  })

  it('reset locale to en for other test suites', async () => {
    await callTool(client, { name: 'set_locale', args: { locale: 'en', source: 'explicit' } })
  })
})
