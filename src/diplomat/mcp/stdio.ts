import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Deps } from '../../controllers/deps.js'
import { buildMcpServer } from './server.js'

/** Thin diplomat: connects the transport-agnostic MCP server to a stdio transport. */
export const connectStdio = async (deps: Deps): Promise<McpServer> => {
  const server = buildMcpServer(deps)
  await server.connect(new StdioServerTransport())
  return server
}
