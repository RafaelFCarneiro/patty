import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { callTool, callToolError, makeClient } from './helpers.js'

type Category = { id: string; name: string; kind: string; names: Record<string, string> | null }
type Preferences = { locale: string; localeSource: string }

describe('MCP integration > i18n', () => {
  let client: Client
  let transport: StreamableHTTPClientTransport

  beforeAll(async () => {
    const c = makeClient()
    client = c.client
    transport = c.transport
    await client.connect(transport)
  })

  afterAll(async () => {
    await transport.close()
  })

  it('fresh DB has English default IDs with names set', async () => {
    const categories = await callTool(client, { name: 'list_categories' }) as Category[]
    const food = categories.find((c) => c.id === 'cat-food')
    expect(food).toBeDefined()
    expect(food!.name).toBe('Food')
    expect(food!.names).toBeDefined()
    expect(food!.names!.pt).toBe('Alimentação')
  })

  it('default locale is en', async () => {
    const prefs = await callTool(client, { name: 'get_preferences' }) as Preferences
    expect(prefs.locale).toBe('en')
    expect(prefs.localeSource).toBe('default')
  })

  it('set_locale to es switches category names to Spanish', async () => {
    await callTool(client, { name: 'set_locale', args: { locale: 'es', source: 'inferred' } })
    const categories = await callTool(client, { name: 'list_categories' }) as Category[]
    const food = categories.find((c) => c.id === 'cat-food')
    expect(food!.name).toBe('Alimentación')
    expect(food!.id).toBe('cat-food')
  })

  it('set_locale to pt shows Portuguese names', async () => {
    await callTool(client, { name: 'set_locale', args: { locale: 'pt', source: 'inferred' } })
    const categories = await callTool(client, { name: 'list_categories' }) as Category[]
    const food = categories.find((c) => c.id === 'cat-food')
    expect(food!.name).toBe('Alimentação')
  })

  it('user-created category shows literal name regardless of locale', async () => {
    await callTool(client, { name: 'set_locale', args: { locale: 'pt', source: 'inferred' } })
    await callTool(client, { name: 'create_category', args: { name: 'My Custom', kind: 'expense' } })
    const categories = await callTool(client, { name: 'list_categories' }) as Category[]
    const custom = categories.find((c) => c.name === 'My Custom')
    expect(custom).toBeDefined()
    expect(custom!.names).toBeNull()
  })

  it('resolveByName resolves by active-locale name', async () => {
    await callTool(client, { name: 'set_locale', args: { locale: 'pt', source: 'inferred' } })
    await callTool(client, { name: 'create_account', args: { name: 'Test i18n' } })
    const tx = await callTool(client, {
      name: 'create_transaction',
      args: {
        description: 'Test',
        amount: 10,
        type: 'expense',
        account: 'Test i18n',
        category: 'Alimentação',
        idempotencyKey: 'i18n-resolve-pt-1',
      },
    })
    expect((tx as { transaction: { categoryId: string } }).transaction.categoryId).toBe('cat-food')
  })

  it('resolveByName resolves by cross-locale synonym', async () => {
    await callTool(client, { name: 'set_locale', args: { locale: 'pt', source: 'inferred' } })
    const tx = await callTool(client, {
      name: 'create_transaction',
      args: {
        description: 'Test cross',
        amount: 10,
        type: 'expense',
        account: 'Test i18n',
        category: 'Food',
        idempotencyKey: 'i18n-resolve-cross-1',
      },
    })
    expect((tx as { transaction: { categoryId: string } }).transaction.categoryId).toBe('cat-food')
  })

  it('explicit locale is not auto-overwritten by inferred', async () => {
    await callTool(client, { name: 'set_locale', args: { locale: 'en', source: 'explicit' } })
    const error = await callToolError(client, { name: 'set_locale', args: { locale: 'es', source: 'inferred' } })
    expect(error).toBeDefined()
    const prefs = await callTool(client, { name: 'get_preferences' }) as Preferences
    expect(prefs.locale).toBe('en')
  })

  it('explicit locale can be overwritten by another explicit', async () => {
    await callTool(client, { name: 'set_locale', args: { locale: 'es', source: 'explicit' } })
    const prefs = await callTool(client, { name: 'get_preferences' }) as Preferences
    expect(prefs.locale).toBe('es')
  })

  it('pt description classifies via multilingual merchant rules', async () => {
    await callTool(client, { name: 'set_locale', args: { locale: 'en', source: 'explicit' } })
    const tx = await callTool(client, {
      name: 'create_transaction',
      args: {
        description: 'FARMÁCIA SÃO JOÃO',
        amount: 35,
        type: 'expense',
        account: 'Test i18n',
        idempotencyKey: 'i18n-classify-pt-1',
      },
    }) as { transaction: { categoryId: string }; classification: { method: string } }
    expect(tx.transaction.categoryId).toBe('cat-health')
    expect(tx.classification.method).toBe('rule')
  })

  it('es description classifies via multilingual merchant rules', async () => {
    const tx = await callTool(client, {
      name: 'create_transaction',
      args: {
        description: 'GASOLINERA REPSOL',
        amount: 50,
        type: 'expense',
        account: 'Test i18n',
        idempotencyKey: 'i18n-classify-es-1',
      },
    }) as { transaction: { categoryId: string }; classification: { method: string } }
    expect(tx.transaction.categoryId).toBe('cat-transport')
    expect(tx.classification.method).toBe('rule')
  })

  it('list_categories returns results sorted by locale-resolved name', async () => {
    await callTool(client, { name: 'set_locale', args: { locale: 'pt', source: 'explicit' } })
    const categories = await callTool(client, { name: 'list_categories' }) as Category[]
    const names = categories.map((c) => c.name)
    const sorted = [...names].sort((a, b) => a.localeCompare(b, 'pt', { sensitivity: 'base' }))
    expect(names).toEqual(sorted)
  })

  it('reset locale to en for other test suites', async () => {
    await callTool(client, { name: 'set_locale', args: { locale: 'en', source: 'explicit' } })
    const categories = await callTool(client, { name: 'list_categories' }) as Category[]
    const food = categories.find((c) => c.id === 'cat-food')
    expect(food!.name).toBe('Food')
  })
})
