import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Deps, RunEffects, RunEffectsSequence } from '../../controllers/deps.js';
import { buildMcpServer } from './server.js';
import type { ScopeGuardOptions } from './scopes.js';

/** Thin diplomat: connects the transport-agnostic MCP server to a stdio transport. `scopeGuard` says who the
 *  stdio channel acts as — its signed-in session (ADR-034), or the owner under an explicit `FINTRACK_AUTH=disabled`. */
export const connectStdio = async (
  deps: Deps,
  version: string,
  runEffects: RunEffects,
  runEffectsSequence: RunEffectsSequence,
  resetLocale: () => void,
  scopeGuard: ScopeGuardOptions,
): Promise<McpServer> => {
  const server = buildMcpServer(deps, version, runEffects, runEffectsSequence, resetLocale, scopeGuard);
  await server.connect(new StdioServerTransport());
  return server;
};
