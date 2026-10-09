import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { AuthMode, OWNER_USER_ID, TokenAccess } from '../../../src/models/auth.js';
import { CreateTokenFormSchema } from '../../../src/wire/in/auth.js';
import {
  authDepsOf,
  browserHeaders,
  claimOwner,
  formBody,
  LOOPBACK_HOST,
  mintToken,
  PASSWORD,
  useAuthApp,
} from './helpers.js';

const createApp = useAuthApp();

const SECRET = /data-testid="token-secret">(ftk_[A-Za-z0-9_-]+)</;

const get = (ctx: Awaited<ReturnType<typeof createApp>>, url: string, cookie: string) =>
  ctx.app.inject({ method: 'GET', url, headers: { host: LOOPBACK_HOST, cookie } });

describe('/ui/access/tokens', () => {
  it('needs a session: an anonymous browser is sent to log in', async () => {
    const ctx = await createApp();
    await claimOwner(ctx);
    const res = await ctx.app.inject({ method: 'GET', url: '/ui/access/tokens', headers: { host: LOOPBACK_HOST } });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe(`/ui/login?next=${encodeURIComponent('/ui/access/tokens')}`);
  });

  it('lists no tokens at first, with the create form', async () => {
    const ctx = await createApp();
    const cookie = await claimOwner(ctx);
    const res = await get(ctx, '/ui/access/tokens', cookie);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('No access tokens yet.');
    expect(res.body).toContain('name="access"');
    expect(res.body).toContain('name="expiry"');
  });

  it('offers exactly the access levels and expiries the form accepts, 90 days preselected', async () => {
    const ctx = await createApp();
    const cookie = await claimOwner(ctx);
    const body = (await get(ctx, '/ui/access/tokens', cookie)).body;
    const valuesOf = (select: string) =>
      [...body.matchAll(new RegExp(`<select name="${select}">(.*?)</select>`, 'gs'))]
        .flatMap(([, options]) => [...(options ?? '').matchAll(/<option value="([^"]+)"/g)])
        .map(([, value]) => value);
    expect(valuesOf('access')).toEqual([...TokenAccess.options]);
    expect(valuesOf('expiry')).toEqual(['30', '90', '365', 'none']);
    expect(body).toContain('<option value="90" selected>in 90 days</option>');
    expect(body).toContain('<option value="none">never</option>');
    for (const value of [...valuesOf('access')]) {
      expect(CreateTokenFormSchema.shape.access.safeParse(value).success).toBe(true);
    }
    for (const value of valuesOf('expiry')) {
      expect(CreateTokenFormSchema.shape.expiry.safeParse(value).success).toBe(true);
    }
  });

  it('is locked down like the sign-in pages: CSP, no-store, no framing', async () => {
    const ctx = await createApp();
    const cookie = await claimOwner(ctx);
    for (const res of [await get(ctx, '/ui/access/tokens', cookie)]) {
      expect(res.headers['cross-origin-opener-policy']).toBe('same-origin');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['content-security-policy']).toContain("default-src 'none'");
      expect(res.headers['x-frame-options']).toBe('DENY');
    }
  });

  it('shows the plaintext exactly once — on the response to the create POST — and never again', async () => {
    const ctx = await createApp();
    const cookie = await claimOwner(ctx);
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/ui/access/tokens',
      headers: browserHeaders(cookie),
      payload: formBody({ password: PASSWORD, name: 'Claude Desktop', access: 'read', expiry: '30' }),
    });
    expect(created.statusCode).toBe(200);
    expect(created.headers['cache-control']).toBe('no-store');
    expect(created.body).toContain("you won't see this token again");
    const token = SECRET.exec(created.body)?.[1] ?? '';
    expect(token).toMatch(/^ftk_[A-Za-z0-9_-]{43}$/);

    const list = await get(ctx, '/ui/access/tokens', cookie);
    expect(list.body).not.toContain(token);
    expect(list.body).toContain('Claude Desktop');
    expect(list.body).toContain(`${token.slice(0, 10)}…`);
    expect(list.body).toContain('read only');
    expect(list.body).toContain('active');
    expect(list.body).toContain('—'); // never used yet
  });

  it('stores only the hash and a prefix — never the plaintext', async () => {
    const ctx = await createApp();
    const cookie = await claimOwner(ctx);
    const { token } = await mintToken(ctx, cookie, { name: 'ci' });
    const [stored] = await authDepsOf(ctx).accessTokens.listByUser(OWNER_USER_ID);
    expect(JSON.stringify(stored)).not.toContain(token);
    expect(stored?.tokenHash).toBe(authDepsOf(ctx).secrets.hashSecret(token));
    expect(stored?.prefix).toBe(token.slice(0, 10));
    const rows = JSON.stringify(await ctx.db.all(sql`SELECT * FROM access_tokens`));
    expect(rows).not.toContain(token);
  });

  it('expiry choices: none, 30, 90 and 365 days', async () => {
    const ctx = await createApp();
    const cookie = await claimOwner(ctx);
    const expiries: Record<string, string | null> = {};
    for (const expiry of ['none', '30', '90', '365'] as const) {
      const { id } = await mintToken(ctx, cookie, { name: `exp-${expiry}`, expiry });
      expiries[expiry] = (await authDepsOf(ctx).accessTokens.findById(OWNER_USER_ID, id))?.expiresAt ?? null;
    }
    expect(expiries.none).toBeNull();
    const days = (iso: string | null) => Math.round((Date.parse(iso ?? '') - Date.now()) / 86_400_000);
    expect([days(expiries['30'] ?? null), days(expiries['90'] ?? null), days(expiries['365'] ?? null)]).toEqual([
      30, 90, 365,
    ]);
  });

  it('escapes a hostile token name everywhere it is rendered', async () => {
    const ctx = await createApp();
    const cookie = await claimOwner(ctx);
    const name = '<script>alert(1)</script>"&';
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/ui/access/tokens',
      headers: browserHeaders(cookie),
      payload: formBody({ password: PASSWORD, name, access: 'read', expiry: 'none' }),
    });
    const list = await get(ctx, '/ui/access/tokens', cookie);
    for (const body of [created.body, list.body]) {
      expect(body).not.toContain('<script>alert');
      expect(body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    }
  });

  it('rejects a bad form with 422 and creates nothing', async () => {
    const ctx = await createApp();
    const cookie = await claimOwner(ctx);
    for (const payload of [
      formBody({ password: PASSWORD, name: '', access: 'read', expiry: '30' }),
      formBody({ password: PASSWORD, name: 'x', access: 'root', expiry: '30' }),
      formBody({ password: PASSWORD, name: 'x', access: 'read', expiry: '7' }),
      formBody({ password: PASSWORD, access: 'read', expiry: '30' }),
    ]) {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/ui/access/tokens',
        headers: browserHeaders(cookie),
        payload,
      });
      expect(res.statusCode, payload).toBe(422);
      expect(res.body).toContain('auth-error');
    }
    expect(await authDepsOf(ctx).accessTokens.listByUser(OWNER_USER_ID)).toEqual([]);
  });

  it('revokes with a POST, keeps the row listed as revoked, and revoking again is harmless', async () => {
    const ctx = await createApp();
    const cookie = await claimOwner(ctx);
    const { id } = await mintToken(ctx, cookie, { name: 'old laptop' });
    const revoke = () =>
      ctx.app.inject({ method: 'POST', url: `/ui/access/tokens/${id}/revoke`, headers: browserHeaders(cookie) });

    const first = await revoke();
    expect(first.statusCode).toBe(303);
    expect(first.headers.location).toBe('/ui/access/tokens');
    const revokedAt = (await authDepsOf(ctx).accessTokens.findById(OWNER_USER_ID, id))?.revokedAt;
    expect(revokedAt).toEqual(expect.any(String));

    expect((await revoke()).statusCode).toBe(303);
    expect((await authDepsOf(ctx).accessTokens.findById(OWNER_USER_ID, id))?.revokedAt).toBe(revokedAt);

    const list = await get(ctx, '/ui/access/tokens', cookie);
    expect(list.body).toContain('old laptop');
    expect(list.body).toContain('token-status-revoked');
    expect(list.body).not.toContain(`/ui/access/tokens/${id}/revoke`); // nothing left to revoke
  });

  it('answers 404 for a token that does not exist', async () => {
    const ctx = await createApp();
    const cookie = await claimOwner(ctx);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/ui/access/tokens/nope/revoke',
      headers: browserHeaders(cookie),
    });
    expect(res.statusCode).toBe(404);
  });

  it('is behind the CSRF check: a cross-origin POST with the cookie is refused and does nothing', async () => {
    const ctx = await createApp();
    const cookie = await claimOwner(ctx);
    const { id } = await mintToken(ctx, cookie);
    const evil = { ...browserHeaders(cookie), origin: 'https://evil.example' };

    const mint = await ctx.app.inject({
      method: 'POST',
      url: '/ui/access/tokens',
      headers: evil,
      payload: formBody({ password: PASSWORD, name: 'x', access: 'write', expiry: 'none' }),
    });
    const revoke = await ctx.app.inject({ method: 'POST', url: `/ui/access/tokens/${id}/revoke`, headers: evil });
    expect([mint.statusCode, revoke.statusCode]).toEqual([403, 403]);
    const all = await authDepsOf(ctx).accessTokens.listByUser(OWNER_USER_ID);
    expect(all).toHaveLength(1);
    expect(all[0]?.revokedAt).toBeNull();
  });
});

describe('the dashboard namespace', () => {
  it('still serves a dashboard named tokens or access — token management is two segments deep', async () => {
    const ctx = await createApp();
    const cookie = await claimOwner(ctx);
    for (const name of ['tokens', 'access']) {
      const shell = await get(ctx, `/ui/${name}`, cookie);
      expect(shell.statusCode, name).toBe(200);
      expect(shell.body, name).toContain('id="content"');
      expect(shell.body, name).not.toContain('Create a token');
    }
  });
});

describe('the shell’s access-tokens link', () => {
  it('is in the sidebar when auth is required, next to logout', async () => {
    const ctx = await createApp();
    const cookie = await claimOwner(ctx);
    const shell = await get(ctx, '/ui', cookie);
    expect(shell.body).toContain('href="/ui/access/tokens"');
    expect(shell.body).toContain('action="/ui/logout"');
  });

  it('is absent when auth is disabled', async () => {
    const ctx = await createApp({ auth: { FINTRACK_AUTH: AuthMode.enum.disabled } });
    const shell = await ctx.app.inject({ method: 'GET', url: '/ui', headers: { host: LOOPBACK_HOST } });
    expect(shell.statusCode).toBe(200);
    expect(shell.body).not.toContain('/ui/access/tokens');
    expect(shell.body).not.toContain('/ui/logout');
  });
});
