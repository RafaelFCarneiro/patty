import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { okAsync } from 'neverthrow';
import Fastify, { type LightMyRequestResponse } from 'fastify';
import { afterEach } from 'vitest';
import type { AuthDeps, SignInServer, SignInStore } from '../../../src/controllers/deps.js';
import { loadConfig } from '../../../src/config.js';
import { createSignInInterpreter } from '../../../src/composition/sign-in/interpreter.js';
import { startSignInServer } from '../../../src/composition/sign-in/server.js';
import { bindAuthRunEffects } from '../../../src/composition/auth.js';
import { createStdioSession, type StdioSession } from '../../../src/diplomat/mcp/stdio-session.js';
import type { GateOutcome } from '../../../src/diplomat/mcp/gate.js';
import type { SignInDuration } from '../../../src/models/auth/grant.js';
import type { TokenAccess } from '../../../src/models/auth/token.js';
import { AuthMode } from '../../../src/models/auth/mode.js';
import { SESSION_COOKIE_NAME } from '../../../src/diplomat/http/cookies.js';
import { buildApp, type AppContext } from '../app-builder.js';

export const PASSWORD = 'correct horse battery staple';
export const USERNAME = 'Rafael';
/** Host + matching Origin a browser at the loopback port publish would send. */
export const LOOPBACK_HOST = '127.0.0.1:51737';
export const LOOPBACK_ORIGIN = `http://${LOOPBACK_HOST}`;

const SETUP_CODE_PATTERN = /[0-9A-Z]{4}(?:-[0-9A-Z]{4}){4}/;

/** The setup code a startup banner printed, as an operator would copy it from the log. */
export const codeFrom = (announced: readonly string[]): string => {
  const match = SETUP_CODE_PATTERN.exec(announced.join('\n'));
  if (!match) throw new Error(`no setup code in startup output: ${announced.join('\n')}`);
  return match[0];
};

export const formBody = (fields: Record<string, string>): string => new URLSearchParams(fields).toString();
export const FORM_HEADERS = { 'content-type': 'application/x-www-form-urlencoded' } as const;

/** `name=value` of the session cookie a response set — what a browser would send back. */
export const sessionCookieOf = (res: LightMyRequestResponse): string | undefined => {
  const header = res.headers['set-cookie'];
  const raw = Array.isArray(header) ? header[0] : header;
  return raw?.split(';')[0]?.startsWith(`${SESSION_COOKIE_NAME}=`) ? raw.split(';')[0] : undefined;
};

export const setCookieOf = (res: LightMyRequestResponse): string => {
  const header = res.headers['set-cookie'];
  return (Array.isArray(header) ? header[0] : header) ?? '';
};

/** One app (and one temp database) per test, closed afterwards — rate-limit state never leaks across tests. */
export const useAuthApp = () => {
  const dirs: string[] = [];
  const apps: AppContext[] = [];

  const create = async (opts?: Parameters<typeof buildApp>[0]): Promise<AppContext> => {
    const dir = mkdtempSync(join(tmpdir(), 'fintrack-auth-test-'));
    dirs.push(dir);
    const ctx = await buildApp({ dbPath: join(dir, 'test.db'), auth: {}, ...opts });
    apps.push(ctx);
    await ctx.app.ready();
    return ctx;
  };

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((ctx) => ctx.app.close()));
    dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
  });

  return create;
};

/** Claim the owner through `/ui/setup` exactly as a person would; returns the session cookie. */
export const claimOwner = async (ctx: AppContext): Promise<string> => {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/ui/setup',
    headers: { ...FORM_HEADERS, host: LOOPBACK_HOST, origin: LOOPBACK_ORIGIN },
    payload: formBody({ code: codeFrom(ctx.announced), username: USERNAME, password: PASSWORD }),
  });
  const cookie = sessionCookieOf(res);
  if (res.statusCode !== 303 || !cookie) throw new Error(`setup failed: ${res.statusCode} ${res.body}`);
  return cookie;
};

export const authDepsOf = (ctx: AppContext): AuthDeps => {
  if (ctx.auth.mode !== AuthMode.enum.required) throw new Error('auth is disabled in this app');
  return ctx.auth.deps;
};

export type RegisteredRoute = { method: string; url: string };

/** Every (method, url) Fastify actually registers for this app — captured by an `onRoute` listener attached
 *  BEFORE the routes exist, so a route added tomorrow in any module appears without anyone updating a list. */
export const registeredRoutes = async (ctx: AppContext): Promise<RegisteredRoute[]> => {
  const probe = Fastify();
  const routes: RegisteredRoute[] = [];
  probe.addHook('onRoute', (route) => {
    for (const method of [route.method].flat()) routes.push({ method, url: route.url });
  });
  ctx.registerOn(probe);
  await probe.ready();
  await probe.close();
  return routes;
};

/** A registered route pattern with its parameters filled in, so it can be requested. */
export const concreteUrl = (url: string): string => url.replace(/:[A-Za-z]+/g, 'x').replace('*', 'x');

/** What a browser at the loopback publish sends with a form POST: the matching Host and Origin, plus the session. */
export const browserHeaders = (cookie: string): Record<string, string> => ({
  ...FORM_HEADERS,
  host: LOOPBACK_HOST,
  origin: LOOPBACK_ORIGIN,
  cookie,
});

const SECRET_PATTERN = /data-testid="token-secret">(ftk_[A-Za-z0-9_-]+)</;

export type MintedToken = { token: string; id: string };

/** Mint a token as the person at `/ui/access/tokens` does; read the plaintext off the one page that shows it. */
export const mintToken = async (
  ctx: AppContext,
  cookie: string,
  fields: { name?: string; access?: 'read' | 'write'; expiry?: '30' | '90' | '365' } = {},
): Promise<MintedToken> => {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/ui/access/tokens',
    headers: browserHeaders(cookie),
    payload: formBody({
      password: PASSWORD,
      name: fields.name ?? 'test token',
      access: fields.access ?? 'write',
      expiry: fields.expiry ?? '90',
    }),
  });
  const token = SECRET_PATTERN.exec(res.body)?.[1];
  if (res.statusCode !== 200 || !token) throw new Error(`token creation failed: ${res.statusCode} ${res.body}`);
  const stored = await authDepsOf(ctx).accessTokens.findByTokenHash(authDepsOf(ctx).secrets.hashSecret(token));
  if (!stored) throw new Error('the minted token was not stored');
  return { token, id: stored.id };
};

export const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

export const MCP_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
} as const;
export const INITIALIZE_REQUEST = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
} as const;
export const toolCall = (name: string, args: Record<string, unknown> = {}, id = 2) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name, arguments: args },
});

/** A keychain stand-in that remembers what was saved and how it was used — no OS keychain is ever touched. */
export type MemoryStore = SignInStore & {
  readonly saved: () => string | null;
  readonly calls: { load: number; save: number; clear: number };
};

export const memoryStore = (initial: string | null = null, options: { refuseSave?: boolean } = {}): MemoryStore => {
  let saved = initial;
  const calls = { load: 0, save: 0, clear: 0 };
  return {
    saved: () => saved,
    calls,
    load: () => {
      calls.load += 1;
      return okAsync(saved);
    },
    save: async (token) => {
      calls.save += 1;
      if (options.refuseSave) return false;
      saved = token;
      return true;
    },
    clear: async () => {
      calls.clear += 1;
      saved = null;
    },
  };
};

export const SIGN_IN_ORIGIN = 'http://127.0.0.1:51737';
const USER_CODE_IN_MESSAGE = /code=([0-9A-Z]{4}-[0-9A-Z]{4})/;

/** The user code a not-signed-in message asks the person to confirm. */
export const userCodeIn = (outcome: GateOutcome): string => {
  const text = outcome.kind === 'not_signed_in' ? outcome.message : '';
  const code = USER_CODE_IN_MESSAGE.exec(text)?.[1];
  if (!code) throw new Error(`no sign-in code in: ${JSON.stringify(outcome)}`);
  return code;
};

/** The person at `/ui/connect`: opens the link's page, then posts their decision, as a browser would. */
export const answerConnect = (
  ctx: AppContext,
  cookie: string,
  code: string,
  decision: { decision: 'approve' | 'deny'; access?: TokenAccess; duration?: SignInDuration },
) =>
  ctx.app.inject({
    method: 'POST',
    url: '/ui/connect',
    headers: browserHeaders(cookie),
    payload: formBody({
      code,
      decision: decision.decision,
      access: decision.access ?? 'read',
      duration: decision.duration ?? '24h',
    }),
  });

export const approveConnect = async (
  ctx: AppContext,
  cookie: string,
  code: string,
  choice: { access?: TokenAccess; duration?: SignInDuration } = {},
) => {
  const res = await answerConnect(ctx, cookie, code, { decision: 'approve', ...choice });
  if (res.statusCode !== 200) throw new Error(`approval failed: ${res.statusCode} ${res.body}`);
};

/** A clock the test can push forward, to watch an expiry arrive. */
export const movableClock = () => {
  let offsetMs = 0;
  return { now: () => new Date(Date.now() + offsetMs), advance: (ms: number) => void (offsetMs += ms) };
};

export type SessionOptions = {
  envToken?: string;
  store?: MemoryStore;
  origin?: string | null;
  clock?: () => Date;
  clientInfo?: unknown;
  run?: ReturnType<typeof bindAuthRunEffects>;
  temporaryServer?: () => Promise<SignInServer>;
};

/** A stdio session wired to the test app's database, with an in-memory keychain and (optionally) a movable clock. */
export const stdioSessionFor = (
  ctx: AppContext,
  options: SessionOptions = {},
): { session: StdioSession; store: MemoryStore } => {
  const store = options.store ?? memoryStore();
  const base = authDepsOf(ctx);
  const signIn = createSignInInterpreter({
    deps: { ...base, clock: options.clock ?? base.clock },
    run: options.run ?? bindAuthRunEffects(ctx.authRunEffects),
    store,
    origin: () => (options.origin === undefined ? SIGN_IN_ORIGIN : options.origin),
    startPage: options.temporaryServer,
  });
  const session = createStdioSession({
    signIn,
    profile: 'default',
    envToken: options.envToken,
    clientInfo: () => options.clientInfo ?? { name: 'Claude Desktop', version: '1.0.0' },
  });
  return { session, store };
};

/** The real temporary sign-in server on the test app's own database, counted: how many started and closed. */
export const countedTemporaryServer = (ctx: AppContext) => {
  const counts = { started: 0, closed: 0 };
  const origins: string[] = [];
  const start = async (): Promise<SignInServer> => {
    const env = { ...process.env, DB_PATH: '/tmp/fintrack-never-opened.db', FINTRACK_DB_KEY: 'c'.repeat(64) };
    const server = await startSignInServer({ ...loadConfig(env), PUBLIC_URL: undefined }, ctx.db);
    counts.started += 1;
    origins.push(server.origin);
    return {
      origin: server.origin,
      close: async () => {
        counts.closed += 1;
        await server.close();
      },
    };
  };
  return { start, counts, origins };
};

/** A browser at `origin`: log in as the owner, then answer a pending request — over real HTTP, like a person would. */
export const answerAt = async (
  origin: string,
  code: string,
  decision: { decision: 'approve' | 'deny'; access?: TokenAccess; duration?: SignInDuration },
): Promise<number> => {
  const headers = { 'content-type': 'application/x-www-form-urlencoded', origin };
  const login = await fetch(`${origin}/ui/login`, {
    method: 'POST',
    redirect: 'manual',
    headers,
    body: formBody({ username: USERNAME, password: PASSWORD }),
  });
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  if (login.status !== 303 || !cookie) throw new Error(`login at ${origin} failed: ${login.status}`);
  const answered = await fetch(`${origin}/ui/connect`, {
    method: 'POST',
    headers: { ...headers, cookie },
    body: formBody({
      code,
      decision: decision.decision,
      access: decision.access ?? 'read',
      duration: decision.duration ?? '24h',
    }),
  });
  return answered.status;
};
