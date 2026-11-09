import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { isLoopbackHost, LOOPBACK_HOST } from './common/net.js';
import { AuthMode, DEFAULT_AUTH_MODE } from './models/auth/mode.js';
import { DEFAULT_PROFILE, ProfileSchema } from './models/auth/sign-in.js';
import { DEMO_DB_KEY, DEMO_ENV_ON, DEMO_ENV_VAR, DEMO_PORT } from './models/demo/core.js';
import { EncryptionKey } from './models/encryption-key.js';
import { Locale } from './models/locale.js';

export const McpTransport = z.enum(['stdio', 'http']);

// Absolute default so the DB is always created in a stable, writable location
// regardless of the cwd when spawned by an MCP client (e.g. Claude Desktop).
const DATA_DIRECTORY = join(homedir(), '.patty');
const DEFAULT_DB_PATH = join(DATA_DIRECTORY, 'patty.db');

const OS_LOCALE_VARIABLES = ['LC_ALL', 'LC_MESSAGES', 'LANG'] as const;

export const osLocale = (env: NodeJS.ProcessEnv = process.env): string | undefined =>
  OS_LOCALE_VARIABLES.map((name) => env[name]).find((value) => value) ?? Intl.DateTimeFormat().resolvedOptions().locale;

export const DEMO_DB_PATH = join(DATA_DIRECTORY, 'demo.db');

// One lock per OS user: the keychain entry it guards is per user, not per DB_PATH.
const DEFAULT_KEY_LOCK_PATH = join(DATA_DIRECTORY, 'db-key.lock');

// Deliberately NOT 3000/3001/8000/8080/etc — those are the most commonly used ports across
// Node/Fastify/React dev-server defaults, so picking one of them maximizes collision risk with
// other software on a typical dev machine. This value sits in IANA's dynamic/private range
// (49152-65535), which is never assigned to a registered service. This is the default for the
// published package; `npm run dev` overrides PORT back to the familiar 3001 (package.json), so
// a contributor's local dev instance never collides with an already-running installed instance.
const DEFAULT_PORT = 51737;

// `TRUST_PROXY=0` trusts zero proxy hops: no proxy.
const NO_PROXY_HOPS = 0;

/** Whether anything besides this machine can reach the instance: a non-loopback bind, or a reverse proxy
 *  configured in front of it (`PUBLIC_URL` names its external origin; `TRUST_PROXY` says to believe it). A
 *  proxy typically connects to a loopback bind, so `HOST` alone would call that instance private. Only used to
 *  refuse `PATTY_AUTH=disabled` on such an instance. */
export const isExposed = (env: {
  HOST: string;
  PUBLIC_URL?: string;
  TRUST_PROXY?: boolean | number | string;
}): boolean =>
  !isLoopbackHost(env.HOST) ||
  env.PUBLIC_URL !== undefined ||
  (env.TRUST_PROXY !== undefined && env.TRUST_PROXY !== false && env.TRUST_PROXY !== NO_PROXY_HOPS);

// An empty string (`PUBLIC_URL=` from a compose file or shell) means "unset", not "invalid".
const unsetWhenEmpty = (value: unknown): unknown => (value === '' ? undefined : value);
const optionalEnv = <T extends z.ZodTypeAny>(schema: T) => z.preprocess(unsetWhenEmpty, schema.optional());

// The external origin only — it is compared verbatim against the browser's `Origin` header (CSRF) and
// decides the cookie `Secure` flag, so a path or trailing slash would make both silently wrong.
const PublicUrl = z
  .string()
  .url()
  .refine((value) => /^https?:\/\//.test(value) && new URL(value).origin === value, {
    message: 'PUBLIC_URL must be an http(s) origin with no path or trailing slash, e.g. https://patty.example.com',
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
    // Unset: the demo's under PATTY_DEMO, so the demo never defaults to the real database.
    DB_PATH: z
      .string()
      .refine(isAbsolute, {
        message: `DB_PATH must be an absolute path — "~" is not expanded by Node. Use a full path, e.g. ${DEFAULT_DB_PATH}`,
      })
      .optional(),
    PATTY_DB_KEY: EncryptionKey.optional(),
    // File holding the key (e.g. a Docker secret at /run/secrets/patty_db_key) — keeps it out of
    // `docker inspect`, unlike the env var (ADR-032).
    PATTY_DB_KEY_FILE: z
      .string()
      .refine(isAbsolute, { message: 'PATTY_DB_KEY_FILE must be an absolute path' })
      .optional(),
    PATTY_LOCALE: Locale.optional(),
    PORT: z.coerce.number().default(DEFAULT_PORT),
    // Loopback by default: a wildcard bind is an explicit opt-in (a container needs it; ADR-032).
    HOST: z.string().min(1).default(LOOPBACK_HOST),
    // `required` everywhere, loopback included; `disabled` is an explicit, loopback-only opt-out.
    PATTY_AUTH: z.preprocess(unsetWhenEmpty, AuthMode.default(DEFAULT_AUTH_MODE)),
    // Which saved sign-in a stdio process uses, so two client configs on one machine can sign in as two users
    // (ADR-034 §2); and the headless alternative to the browser sign-in — a personal access token in the env.
    PATTY_PROFILE: z.preprocess(unsetWhenEmpty, ProfileSchema.default(DEFAULT_PROFILE)),
    PATTY_TOKEN: optionalEnv(z.string()),
    // External origin of this instance behind a reverse proxy — the CSRF expected origin, and https
    // turns on the cookie `Secure` flag. Optional in Phase 1 (OAuth makes it mandatory in Phase 3).
    PUBLIC_URL: optionalEnv(PublicUrl),
    // Passed to Fastify so rate limiting sees the real client IP behind a reverse proxy.
    TRUST_PROXY: optionalEnv(TrustProxy),
    [DEMO_ENV_VAR]: z
      .string()
      .optional()
      .transform((v) => v === DEMO_ENV_ON),
    MCP_TRANSPORT: McpTransport.default(McpTransport.enum.stdio),
    // HTTP sidecar alongside stdio MCP (ADR-013 Decision 7) — on by default: the dashboard/REST
    // surface is a core feature, not an add-on. A bind failure is caught and non-fatal (stdio
    // keeps working regardless) — that's a resilience fallback, not the normal state. Set
    // PATTY_HTTP=false to opt out and skip starting it entirely.
    PATTY_HTTP: z
      .string()
      .optional()
      .transform((v) => v !== 'false'),
    // Per-class staleness windows for currency_rates (ADR-026 Phase 2) — crypto moves fast enough to
    // need a much tighter window than fiat; both configurable rather than hardcoded in logic/.
    FIAT_RATE_STALE_HOURS: z.coerce.number().positive().default(24),
    CRYPTO_RATE_STALE_HOURS: z.coerce.number().positive().default(1),
  })
  .refine((env) => !(env.PATTY_DB_KEY && env.PATTY_DB_KEY_FILE), {
    path: ['PATTY_DB_KEY_FILE'],
    message: 'PATTY_DB_KEY and PATTY_DB_KEY_FILE are both set — the key source is ambiguous; set only one',
  })
  .refine((env) => !(env.PATTY_DEMO && (env.PATTY_DB_KEY || env.PATTY_DB_KEY_FILE)), {
    path: [DEMO_ENV_VAR],
    message: `${DEMO_ENV_VAR} fixes the database key — do not also set PATTY_DB_KEY or PATTY_DB_KEY_FILE`,
  })
  .transform((env) => ({
    ...env,
    DB_PATH: env.DB_PATH ?? (env.PATTY_DEMO ? DEMO_DB_PATH : DEFAULT_DB_PATH),
    KEY_LOCK_PATH: DEFAULT_KEY_LOCK_PATH,
  }))
  .transform((env) =>
    env.PATTY_DEMO ? { ...env, PATTY_DB_KEY: DEMO_DB_KEY, PATTY_AUTH: AuthMode.enum.disabled } : env,
  )
  .refine((env) => !(env.PATTY_AUTH === AuthMode.enum.disabled && isExposed(env)), {
    path: ['PATTY_AUTH'],
    message:
      'PATTY_AUTH=disabled is only allowed on a loopback HOST (127.0.0.0/8, ::1, localhost) with no PUBLIC_URL ' +
      'or TRUST_PROXY — the API would be unauthenticated to everyone who can reach it (directly or through a ' +
      'reverse proxy). Remove PATTY_AUTH (it defaults to required) or drop the exposure.',
  });

export type Config = z.infer<typeof Env>;

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => Env.parse(env);

/** Built from scratch, never from the process environment. */
export const demoConfig = (dbPath: string): Config =>
  loadConfig({
    DB_PATH: dbPath,
    PORT: String(DEMO_PORT),
    MCP_TRANSPORT: McpTransport.enum.http,
    [DEMO_ENV_VAR]: DEMO_ENV_ON,
  });
