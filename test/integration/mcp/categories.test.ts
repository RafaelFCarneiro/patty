import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { callTool, makeClient } from './helpers.js'

type Category = { id: string; name: string; kind: string; names: Record<string, string> | null }

describe('MCP integration > categories', () => {
  let client: Client
  let transport: StreamableHTTPClientTransport

  beforeAll(async () => {
    const c = makeClient()
    client = c.client
    transport = c.transport
    await client.connect(transport)
  })

  afterAll(async () => {
    await callTool(client, { name: 'set_locale', args: { locale: 'en', source: 'explicit' } })
    await transport.close()
  })

  it('list_categories returns results sorted by locale-resolved name', async () => {
    await callTool(client, { name: 'set_locale', args: { locale: 'pt', source: 'explicit' } })
    const categories = await callTool(client, { name: 'list_categories' }) as Category[]
    const names = categories.map((c) => c.name)
    const sorted = [...names].sort((a, b) => a.localeCompare(b, 'pt', { sensitivity: 'base' }))
    expect(names).toEqual(sorted)
  })
})
