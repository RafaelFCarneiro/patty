import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { Locale } from './models/locale.js';

export const McpTransport = z.enum(['stdio', 'http']);

// Absolute default so the DB is always created in a stable, writable location
// regardless of the cwd when spawned by an MCP client (e.g. Claude Desktop).
const DEFAULT_DB_PATH = join(homedir(), '.fintrack', 'fintrack.db');

// Deliberately NOT 3000/3001/8000/8080/etc — those are the most commonly used ports across
// Node/Fastify/React dev-server defaults, so picking one of them maximizes collision risk with
// other software on a typical dev machine. This value sits in IANA's dynamic/private range
// (49152-65535), which is never assigned to a registered service. This is the default for the
// published package; `npm run dev` overrides PORT back to the familiar 3001 (package.json), so
// a contributor's local dev instance never collides with an already-running installed instance.
const DEFAULT_PORT = 51737;

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
  PORT: z.coerce.number().default(DEFAULT_PORT),
  MCP_TRANSPORT: McpTransport.default(McpTransport.enum.stdio),
  // HTTP sidecar alongside stdio MCP (ADR-013 Decision 7) — on by default: the dashboard/REST
  // surface is a core feature, not an add-on. A bind failure is caught and non-fatal (stdio
  // keeps working regardless) — that's a resilience fallback, not the normal state. Set
  // FINTRACK_HTTP=false to opt out and skip starting it entirely.
  FINTRACK_HTTP: z
    .string()
    .optional()
    .transform((v) => v !== 'false'),
  // Per-class staleness windows for currency_rates (ADR-026 Phase 2) — crypto moves fast enough to
  // need a much tighter window than fiat; both configurable rather than hardcoded in logic/.
  FIAT_RATE_STALE_HOURS: z.coerce.number().positive().default(24),
  CRYPTO_RATE_STALE_HOURS: z.coerce.number().positive().default(1),
});

export type Config = z.infer<typeof Env>;

export const loadConfig = (): Config => Env.parse(process.env);
