/// <reference types="node" />
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'

type JsonObject = Record<string, unknown>
export type ToolCallOptions = { name: string; args?: JsonObject }

export const mcpUrl = process.env.MCP_URL ?? 'http://127.0.0.1:3001/mcp'
export const preferredAccount = process.env.MCP_SMOKE_ACCOUNT

export function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

export const makeClient = () => {
  const client = new Client({ name: 'fintrack-vitest-integration', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl))
  return { client, transport }
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

export const callTool = async (client: Client, { name, args = {} }: ToolCallOptions): Promise<unknown> => {
  const result = await client.request(
    { method: 'tools/call', params: { name, arguments: args } },
    CallToolResultSchema,
  )
  const payload = parseToolPayload(name, result)
  const isError = Boolean((result as { isError?: boolean }).isError)
  if (isError) throw new Error(`Tool ${name} failed: ${JSON.stringify(payload)}`)
  return payload
}

export const deleteTransactions = async (ids: string[]): Promise<void> => {
  if (!ids.length) return
  const { client, transport } = makeClient()
  try {
    await client.connect(transport)
    for (const id of ids) {
      try {
        await callTool(client, { name: 'delete_transaction', args: { id, confirm: true } })
      } catch {
        // best-effort per transaction
      }
    }
  } catch {
    // best-effort overall
  } finally {
    await transport.close()
  }
}
