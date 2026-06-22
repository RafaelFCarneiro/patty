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

  beforeAll(async () => {
    const c = makeClient()
    client = c.client
    transport = c.transport
    await client.connect(transport)
    await callTool(client, { name: 'set_locale', args: { locale: 'en', source: 'explicit' } })
  })

  afterAll(async () => {
    await callTool(client, { name: 'set_locale', args: { locale: 'en', source: 'explicit' } })
    await transport.close()
  })

  it('list_accounts returns English typeLabel', async () => {
    const accounts = await callTool(client, { name: 'list_accounts' }) as Account[]
    expect(accounts.length).toBeGreaterThan(0)
    const checking = accounts.find((a) => a.type === 'checking')
    if (checking) expect(checking.typeLabel).toBe('Checking')
    const credit = accounts.find((a) => a.type === 'credit')
    if (credit) expect(credit.typeLabel).toBe('Credit card')
  })

  it('get_account_balances returns typeLabel', async () => {
    const balances = await callTool(client, { name: 'get_account_balances' }) as AccountBalance[]
    expect(balances.length).toBeGreaterThan(0)
    for (const b of balances) {
      expect(b.typeLabel).toBeTypeOf('string')
      expect(b.typeLabel).not.toBe('')
    }
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
    const txs = await callTool(client, { name: 'search_transactions', args: { limit: 5 } }) as TransactionView[]
    for (const tx of txs) {
      expect(tx.typeLabel).toBeTypeOf('string')
      expect(tx.statusLabel).toBeTypeOf('string')
    }
  })

  it('get_bill returns statusLabel on bill and labels on transactions', async () => {
    const cards = await callTool(client, { name: 'list_credit_cards' }) as Array<{ name: string }>
    if (cards.length === 0) return
    const now = new Date()
    const bill = await callTool(client, {
      name: 'get_bill',
      args: { card: cards[0].name, month: now.getMonth() + 1, year: now.getFullYear() },
    }).catch(() => null) as BillView | null
    if (!bill) return
    expect(bill.bill.statusLabel).toBeTypeOf('string')
    for (const tx of bill.transactions) {
      expect(tx.typeLabel).toBeTypeOf('string')
      expect(tx.statusLabel).toBeTypeOf('string')
    }
  })

  it('set_locale to pt switches all labels to Portuguese', async () => {
    await callTool(client, { name: 'set_locale', args: { locale: 'pt', source: 'explicit' } })

    const accounts = await callTool(client, { name: 'list_accounts' }) as Account[]
    const checking = accounts.find((a) => a.type === 'checking')
    expect(checking).toBeDefined()
    expect(checking?.typeLabel).toBe('Conta corrente')
    expect(checking?.type).toBe('checking')

    const categories = await callTool(client, { name: 'list_categories' }) as Category[]
    const expense = categories.find((c) => c.kind === 'expense')
    expect(expense).toBeDefined()
    expect(expense?.kindLabel).toBe('Despesa')
    expect(expense?.kind).toBe('expense')

    const txs = await callTool(client, { name: 'search_transactions', args: { limit: 1 } }) as TransactionView[]
    for (const tx of txs) {
      expect(tx.typeLabel).toBeTypeOf('string')
      expect(tx.statusLabel).toBeTypeOf('string')
    }
  })

  it('set_locale to es switches labels to Spanish', async () => {
    await callTool(client, { name: 'set_locale', args: { locale: 'es', source: 'explicit' } })

    const accounts = await callTool(client, { name: 'list_accounts' }) as Account[]
    const checking = accounts.find((a) => a.type === 'checking')
    if (checking) expect(checking.typeLabel).toBe('Cuenta corriente')

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
