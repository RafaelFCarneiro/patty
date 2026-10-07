import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { issueSetupCode } from '../../../src/controllers/auth.js';
import { prepareAuth } from '../../../src/authRuntime.js';
import { bindAuthRunEffects } from '../../../src/authRuntime.js';
import { AuthMode, OWNER_USER_ID } from '../../../src/models/auth.js';
import { REQUIRED_AUTH } from '../app-builder.js';
import {
  authDepsOf,
  claimOwner,
  codeFrom,
  FORM_HEADERS,
  formBody,
  LOOPBACK_HOST,
  LOOPBACK_ORIGIN,
  PASSWORD,
  sessionCookieOf,
  useAuthApp,
  USERNAME,
} from './helpers.js';

const createApp = useAuthApp();

const post = (ctx: Awaited<ReturnType<typeof createApp>>, fields: Record<string, string>) =>
  ctx.app.inject({
    method: 'POST',
    url: '/ui/setup',
    headers: { ...FORM_HEADERS, host: LOOPBACK_HOST, origin: LOOPBACK_ORIGIN },
    payload: formBody(fields),
  });

const owners = (ctx: Awaited<ReturnType<typeof createApp>>) =>
  ctx.db.all<{ id: string; username: string | null; password_hash: string | null; role: string }>(
    sql`SELECT id, username, password_hash, role FROM users`,
  );

describe('setup code issuance', () => {
  it('prints one code to stderr at startup while the owner is unclaimed', async () => {
    const ctx = await createApp();
    expect(ctx.announced).toHaveLength(1);
    expect(codeFrom(ctx.announced)).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){4}$/);
  });

  it('stores only a hash of the code — the plaintext appears nowhere in the database', async () => {
    const ctx = await createApp();
    const code = codeFrom(ctx.announced);
    const rows = await ctx.db.all<Record<string, string | number | null>>(sql`SELECT * FROM setup_codes`);
    expect(rows).toHaveLength(1);
    const stored = JSON.stringify(rows);
    expect(stored).not.toContain(code);
    expect(stored).not.toContain(code.replaceAll('-', ''));
    expect(rows[0]?.['code_hash']).toBe(createHash('sha256').update(code.replaceAll('-', '')).digest('hex'));
  });

  it('issues a fresh code on restart and invalidates the previous one', async () => {
    const ctx = await createApp();
    const first = codeFrom(ctx.announced);
    const runAuth = bindAuthRunEffects(ctx.runEffects);
    const restarted = await runAuth(() => issueSetupCode(authDepsOf(ctx), AuthMode.enum.required));
    const second = restarted._unsafeUnwrap()?.code;

    expect(second).toBeDefined();
    expect(second).not.toBe(first);
    expect((await ctx.db.all(sql`SELECT 1 FROM setup_codes`)).length).toBe(1);

    const stale = await post(ctx, { code: first, username: USERNAME, password: PASSWORD });
    expect(stale.statusCode).toBe(403);
    const fresh = await post(ctx, { code: second as string, username: USERNAME, password: PASSWORD });
    expect(fresh.statusCode).toBe(303);
  });

  it('issues no code when auth is disabled', async () => {
    const ctx = await createApp({ auth: { FINTRACK_AUTH: AuthMode.enum.disabled } });
    expect(ctx.announced).toEqual([]);
    expect(await ctx.db.all(sql`SELECT 1 FROM setup_codes`)).toEqual([]);
  });

  it('issues no code when nothing serves HTTP', async () => {
    const ctx = await createApp();
    const announced: string[] = [];
    await prepareAuth(
      { ...REQUIRED_AUTH, MCP_TRANSPORT: 'stdio', FINTRACK_HTTP: false },
      ctx.db,
      ctx.runEffects,
      (message) => announced.push(message),
    );
    expect(announced).toEqual([]);
  });

  it('issues no code once the owner is claimed', async () => {
    const ctx = await createApp();
    await claimOwner(ctx);
    const announced: string[] = [];
    await prepareAuth(REQUIRED_AUTH, ctx.db, ctx.runEffects, (message) => announced.push(message));
    expect(announced).toEqual([]);
  });
});

describe('POST /ui/setup', () => {
  it('claims the existing owner — same id, no new row — and starts a session', async () => {
    const ctx = await createApp();
    const before = await owners(ctx);
    expect(before).toEqual([{ id: OWNER_USER_ID, username: null, password_hash: null, role: 'admin' }]);

    const res = await post(ctx, { code: codeFrom(ctx.announced), username: '  Rafael  ', password: PASSWORD });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe('/ui');
    expect(sessionCookieOf(res)).toBeDefined();

    const after = await owners(ctx);
    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe(OWNER_USER_ID);
    expect(after[0]?.username).toBe('rafael');
    expect(after[0]?.password_hash).toMatch(/^\$argon2id\$/);
    expect(JSON.stringify(after)).not.toContain(PASSWORD);
  });

  it('accepts the code however it is typed (case, spaces, dashes)', async () => {
    const ctx = await createApp();
    const sloppy = codeFrom(ctx.announced).toLowerCase().replaceAll('-', ' ');
    const res = await post(ctx, { code: sloppy, username: USERNAME, password: PASSWORD });
    expect(res.statusCode).toBe(303);
  });

  it('rejects a wrong code without changing the owner', async () => {
    const ctx = await createApp();
    const res = await post(ctx, { code: 'AAAA-AAAA-AAAA-AAAA-AAAA', username: USERNAME, password: PASSWORD });
    expect(res.statusCode).toBe(403);
    expect(sessionCookieOf(res)).toBeUndefined();
    expect((await owners(ctx))[0]?.username).toBeNull();
  });

  it('rejects an expired code', async () => {
    const ctx = await createApp();
    await ctx.db.run(sql`UPDATE setup_codes SET expires_at = '2000-01-01T00:00:00.000Z'`);
    const res = await post(ctx, { code: codeFrom(ctx.announced), username: USERNAME, password: PASSWORD });
    expect(res.statusCode).toBe(403);
  });

  it('rejects a code that was already used, and setup after the claim, without creating any user', async () => {
    const ctx = await createApp();
    const code = codeFrom(ctx.announced);
    expect((await post(ctx, { code, username: USERNAME, password: PASSWORD })).statusCode).toBe(303);

    const again = await post(ctx, { code, username: 'someone-else', password: PASSWORD });
    expect(again.statusCode).toBe(409);
    expect(sessionCookieOf(again)).toBeUndefined();
    const users = await owners(ctx);
    expect(users).toHaveLength(1);
    expect(users[0]?.username).toBe('rafael');
  });

  it('redirects GET /ui/setup to login once the owner is claimed', async () => {
    const ctx = await createApp();
    await claimOwner(ctx);
    const res = await ctx.app.inject({ method: 'GET', url: '/ui/setup' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/ui/login');
  });

  it('rejects a weak password with the policy message and burns no code', async () => {
    const ctx = await createApp();
    const res = await post(ctx, { code: codeFrom(ctx.announced), username: USERNAME, password: 'short' });
    expect(res.statusCode).toBe(422);
    expect(res.body).toContain('at least 12 characters');
    const retry = await post(ctx, { code: codeFrom(ctx.announced), username: USERNAME, password: PASSWORD });
    expect(retry.statusCode).toBe(303);
  });

  it('serves a setup page that names the code field and locks down framing and scripts', async () => {
    const ctx = await createApp();
    const res = await ctx.app.inject({ method: 'GET', url: '/ui/setup' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('name="code"');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['cache-control']).toBe('no-store');
  });
});
