import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { callTool, makeClient } from './helpers.js'

type AggRow = { key: string; label: string; value: number; count: number; pct: number }
type CurrencyBlock = { currency: string; total: number; rows: AggRow[] }
type AggResult = { groupBy: string; metric: string; currencies: CurrencyBlock[] }

const month = 3
const year = 2025
const date = '2025-03-15'
const prevMonth = '2025-02-15'

describe('MCP integration > aggregate_spending', () => {
  let client: Client
  let transport: StreamableHTTPClientTransport

  beforeAll(async () => {
    const c = makeClient()
    client = c.client
    transport = c.transport
    await client.connect(transport)

    await callTool(client, { name: 'set_locale', args: { locale: 'en', source: 'explicit' } })
    await callTool(client, { name: 'create_account', args: { name: 'AggAcctBRL', currency: 'BRL' } })
    await callTool(client, { name: 'create_account', args: { name: 'AggAcctBRL2', currency: 'BRL' } })
    await callTool(client, { name: 'create_account', args: { name: 'AggAcctUSD', currency: 'USD' } })
    await callTool(client, { name: 'create_tag', args: { name: 'agg-work' } })
    await callTool(client, { name: 'create_tag', args: { name: 'agg-travel' } })

    // (a) category grouping: two expenses in BRL, one in USD
    await callTool(client, { name: 'create_transaction', args: {
      description: 'Agg grocery', amount: 200, type: 'expense', date,
      account: 'AggAcctBRL', category: 'Food', idempotencyKey: 'agg-1',
    } })
    await callTool(client, { name: 'create_transaction', args: {
      description: 'Agg bus', amount: 50, type: 'expense', date,
      account: 'AggAcctBRL', category: 'Transport', idempotencyKey: 'agg-2',
    } })
    await callTool(client, { name: 'create_transaction', args: {
      description: 'Agg usd sub', amount: 15, type: 'expense', date,
      account: 'AggAcctUSD', category: 'Subscriptions', idempotencyKey: 'agg-3',
    } })

    // (c) transfer — must be excluded
    await callTool(client, { name: 'create_transfer', args: {
      from: 'AggAcctBRL', to: 'AggAcctBRL2', amount: 100,
      date, idempotencyKey: 'agg-transfer-1',
    } })

    // (c) pending — must be excluded
    await callTool(client, { name: 'create_transaction', args: {
      description: 'Agg pending', amount: 999, type: 'expense', date,
      account: 'AggAcctBRL', category: 'Food', status: 'pending',
      idempotencyKey: 'agg-pending-1',
    } })

    // (d) multi-tag transaction
    await callTool(client, { name: 'create_transaction', args: {
      description: 'Agg tagged', amount: 30, type: 'expense', date,
      account: 'AggAcctBRL', category: 'Transport',
      tags: ['agg-work', 'agg-travel'],
      idempotencyKey: 'agg-tag-1',
    } })

    // (e) previous month for time series
    await callTool(client, { name: 'create_transaction', args: {
      description: 'Agg prev month', amount: 75, type: 'expense', date: prevMonth,
      account: 'AggAcctBRL', category: 'Food', idempotencyKey: 'agg-prev-1',
    } })
  })

  afterAll(async () => {
    await callTool(client, { name: 'set_locale', args: { locale: 'en', source: 'explicit' } })
    await transport.close()
  })

  // (a) groupBy: category sums per currency with locale-resolved labels
  it('groups by category with correct sums and labels', async () => {
    const result = await callTool(client, {
      name: 'aggregate_spending',
      args: { groupBy: 'category', month, year, account: 'AggAcctBRL' },
    }) as AggResult
    expect(result.groupBy).toBe('category')
    expect(result.metric).toBe('sum')

    const brl = result.currencies.find((c) => c.currency === 'BRL')!
    expect(brl).toBeDefined()
    const foodRow = brl.rows.find((r) => r.label === 'Food')!
    expect(foodRow.value).toBe(200)
    const transportRow = brl.rows.find((r) => r.label === 'Transport')!
    expect(transportRow).toBeDefined()
  })

  // (b) type/account filter narrows results
  it('filters by account', async () => {
    const result = await callTool(client, {
      name: 'aggregate_spending',
      args: { groupBy: 'category', month, year, account: 'AggAcctUSD' },
    }) as AggResult
    expect(result.currencies).toHaveLength(1)
    expect(result.currencies[0]!.currency).toBe('USD')
  })

  // (c) transfers excluded and pending excluded
  it('excludes transfers and pending', async () => {
    const result = await callTool(client, {
      name: 'aggregate_spending',
      args: { groupBy: 'category', month, year, account: 'AggAcctBRL' },
    }) as AggResult
    const brl = result.currencies.find((c) => c.currency === 'BRL')!
    const totalAmount = brl.rows.reduce((sum, r) => sum + r.value, 0)
    // 200 (food) + 50 (transport) + 30 (tagged transport) = 280
    // pending 999 and transfer 100 excluded
    expect(totalAmount).toBe(280)
  })

  // (d) tag multi-counts
  it('groups by tag — multi-tagged transaction appears in both groups', async () => {
    const result = await callTool(client, {
      name: 'aggregate_spending',
      args: { groupBy: 'tag', month, year, account: 'AggAcctBRL' },
    }) as AggResult
    const brl = result.currencies.find((c) => c.currency === 'BRL')!
    const workRow = brl.rows.find((r) => r.label === 'agg-work')
    const travelRow = brl.rows.find((r) => r.label === 'agg-travel')
    expect(workRow).toBeDefined()
    expect(travelRow).toBeDefined()
    expect(workRow!.value).toBe(30)
    expect(travelRow!.value).toBe(30)
  })

  // (e) month time series over from/to range
  it('groups by month over date range', async () => {
    const fromDate = prevMonth
    const toDate = '2025-04-01'
    const result = await callTool(client, {
      name: 'aggregate_spending',
      args: { groupBy: 'month', from: fromDate, to: toDate, account: 'AggAcctBRL', sort: 'asc' },
    }) as AggResult
    const brl = result.currencies.find((c) => c.currency === 'BRL')!
    expect(brl.rows.length).toBeGreaterThanOrEqual(2)
    const months = brl.rows.map((r) => r.key)
    expect(months[0]! < months[months.length - 1]!).toBe(true)
  })

  // (f) limit top-N per currency (not global)
  it('limits results per currency, not globally', async () => {
    const result = await callTool(client, {
      name: 'aggregate_spending',
      args: { groupBy: 'category', month, year, limit: 1 },
    }) as AggResult
    // Both BRL and USD currencies should be present (not truncated by a global limit)
    const brl = result.currencies.find((c) => c.currency === 'BRL')
    const usd = result.currencies.find((c) => c.currency === 'USD')
    expect(brl).toBeDefined()
    expect(usd).toBeDefined()
    // Each currency block limited to 1 row
    expect(brl!.rows).toHaveLength(1)
    expect(usd!.rows).toHaveLength(1)
  })

  // (g) invalid groupBy rejected at boundary (zod or MCP SDK rejects before handler)
  it('rejects invalid groupBy', async () => {
    await expect(
      callTool(client, {
        name: 'aggregate_spending',
        args: { groupBy: 'invalid_dimension', month, year },
      }),
    ).rejects.toThrow()
  })

  // (h) locale: pt labels
  it('returns pt category labels after set_locale', async () => {
    await callTool(client, { name: 'set_locale', args: { locale: 'pt', source: 'explicit' } })
    const result = await callTool(client, {
      name: 'aggregate_spending',
      args: { groupBy: 'category', month, year, account: 'AggAcctBRL' },
    }) as AggResult
    const brl = result.currencies.find((c) => c.currency === 'BRL')!
    const foodRow = brl.rows.find((r) => r.key != null && r.label === 'Alimentação')
    expect(foodRow).toBeDefined()

    // restore
    await callTool(client, { name: 'set_locale', args: { locale: 'en', source: 'explicit' } })
  })
})
