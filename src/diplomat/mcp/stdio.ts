import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Deps, RunEffects } from '../../controllers/deps.js';
import { buildMcpServer } from './server.js';

/** Thin diplomat: connects the transport-agnostic MCP server to a stdio transport. */
export const connectStdio = async (deps: Deps, version: string, runEffects: RunEffects): Promise<McpServer> => {
  const server = buildMcpServer(deps, version, runEffects);
  await server.connect(new StdioServerTransport());
  return server;
};
