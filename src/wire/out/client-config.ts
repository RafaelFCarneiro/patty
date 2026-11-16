import { z } from 'zod';

export const ServersKey = z.enum(['mcpServers', 'servers']);
export type ServersKey = z.infer<typeof ServersKey>;

/** Where a client's MCP entry keeps its environment variables. */
export const EnvKey = z.enum(['env', 'environment']);
export type EnvKey = z.infer<typeof EnvKey>;

/** What an OpenCode config's `mcp` key says about its layout. */
export const McpLayout = z.enum([
  /** No `mcp` key, or an empty one: the V2 shape is created. */
  'fresh',
  'v2',
  /** Servers directly under `mcp`, no `mcp.servers`. */
  'v1',
  /** `mcp` or `mcp.servers` exists but is not an object. */
  'malformed',
]);
export type McpLayout = z.infer<typeof McpLayout>;
