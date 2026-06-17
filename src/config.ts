import { z } from 'zod'

export const McpTransport = z.enum(['stdio', 'http'])

const Env = z.object({
  DB_PATH: z.string().default('fintrack.db'),
  FINTRACK_DB_KEY: z.string().regex(/^[0-9a-f]{64}$/i, 'FINTRACK_DB_KEY must be a 64-character hex string').optional(),
  PORT: z.coerce.number().default(3001),
  MCP_TRANSPORT: McpTransport.default(McpTransport.enum.stdio),
})

export type Config = z.infer<typeof Env>

export const loadConfig = (): Config => Env.parse(process.env)
