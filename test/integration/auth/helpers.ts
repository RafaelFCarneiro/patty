import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LightMyRequestResponse } from 'fastify';
import { afterEach } from 'vitest';
import type { AuthDeps } from '../../../src/controllers/deps.js';
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
  if (ctx.auth.mode !== 'required') throw new Error('auth is disabled in this app');
  return ctx.auth.deps;
};
