import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { isLoopbackHost, LOOPBACK_HOST } from './common/net.js';
import { AuthMode } from './models/auth.js';
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

/** The database encryption key: 64 hex characters (32 bytes). Shared by every key source — the env
 *  var is decoded here, the key file's contents in `diplomat/db/driver.ts`. */
export const EncryptionKey = z.string().regex(/^[0-9a-f]{64}$/i, 'must be a 64-character hex string');

/** Auth default from the bind host (ADR-033 §1): loopback keeps today's zero-config behavior, anything
 *  reachable from elsewhere requires a session. */
export const defaultAuthMode = (host: string): AuthMode =>
  isLoopbackHost(host) ? AuthMode.enum.disabled : AuthMode.enum.required;

// An empty string (`PUBLIC_URL=` from a compose file or shell) means "unset", not "invalid".
const optionalEnv = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional());

// The external origin only — it is compared verbatim against the browser's `Origin` header (CSRF) and
// decides the cookie `Secure` flag, so a path or trailing slash would make both silently wrong.
const PublicUrl = z
  .string()
  .url()
  .refine((value) => /^https?:\/\//.test(value) && new URL(value).origin === value, {
    message: 'PUBLIC_URL must be an http(s) origin with no path or trailing slash, e.g. https://fintrack.example.com',
  });

// Fastify's `trustProxy`: `true`/`false`, a hop count, or a comma-separated list of trusted
// addresses/CIDRs. Anything else is passed through for Fastify (proxy-addr) to interpret.
const HOP_COUNT = /^\d+$/;
const TrustProxy = z
  .string()
  .min(1)
  .transform((value): boolean | number | string => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return HOP_COUNT.test(value) ? Number(value) : value;
  });

const Env = z
  .object({
    DB_PATH: z
      .string()
      .default(DEFAULT_DB_PATH)
      .refine(isAbsolute, {
        message: `DB_PATH must be an absolute path — "~" is not expanded by Node. Use a full path, e.g. ${DEFAULT_DB_PATH}`,
      }),
    FINTRACK_DB_KEY: EncryptionKey.optional(),
    // File holding the key (e.g. a Docker secret at /run/secrets/fintrack_db_key) — keeps it out of
    // `docker inspect`, unlike the env var (ADR-032).
    FINTRACK_DB_KEY_FILE: z
      .string()
      .refine(isAbsolute, { message: 'FINTRACK_DB_KEY_FILE must be an absolute path' })
      .optional(),
    FINTRACK_LOCALE: Locale.optional(),
    PORT: z.coerce.number().default(DEFAULT_PORT),
    // Bind host for the HTTP surface. Loopback by default: the API is unauthenticated (ADR-013), so
    // a wildcard bind is an explicit, visible opt-in (a container needs it; its port publish must stay
    // on the host's loopback — ADR-032).
    HOST: z.string().min(1).default(LOOPBACK_HOST),
    // `required` makes every HTTP route demand a session; default derived from HOST (ADR-033 §1).
    FINTRACK_AUTH: optionalEnv(AuthMode),
    // External origin of this instance behind a reverse proxy — the CSRF expected origin, and https
    // turns on the cookie `Secure` flag. Optional in Phase 1 (OAuth makes it mandatory in Phase 3).
    PUBLIC_URL: optionalEnv(PublicUrl),
    // Passed to Fastify so rate limiting sees the real client IP behind a reverse proxy.
    TRUST_PROXY: optionalEnv(TrustProxy),
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
  })
  .refine((env) => !(env.FINTRACK_DB_KEY && env.FINTRACK_DB_KEY_FILE), {
    path: ['FINTRACK_DB_KEY_FILE'],
    message: 'FINTRACK_DB_KEY and FINTRACK_DB_KEY_FILE are both set — the key source is ambiguous; set only one',
  })
  .refine((env) => !(env.FINTRACK_AUTH === AuthMode.enum.disabled && !isLoopbackHost(env.HOST)), {
    path: ['FINTRACK_AUTH'],
    message:
      'FINTRACK_AUTH=disabled is only allowed on a loopback HOST (127.0.0.0/8, ::1, localhost) — the API would be ' +
      'unauthenticated on a reachable interface. Remove FINTRACK_AUTH (it defaults to required here) or bind a loopback HOST.',
  })
  .transform((env) => ({ ...env, FINTRACK_AUTH: env.FINTRACK_AUTH ?? defaultAuthMode(env.HOST) }));

export type Config = z.infer<typeof Env>;

export const loadConfig = (): Config => Env.parse(process.env);
