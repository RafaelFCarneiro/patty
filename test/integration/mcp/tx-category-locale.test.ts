import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { callTool, makeClient } from './helpers.js'

type TxView = {
  categoryId: string
  categoryName: string
  subCategoryId?: string
  subCategoryName?: string
}
type SearchResult = TxView[]
type CreateResult = { transaction: TxView; created: boolean }
type Bill = { transactions: TxView[] }

describe('MCP integration > transaction category locale', () => {
  let client: Client
  let transport: StreamableHTTPClientTransport

  beforeAll(async () => {
    const c = makeClient()
    client = c.client
    transport = c.transport
    await client.connect(transport)

    await callTool(client, { name: 'set_locale', args: { locale: 'en', source: 'explicit' } })
    await callTool(client, { name: 'create_account', args: { name: 'Locale TX Test' } })
    await callTool(client, { name: 'create_transaction', args: {
      description: 'Groceries',
      amount: 50,
      type: 'expense',
      account: 'Locale TX Test',
      category: 'Food',
      idempotencyKey: 'tx-cat-locale-1',
    } })
  })

  afterAll(async () => {
    await callTool(client, { name: 'set_locale', args: { locale: 'en', source: 'explicit' } })
    await transport.close()
  })

  it('search_transactions returns pt categoryName when locale is pt', async () => {
    await callTool(client, { name: 'set_locale', args: { locale: 'pt', source: 'explicit' } })
    const result = await callTool(client, { name: 'search_transactions' }) as SearchResult
    const tx = result.find((t) => t.categoryId === 'cat-food')
    expect(tx).toBeDefined()
    expect(tx!.categoryName).toBe('Alimentação')
  })

  it('search_transactions returns en categoryName when locale is en', async () => {
    await callTool(client, { name: 'set_locale', args: { locale: 'en', source: 'explicit' } })
    const result = await callTool(client, { name: 'search_transactions' }) as SearchResult
    const tx = result.find((t) => t.categoryId === 'cat-food')
    expect(tx).toBeDefined()
    expect(tx!.categoryName).toBe('Food')
  })

  it('create_transaction returns localized categoryName', async () => {
    await callTool(client, { name: 'set_locale', args: { locale: 'es', source: 'explicit' } })
    const result = await callTool(client, { name: 'create_transaction', args: {
      description: 'Spanish food',
      amount: 30,
      type: 'expense',
      account: 'Locale TX Test',
      category: 'Food',
      idempotencyKey: 'tx-cat-locale-es-1',
    } }) as CreateResult
    expect(result.transaction.categoryName).toBe('Alimentación')
    expect(result.transaction.categoryId).toBe('cat-food')
  })

  it('user-created category shows literal name regardless of locale', async () => {
    await callTool(client, { name: 'create_category', args: { name: 'Custom Cat', kind: 'expense' } })
    await callTool(client, { name: 'set_locale', args: { locale: 'pt', source: 'explicit' } })
    const result = await callTool(client, { name: 'create_transaction', args: {
      description: 'Custom category tx',
      amount: 20,
      type: 'expense',
      account: 'Locale TX Test',
      category: 'Custom Cat',
      idempotencyKey: 'tx-cat-locale-custom-1',
    } }) as CreateResult
    expect(result.transaction.categoryName).toBe('Custom Cat')
  })

  it('locale with no translation falls back to canonical name', async () => {
    await callTool(client, { name: 'set_locale', args: { locale: 'en', source: 'explicit' } })
    const result = await callTool(client, { name: 'search_transactions' }) as SearchResult
    const tx = result.find((t) => t.categoryId === 'cat-food')
    expect(tx).toBeDefined()
    expect(tx!.categoryName).toBe('Food')
  })

  it('categoryId is stable across locale changes', async () => {
    await callTool(client, { name: 'set_locale', args: { locale: 'pt', source: 'explicit' } })
    const ptResult = await callTool(client, { name: 'search_transactions' }) as SearchResult
    await callTool(client, { name: 'set_locale', args: { locale: 'en', source: 'explicit' } })
    const enResult = await callTool(client, { name: 'search_transactions' }) as SearchResult

    const ptTx = ptResult.find((t) => t.categoryId === 'cat-food')
    const enTx = enResult.find((t) => t.categoryId === 'cat-food')
    expect(ptTx!.categoryId).toBe(enTx!.categoryId)
  })

  it('subcategory name is also localized', async () => {
    await callTool(client, { name: 'set_locale', args: { locale: 'en', source: 'explicit' } })
    const sub = await callTool(client, {
      name: 'create_sub_category',
      args: { name: 'Groceries', parentId: 'cat-food' },
    }) as { id: string; name: string }

    await callTool(client, { name: 'create_transaction', args: {
      description: 'Sub locale test',
      amount: 15,
      type: 'expense',
      account: 'Locale TX Test',
      subCategory: 'Groceries',
      idempotencyKey: 'tx-subcat-locale-1',
    } })

    const enResult = await callTool(client, { name: 'search_transactions', args: { text: 'Sub locale test' } }) as SearchResult
    expect(enResult[0].subCategoryId).toBe(sub.id)
    expect(enResult[0].subCategoryName).toBe('Groceries')
  })

  it('categoryNames map is not leaked to the client', async () => {
    const result = await callTool(client, { name: 'search_transactions' }) as SearchResult
    const tx = result[0]
    expect(tx).not.toHaveProperty('categoryNames')
    expect(tx).not.toHaveProperty('subCategoryNames')
  })
})
