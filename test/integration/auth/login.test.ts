import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  claimOwner,
  FORM_HEADERS,
  formBody,
  LOOPBACK_HOST,
  LOOPBACK_ORIGIN,
  PASSWORD,
  sessionCookieOf,
  setCookieOf,
  useAuthApp,
  USERNAME,
} from './helpers.js';

const createApp = useAuthApp();
type Ctx = Awaited<ReturnType<typeof createApp>>;

const login = (ctx: Ctx, fields: Record<string, string>, headers: Record<string, string> = {}) =>
  ctx.app.inject({
    method: 'POST',
    url: '/ui/login',
    headers: { ...FORM_HEADERS, host: LOOPBACK_HOST, origin: LOOPBACK_ORIGIN, ...headers },
    payload: formBody(fields),
  });

const claimedApp = async (opts?: Parameters<typeof createApp>[0]) => {
  const ctx = await createApp(opts);
  await claimOwner(ctx);
  return ctx;
};

describe('POST /ui/login', () => {
  it('logs in with the right credentials (username case-insensitive) and sets the cookie', async () => {
    const ctx = await claimedApp();
    const res = await login(ctx, { username: 'RAFAEL', password: PASSWORD });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe('/ui');
    expect(sessionCookieOf(res)).toBeDefined();
  });

  it('rejects a wrong password with one generic message and no cookie', async () => {
    const ctx = await claimedApp();
    const res = await login(ctx, { username: USERNAME, password: 'not the password' });
    expect(res.statusCode).toBe(401);
    expect(res.body).toContain('Invalid username or password.');
    expect(sessionCookieOf(res)).toBeUndefined();
  });

  it('answers an unknown user exactly like a wrong password', async () => {
    const ctx = await claimedApp();
    const wrongPassword = await login(ctx, { username: USERNAME, password: 'not the password' });
    const unknownUser = await login(ctx, { username: 'nobody-here', password: 'not the password' });
    expect(unknownUser.statusCode).toBe(wrongPassword.statusCode);
    expect(unknownUser.body).toBe(wrongPassword.body);
    expect(setCookieOf(unknownUser)).toBe(setCookieOf(wrongPassword));
  });

  it('cannot log in as the unclaimed owner, whatever is typed', async () => {
    const ctx = await createApp();
    for (const username of ['owner', 'user-owner', 'admin', '']) {
      const res = await login(ctx, { username: username || 'x', password: PASSWORD });
      expect(res.statusCode).toBe(401);
      expect(sessionCookieOf(res)).toBeUndefined();
    }
  });

  it('refuses a disabled user with the same generic answer', async () => {
    const ctx = await claimedApp();
    await ctx.db.run(sql`UPDATE users SET disabled_at = '2026-01-01T00:00:00.000Z'`);
    const res = await login(ctx, { username: USERNAME, password: PASSWORD });
    expect(res.statusCode).toBe(401);
    expect(res.body).toContain('Invalid username or password.');
  });

  it('trips the per-username rate limit after repeated failures — even for the right password', async () => {
    const ctx = await claimedApp();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await login(ctx, { username: USERNAME, password: `wrong-${attempt}` })).statusCode).toBe(401);
    }
    const blocked = await login(ctx, { username: USERNAME, password: PASSWORD });
    expect(blocked.statusCode).toBe(429);
    expect(sessionCookieOf(blocked)).toBeUndefined();
  });

  it('trips the per-IP rate limit when many different usernames fail', async () => {
    const ctx = await claimedApp();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await login(ctx, { username: `guess-${attempt}`, password: 'wrong password!' });
    }
    expect((await login(ctx, { username: USERNAME, password: PASSWORD })).statusCode).toBe(429);
  });

  it("a successful login clears that username's strikes", async () => {
    const ctx = await claimedApp();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await login(ctx, { username: USERNAME, password: `wrong-${attempt}` });
    }
    expect((await login(ctx, { username: USERNAME, password: PASSWORD })).statusCode).toBe(303);
    expect((await login(ctx, { username: USERNAME, password: 'wrong again' })).statusCode).toBe(401);
  });

  it('redirects GET /ui/login to setup while the owner is unclaimed', async () => {
    const ctx = await createApp();
    const res = await ctx.app.inject({ method: 'GET', url: '/ui/login' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/ui/setup');
  });

  it('serves the login page once claimed, carrying a validated next', async () => {
    const ctx = await claimedApp();
    const res = await ctx.app.inject({ method: 'GET', url: '/ui/login?next=/ui/budget' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('value="/ui/budget"');
    const hostile = await ctx.app.inject({ method: 'GET', url: '/ui/login?next=//evil.example/x' });
    expect(hostile.body).toContain('value="/ui"');
    expect(hostile.body).not.toContain('evil.example');
  });

  it('never redirects to an off-site `next` after login', async () => {
    const ctx = await claimedApp();
    for (const next of [
      '//evil.example',
      'https://evil.example',
      '/\\evil.example',
      '/api/accounts',
      'javascript:alert(1)',
    ]) {
      const res = await login(ctx, { username: USERNAME, password: PASSWORD, next });
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe('/ui');
    }
    const ok = await login(ctx, { username: USERNAME, password: PASSWORD, next: '/ui/budget?month=3' });
    expect(ok.headers.location).toBe('/ui/budget?month=3');
  });

  it('escapes anything it echoes into the page', async () => {
    const ctx = await claimedApp();
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/ui/login?next=/ui/%22%3E%3Cscript%3Ealert(1)%3C/script%3E',
    });
    expect(res.body).not.toContain('<script>alert');
  });
});

describe('sessions', () => {
  it('stores only the hash of the token', async () => {
    const ctx = await claimedApp();
    const res = await login(ctx, { username: USERNAME, password: PASSWORD });
    const token = sessionCookieOf(res)?.split('=')[1] ?? '';
    expect(token.length).toBeGreaterThanOrEqual(43); // 32 bytes, base64url
    const rows = await ctx.db.all<Record<string, string>>(sql`SELECT * FROM sessions`);
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(rows.map((row) => row['token_hash'])).toContain(createHash('sha256').update(token).digest('hex'));
  });

  it('sets HttpOnly, SameSite=Lax, Path=/ and no Secure flag over plain http', async () => {
    const ctx = await claimedApp();
    const cookie = setCookieOf(await login(ctx, { username: USERNAME, password: PASSWORD }));
    expect(cookie).toMatch(/^fintrack_session=[A-Za-z0-9_-]+;/);
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toMatch(/Max-Age=\d+/);
    expect(cookie).not.toContain('Secure');
  });

  it('adds Secure when PUBLIC_URL is https', async () => {
    const ctx = await claimedApp({ auth: { PUBLIC_URL: 'https://fintrack.example.com' } });
    const res = await login(
      ctx,
      { username: USERNAME, password: PASSWORD },
      { origin: 'https://fintrack.example.com' },
    );
    expect(res.statusCode).toBe(303);
    expect(setCookieOf(res)).toContain('Secure');
  });

  it('authenticates a request with the cookie and rejects it after logout', async () => {
    const ctx = await claimedApp();
    const cookie = sessionCookieOf(await login(ctx, { username: USERNAME, password: PASSWORD })) ?? '';
    const authed = await ctx.app.inject({ method: 'GET', url: '/api/status', headers: { cookie } });
    expect(authed.statusCode).toBe(200);

    const out = await ctx.app.inject({
      method: 'POST',
      url: '/ui/logout',
      headers: { cookie, host: LOOPBACK_HOST, origin: LOOPBACK_ORIGIN },
    });
    expect(out.statusCode).toBe(303);
    expect(out.headers.location).toBe('/ui/login');
    expect(setCookieOf(out)).toMatch(/Max-Age=0/);

    expect((await ctx.app.inject({ method: 'GET', url: '/api/status', headers: { cookie } })).statusCode).toBe(401);
    expect(
      await ctx.db.all(
        sql`SELECT 1 FROM sessions WHERE token_hash = ${createHash('sha256')
          .update(cookie.split('=')[1] ?? '')
          .digest('hex')}`,
      ),
    ).toEqual([]);
  });

  it('expires an idle session and prunes its row', async () => {
    const ctx = await claimedApp();
    const cookie = sessionCookieOf(await login(ctx, { username: USERNAME, password: PASSWORD })) ?? '';
    const tokenHash = createHash('sha256')
      .update(cookie.split('=')[1] ?? '')
      .digest('hex');
    await ctx.db.run(sql`UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z' WHERE token_hash = ${tokenHash}`);

    const res = await ctx.app.inject({ method: 'GET', url: '/api/status', headers: { cookie } });
    expect(res.statusCode).toBe(401);
    expect(await ctx.db.all(sql`SELECT 1 FROM sessions WHERE token_hash = ${tokenHash}`)).toEqual([]);
  });

  it('prunes every expired session at the next login', async () => {
    const ctx = await claimedApp();
    await ctx.db.run(sql`UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z'`);
    expect(await ctx.db.all(sql`SELECT 1 FROM sessions`)).toHaveLength(1);

    await login(ctx, { username: USERNAME, password: PASSWORD });
    const rows = await ctx.db.all<{ expires_at: string }>(sql`SELECT expires_at FROM sessions`);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.expires_at).not.toBe('2000-01-01T00:00:00.000Z');
  });

  it('enforces the absolute maximum even when the idle expiry is still ahead', async () => {
    const ctx = await claimedApp();
    const cookie = sessionCookieOf(await login(ctx, { username: USERNAME, password: PASSWORD })) ?? '';
    await ctx.db.run(
      sql`UPDATE sessions SET created_at = '2000-01-01T00:00:00.000Z', expires_at = '2999-01-01T00:00:00.000Z'`,
    );
    expect((await ctx.app.inject({ method: 'GET', url: '/api/status', headers: { cookie } })).statusCode).toBe(401);
  });

  it('slides the expiry forward on use, but only once the touch interval has passed', async () => {
    const ctx = await claimedApp();
    const cookie = sessionCookieOf(await login(ctx, { username: USERNAME, password: PASSWORD })) ?? '';
    const lastSeen = () =>
      ctx.db.all<{ last_seen_at: string; version: number }>(
        sql`SELECT last_seen_at, version FROM sessions WHERE last_seen_at = (SELECT MAX(last_seen_at) FROM sessions)`,
      );

    const [fresh] = await lastSeen();
    await ctx.app.inject({ method: 'GET', url: '/api/status', headers: { cookie } });
    expect((await lastSeen())[0]).toEqual(fresh); // not touched: seen moments ago

    await ctx.db.run(
      sql`UPDATE sessions SET last_seen_at = '2020-01-01T00:00:00.000Z', expires_at = '2999-01-01T00:00:00.000Z' WHERE last_seen_at = ${fresh?.last_seen_at ?? ''}`,
    );
    const authed = await ctx.app.inject({ method: 'GET', url: '/api/status', headers: { cookie } });
    expect(authed.statusCode).toBe(200);
    const rows = await ctx.db.all<{ last_seen_at: string; expires_at: string }>(
      sql`SELECT last_seen_at, expires_at FROM sessions`,
    );
    expect(rows.some((row) => row.last_seen_at > '2026-01-01' && row.expires_at < '2999-01-01')).toBe(true);
  });

  it('rejects a cookie for a user who has since been disabled', async () => {
    const ctx = await claimedApp();
    const cookie = sessionCookieOf(await login(ctx, { username: USERNAME, password: PASSWORD })) ?? '';
    await ctx.db.run(sql`UPDATE users SET disabled_at = '2026-01-01T00:00:00.000Z'`);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/status', headers: { cookie } })).statusCode).toBe(401);
  });
});
