import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { toIsoDate } from '../../../src/logic/period.js'
import { callTool, makeClient } from './helpers.js'

type CategoryTotal = { category: string; type: string; total: number; count: number }
type CurrencySummary = { currency: string; income: number; expenses: number; balance: number; byCategory: CategoryTotal[] }
type SpendingSummary = { period: { month: number; year: number }; currencies: CurrencySummary[] }

const now = new Date()
const month = now.getMonth() + 1
const year = now.getFullYear()
const date = toIsoDate(now)

describe('MCP integration > spending summary locale', () => {
  let client: Client
  let transport: StreamableHTTPClientTransport

  beforeAll(async () => {
    const c = makeClient()
    client = c.client
    transport = c.transport
    await client.connect(transport)

    await callTool(client, { name: 'set_locale', args: { locale: 'en', source: 'explicit' } })
    await callTool(client, { name: 'create_account', args: { name: 'Summary Locale Acct', currency: 'BRL' } })
    await callTool(client, { name: 'create_transaction', args: {
      description: 'Summary locale test',
      amount: 80,
      type: 'expense',
      date,
      account: 'Summary Locale Acct',
      category: 'Food',
      idempotencyKey: 'summary-locale-1',
    } })
    await callTool(client, { name: 'create_transaction', args: {
      description: 'Uncategorized item',
      amount: 15,
      type: 'expense',
      date,
      account: 'Summary Locale Acct',
      idempotencyKey: 'summary-locale-uncat-1',
    } })
  })

  afterAll(async () => {
    await callTool(client, { name: 'set_locale', args: { locale: 'en', source: 'explicit' } })
    await transport.close()
  })

  const getSummary = async (): Promise<SpendingSummary> =>
    await callTool(client, {
      name: 'get_spending_summary',
      args: { month, year },
    }) as SpendingSummary

  it('returns pt category names when locale is pt', async () => {
    await callTool(client, { name: 'set_locale', args: { locale: 'pt', source: 'explicit' } })
    const result = await getSummary()
    const brl = result.currencies.find((c) => c.currency === 'BRL')!
    const food = brl.byCategory.find((c) => c.category === 'Alimentação')
    expect(food).toBeDefined()
  })

  it('returns en category names when locale is en', async () => {
    await callTool(client, { name: 'set_locale', args: { locale: 'en', source: 'explicit' } })
    const result = await getSummary()
    const brl = result.currencies.find((c) => c.currency === 'BRL')!
    const food = brl.byCategory.find((c) => c.category === 'Food')
    expect(food).toBeDefined()
  })

  it('uncategorized bucket label follows locale', async () => {
    await callTool(client, { name: 'set_locale', args: { locale: 'pt', source: 'explicit' } })
    const pt = await getSummary()
    const brlPt = pt.currencies.find((c) => c.currency === 'BRL')!
    expect(brlPt.byCategory.some((c) => c.category === 'Sem categoria')).toBe(true)

    await callTool(client, { name: 'set_locale', args: { locale: 'en', source: 'explicit' } })
    const en = await getSummary()
    const brlEn = en.currencies.find((c) => c.currency === 'BRL')!
    expect(brlEn.byCategory.some((c) => c.category === 'Uncategorized')).toBe(true)

    await callTool(client, { name: 'set_locale', args: { locale: 'es', source: 'explicit' } })
    const es = await getSummary()
    const brlEs = es.currencies.find((c) => c.currency === 'BRL')!
    expect(brlEs.byCategory.some((c) => c.category === 'Sin categoría')).toBe(true)
  })

  it('per-currency totals unchanged across locales', async () => {
    await callTool(client, { name: 'set_locale', args: { locale: 'en', source: 'explicit' } })
    const en = await getSummary()
    await callTool(client, { name: 'set_locale', args: { locale: 'pt', source: 'explicit' } })
    const pt = await getSummary()

    const enBrl = en.currencies.find((c) => c.currency === 'BRL')!
    const ptBrl = pt.currencies.find((c) => c.currency === 'BRL')!
    expect(enBrl.income).toBe(ptBrl.income)
    expect(enBrl.expenses).toBe(ptBrl.expenses)
    expect(enBrl.balance).toBe(ptBrl.balance)
  })
})
