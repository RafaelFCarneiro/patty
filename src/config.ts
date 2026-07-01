import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { Locale } from './models/locale.js';

export const McpTransport = z.enum(['stdio', 'http']);

// Absolute default so the DB is always created in a stable, writable location
// regardless of the cwd when spawned by an MCP client (e.g. Claude Desktop).
const DEFAULT_DB_PATH = join(homedir(), '.fintrack', 'fintrack.db');

const Env = z.object({
  DB_PATH: z
    .string()
    .default(DEFAULT_DB_PATH)
    .refine(isAbsolute, {
      message: `DB_PATH must be an absolute path — "~" is not expanded by Node. Use a full path, e.g. ${DEFAULT_DB_PATH}`,
    }),
  FINTRACK_DB_KEY: z
    .string()
    .regex(/^[0-9a-f]{64}$/i, 'FINTRACK_DB_KEY must be a 64-character hex string')
    .optional(),
  FINTRACK_LOCALE: Locale.optional(),
  PORT: z.coerce.number().default(3001),
  MCP_TRANSPORT: McpTransport.default(McpTransport.enum.stdio),
});

export type Config = z.infer<typeof Env>;

export const loadConfig = (): Config => Env.parse(process.env);
