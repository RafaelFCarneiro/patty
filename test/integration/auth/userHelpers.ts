import { sql } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import type { AppContext } from '../app-builder.js';
import {
  browserHeaders,
  FORM_HEADERS,
  formBody,
  LOOPBACK_HOST,
  LOOPBACK_ORIGIN,
  mintToken,
  PASSWORD,
  sessionCookieOf,
  type MintedToken,
} from './helpers.js';

/** The password every invited person chooses in these tests (the same passphrase as the owner's, so the shared helpers
 *  that re-type "the" password for a token or a step-up work for them too). */
export const MEMBER_PASSWORD = PASSWORD;

const INVITE_CODE = /data-testid="invite-code">([0-9A-Z-]+)</;
const INVITE_LINK = /data-testid="invite-link">([^<]+)</;

export const USERS_URL = '/ui/access/users';

/** A form POST as a signed-in browser at the loopback publish sends it. */
export const post = (ctx: AppContext, cookie: string, url: string, fields: Record<string, string>) =>
  ctx.app.inject({ method: 'POST', url, headers: browserHeaders(cookie), payload: formBody(fields) });

export const get = (ctx: AppContext, cookie: string, url: string) =>
  ctx.app.inject({ method: 'GET', url, headers: { host: LOOPBACK_HOST, cookie } });

export type Invited = { res: LightMyRequestResponse; code: string; link: string | undefined };

/** The admin at `/ui/access/users`: invite someone. `code` is read off the one page that shows it. */
export const invite = async (
  ctx: AppContext,
  adminCookie: string,
  fields: { username: string; role?: 'admin' | 'member'; password?: string },
): Promise<Invited> => {
  const res = await post(ctx, adminCookie, USERS_URL, {
    username: fields.username,
    role: fields.role ?? 'member',
    password: fields.password ?? PASSWORD,
  });
  return { res, code: INVITE_CODE.exec(res.body)?.[1] ?? '', link: INVITE_LINK.exec(res.body)?.[1] };
};

/** An invite that must have worked: the code a person would be handed. */
export const mustInvite = async (
  ctx: AppContext,
  adminCookie: string,
  fields: { username: string; role?: 'admin' | 'member' },
): Promise<string> => {
  const { res, code } = await invite(ctx, adminCookie, fields);
  if (res.statusCode !== 200 || code === '') throw new Error(`invite failed: ${res.statusCode} ${res.body}`);
  return code;
};

/** The invited person at `/ui/invite`, not signed in: a public page, so no cookie — just the browser's Host/Origin. */
export const claim = (
  ctx: AppContext,
  code: string,
  password = MEMBER_PASSWORD,
  headers: Record<string, string> = {},
) =>
  ctx.app.inject({
    method: 'POST',
    url: '/ui/invite',
    headers: { ...FORM_HEADERS, host: LOOPBACK_HOST, origin: LOOPBACK_ORIGIN, ...headers },
    payload: formBody({ code, password }),
  });

/** Claim an invite and return the session cookie the person lands with. */
export const mustClaim = async (ctx: AppContext, code: string, password = MEMBER_PASSWORD): Promise<string> => {
  const res = await claim(ctx, code, password);
  const cookie = sessionCookieOf(res);
  if (res.statusCode !== 303 || !cookie) throw new Error(`claim failed: ${res.statusCode} ${res.body}`);
  return cookie;
};

export const loginAs = (ctx: AppContext, username: string, password = MEMBER_PASSWORD) =>
  ctx.app.inject({
    method: 'POST',
    url: '/ui/login',
    headers: { ...FORM_HEADERS, host: LOOPBACK_HOST, origin: LOOPBACK_ORIGIN },
    payload: formBody({ username, password }),
  });

/** Admin invites `username`, who claims it: the whole product path to a new signed-in user. */
export const addUser = async (
  ctx: AppContext,
  adminCookie: string,
  username: string,
  role: 'admin' | 'member' = 'member',
): Promise<{ cookie: string; userId: string }> => {
  const cookie = await mustClaim(ctx, await mustInvite(ctx, adminCookie, { username, role }));
  return { cookie, userId: await userIdOf(ctx, username) };
};

export const userIdOf = async (ctx: AppContext, username: string): Promise<string> => {
  const [row] = await ctx.db.all<{ id: string }>(sql`SELECT id FROM users WHERE username = ${username}`);
  if (!row) throw new Error(`no user ${username}`);
  return row.id;
};

export type UserRow = {
  id: string;
  username: string | null;
  password_hash: string | null;
  role: string;
  disabled_at: string | null;
  last_login_at: string | null;
  version: number;
};

export const userRows = (ctx: AppContext) =>
  ctx.db.all<UserRow>(
    sql`SELECT id, username, password_hash, role, disabled_at, last_login_at, version FROM users ORDER BY created_at, id`,
  );

export const userRow = async (ctx: AppContext, username: string): Promise<UserRow | undefined> =>
  (await userRows(ctx)).find((row) => row.username === username);

export type InviteRow = { id: string; user_id: string; code_hash: string; used_at: string | null; expires_at: string };

export const inviteRows = (ctx: AppContext) =>
  ctx.db.all<InviteRow>(sql`SELECT id, user_id, code_hash, used_at, expires_at FROM invites ORDER BY created_at, id`);

export const countRows = async (
  ctx: AppContext,
  table: 'sessions' | 'access_tokens',
  userId: string,
): Promise<number> => {
  const [row] = await ctx.db.all<{ n: number }>(
    sql`SELECT COUNT(*) AS n FROM ${sql.identifier(table)} WHERE user_id = ${userId}`,
  );
  return row?.n ?? 0;
};

export const liveTokenCount = async (ctx: AppContext, userId: string): Promise<number> => {
  const [row] = await ctx.db.all<{ n: number }>(
    sql`SELECT COUNT(*) AS n FROM access_tokens WHERE user_id = ${userId} AND revoked_at IS NULL`,
  );
  return row?.n ?? 0;
};

export const mintFor = (ctx: AppContext, cookie: string): Promise<MintedToken> => mintToken(ctx, cookie);
