/// <reference types="node" />
import { afterEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { CallToolResultSchema, ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js'

type JsonObject = Record<string, unknown>

type ToolCallOptions = {
  name: string
  args?: JsonObject
}

const describeIf = describe
const mcpUrl = process.env.MCP_URL ?? 'http://127.0.0.1:3001/mcp'
const preferredAccount = process.env.MCP_SMOKE_ACCOUNT

function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const parseToolPayload = (toolName: string, result: unknown): unknown => {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content
  const text = content?.find((item) => item.type === 'text')?.text

  ensure(text, `Tool ${toolName} returned no text payload`)

  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`Tool ${toolName} returned invalid JSON payload: ${String(error)}`)
  }
}

const callTool = async (client: Client, { name, args = {} }: ToolCallOptions): Promise<unknown> => {
  const result = await client.request(
    {
      method: 'tools/call',
      params: { name, arguments: args },
    },
    CallToolResultSchema,
  )

  const payload = parseToolPayload(name, result)
  const isError = Boolean((result as { isError?: boolean }).isError)
  if (isError) throw new Error(`Tool ${name} failed: ${JSON.stringify(payload)}`)

  return payload
}

describeIf('MCP integration', () => {
  let createdTxId: string | null = null

  afterEach(async () => {
    if (!createdTxId) return

    const client = new Client({ name: 'fintrack-vitest-cleanup', version: '1.0.0' })
    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl))

    try {
      await client.connect(transport)
      await callTool(client, { name: 'delete_transaction', args: { id: createdTxId, confirm: true } })
    } catch {
      // Best-effort cleanup for isolation between test runs.
    } finally {
      createdTxId = null
      await transport.close()
    }
  })

  it(
    'executes a full create/search/update/delete transaction flow through MCP endpoint',
    async () => {
      const stamp = Date.now()
      const txDescription = `INTEGRATION MCP ${stamp}`
      const txDescriptionUpdated = `${txDescription} UPDATED`
      const txKey = `integration-mcp-${stamp}-0.01`
      const today = new Date().toISOString().slice(0, 10)

      const client = new Client({ name: 'fintrack-vitest-integration', version: '1.0.0' })
      const transport = new StreamableHTTPClientTransport(new URL(mcpUrl))

      try {
        await client.connect(transport)

        const toolsResult = await client.request({ method: 'tools/list', params: {} }, ListToolsResultSchema)
        const toolNames = new Set(toolsResult.tools.map((t) => t.name))

        expect(toolNames.has('create_transaction')).toBe(true)
        expect(toolNames.has('search_transactions')).toBe(true)
        expect(toolNames.has('update_transaction')).toBe(true)
        expect(toolNames.has('delete_transaction')).toBe(true)

        const accounts = (await callTool(client, { name: 'list_accounts' })) as Array<{ name: string }>
        const accountName = preferredAccount ?? accounts[0]?.name
        ensure(accountName, 'No account available for integration test')

        const created = (await callTool(client, {
          name: 'create_transaction',
          args: {
            description: txDescription,
            amount: 0.01,
            type: 'expense',
            date: today,
            account: accountName,
            category: 'Outros',
            idempotencyKey: txKey,
          },
        })) as { transaction?: { id?: string }; created?: boolean }

        createdTxId = created.transaction?.id ?? null
        expect(created.created).toBe(true)
        expect(createdTxId).toBeTruthy()

        const found = (await callTool(client, {
          name: 'search_transactions',
          args: { text: txDescription, limit: 10 },
        })) as Array<{ id?: string }>

        expect(found.some((tx) => tx.id === createdTxId)).toBe(true)

        const updated = (await callTool(client, {
          name: 'update_transaction',
          args: { id: createdTxId, description: txDescriptionUpdated },
        })) as { description?: string }

        expect(updated.description).toBe(txDescriptionUpdated)

        const dryRun = (await callTool(client, {
          name: 'delete_transaction',
          args: { id: createdTxId },
        })) as { dryRun?: boolean; deleted?: boolean }

        expect(dryRun.dryRun).toBe(true)
        expect(dryRun.deleted).toBe(false)

        const deletedId = createdTxId
        const deleted = (await callTool(client, {
          name: 'delete_transaction',
          args: { id: createdTxId, confirm: true },
        })) as { deleted?: boolean }

        expect(deleted.deleted).toBe(true)
        createdTxId = null

        const afterDelete = (await callTool(client, {
          name: 'search_transactions',
          args: { text: txDescriptionUpdated, limit: 10 },
        })) as Array<{ id?: string }>

        expect(afterDelete.some((tx) => tx.id === deletedId)).toBe(false)
      } finally {
        await transport.close()
      }
    },
    30_000,
  )
})
