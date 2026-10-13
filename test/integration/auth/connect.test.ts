import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  CLIENT_GRANT_TTL_MS,
  GrantChannel,
  MAX_SIGN_IN_DURATION_MS,
  PrincipalVia,
  SignInDuration,
} from '../../../src/models/auth.js';
import { startGrant } from '../../../src/controllers/grants.js';
import { MAX_CODE_LOOKUP_FAILURES_PER_IP } from '../../../src/diplomat/http/rateLimiter.js';
import { bindAuthRunEffects } from '../../../src/authRuntime.js';
import {
  answerConnect,
  authDepsOf,
  bearer,
  browserHeaders,
  claimOwner,
  formBody,
  FORM_HEADERS,
  LOOPBACK_HOST,
  LOOPBACK_ORIGIN,
  mintToken,
  PASSWORD,
  sessionCookieOf,
  setCookieOf,
  stdioSessionFor,
  useAuthApp,
  userCodeIn,
  USERNAME,
} from './helpers.js';

const createApp = useAuthApp();

type Ctx = Awaited<ReturnType<typeof createApp>>;

const getConnect = (ctx: Ctx, query: string, headers: Record<string, string> = {}) =>
  ctx.app.inject({ method: 'GET', url: `/ui/connect${query}`, headers: { host: LOOPBACK_HOST, ...headers } });

/** A stdio client asks to sign in; returns the code it would print. */
const requestCode = async (ctx: Ctx, clientInfo?: unknown): Promise<string> =>
  userCodeIn(await stdioSessionFor(ctx, clientInfo === undefined ? {} : { clientInfo }).session.resolve());

const radios = (body: string, name: string) =>
  [...body.matchAll(new RegExp(`<input type="radio" name="${name}" value="([^"]+)"( checked)?`, 'g'))].map(
    ([, value, checked]) => ({ value, checked: checked !== undefined }),
  );

describe('GET /ui/connect', () => {
  it('shows who is asking (as reported by the client), the profile, the code and the choices', async () => {
    const ctx = await createApp();
    const cookie = await claimOwner(ctx);
    const code = await requestCode(ctx, { name: 'Claude Desktop', version: '1.2.3' });

    const res = await getConnect(ctx, `?code=${code}`, { cookie });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Claude Desktop');
    expect(res.body).toContain('1.2.3');
    expect(res.body).toContain('reported by the client');
    expect(res.body).toContain('data-testid="connect-code">' + code + '<');
    expect(res.body).toContain('Profile');
    expect(res.body).toContain('default');
    expect(res.body).toContain('Only approve if you just asked a Claude session on this machine to connect');
    expect(res.body).toContain('name="decision" value="approve"');
    expect(res.body).toContain('name="decision" value="deny"');
  });

  it('pre-selects read-only for 24 hours, and offers "this session only" to a stdio client', async () => {
    const ctx = await createApp();
    const cookie = await claimOwner(ctx);
    const code = await requestCode(ctx);

    const body = (await getConnect(ctx, `?code=${code}`, { cookie })).body;

    expect(radios(body, 'access')).toEqual([
      { value: 'read', checked: true },
      { value: 'write', checked: false },
    ]);
    expect(radios(body, 'duration')).toEqual([
      { value: 'session', checked: false },
      { value: '24h', checked: true },
      { value: '7d', checked: false },
      { value: '30d', checked: false },
    ]);
  });

  it('words "this session only" after the client, escaped, with a plain fallback when it gave no name', async () => {
    const ctx = await createApp();
    const cookie = await claimOwner(ctx);
    const named = await requestCode(ctx, { name: 'Claude Desktop', version: '1' });
    const hostile = await requestCode(ctx, { name: '<b>Evil</b>', version: '1' });
    const unnamed = await requestCode(ctx, {});

    const labelOf = async (code: string) => (await getConnect(ctx, `?code=${code}`, { cookie })).body;

    expect(await labelOf(named)).toContain('This Claude Desktop session only</label>');
    const hostileBody = await labelOf(hostile);
    expect(hostileBody).toContain('This &lt;b&gt;Evil&lt;/b&gt; session only</label>');
    expect(hostileBody).not.toContain('<b>Evil</b>');
    const unnamedBody = await labelOf(unnamed);
    expect(unnamedBody).toContain('This session only</label>');
    expect(unnamedBody).not.toContain('Unknown MCP client session');
  });

  it('pre-selects what this person chose last time for this client', async () => {
    const ctx = await createApp();
    const cookie = await claimOwner(ctx);
    const first = stdioSessionFor(ctx).session;
    await answerConnect(ctx, cookie, userCodeIn(await first.resolve()), {
      decision: 'approve',
      access: 'write',
      duration: '7d',
    });
    await first.resolve(); // redeems the approval

    const body = (await getConnect(ctx, `?code=${await requestCode(ctx)}`, { cookie })).body;

    expect(radios(body, 'access').find((r) => r.checked)?.value).toBe('write');
    expect(radios(body, 'duration').find((r) => r.checked)?.value).toBe('7d');
  });

  it('never offers "this session only" for a sign-in `fintrack login` asked for, and honors its hint', async () => {
    const ctx = await createApp();
    const cookie = await claimOwner(ctx);
    const deps = authDepsOf(ctx);
    const started = await bindAuthRunEffects(ctx.runEffects)(() =>
      startGrant(deps, {
        client: { name: 'fintrack login', version: '0' },
        profile: 'work',
        channel: GrantChannel.enum.cli,
        hint: { access: 'write', duration: SignInDuration.enum['30d'] },
      }),
    );

    const body = (await getConnect(ctx, `?code=${started._unsafeUnwrap().userCode}`, { cookie })).body;

    expect(radios(body, 'duration').map((r) => r.value)).toEqual(['24h', '7d', '30d']);
    expect(radios(body, 'duration').find((r) => r.checked)?.value).toBe('30d');
    expect(radios(body, 'access').find((r) => r.checked)?.value).toBe('write');
    expect(body).toContain('work');
  });

  it('offers no choice longer than the 30-day maximum', async () => {
    const ctx = await createApp();
    const cookie = await claimOwner(ctx);
    const body = (await getConnect(ctx, `?code=${await requestCode(ctx)}`, { cookie })).body;
    const offered = radios(body, 'duration').map((r) => r.value as SignInDuration);
    for (const value of offered) expect(SignInDuration.safeParse(value).success).toBe(true);
    expect(MAX_SIGN_IN_DURATION_MS).toBe(30 * 24 * 60 * 60 * 1000);
    expect(offered).not.toContain('90d');
  });

  it('accepts the code case- and dash-insensitively', async () => {
    const ctx = await createApp();
    const cookie = await claimOwner(ctx);
    const code = await requestCode(ctx);
    const typed = code.toLowerCase().replace('-', '');
    expect((await getConnect(ctx, `?code=${typed}`, { cookie })).statusCode).toBe(200);
  });

  it('escapes whatever the client called itself', async () => {
    const ctx = await createApp();
    const cookie = await claimOwner(ctx);
    const code = await requestCode(ctx, { name: '<script>alert(1)</script>', version: '"><img src=x>' });
    const body = (await getConnect(ctx, `?code=${code}`, { cookie })).body;
    expect(body).not.toContain('<script>alert(1)');
    expect(body).not.toContain('<img src=x>');
    expect(body).toContain('&lt;script&gt;');
  });

  it('is locked down like the sign-in pages: CSP, no-store, no framing', async () => {
    const ctx = await createApp();
    const cookie = await claimOwner(ctx);
    const res = await getConnect(ctx, `?code=${await requestCode(ctx)}`, { cookie });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['cross-origin-opener-policy']).toBe('same-origin');
  });

  it.each([
    ['an unknown code', () => '?code=ZZZZ-ZZZZ'],
    ['no code', () => ''],
    ['an oversized code', () => `?code=${'A'.repeat(200)}`],
  ])('answers %s with the same neutral message', async (_label, query) => {
    const ctx = await createApp();
    const cookie = await claimOwner(ctx);
    const res = await getConnect(ctx, query(), { cookie });
    expect(res.statusCode).toBe(404);
    expect(res.body).toContain('This sign-in request is not valid, has expired, or was already answered.');
    expect(res.body).not.toContain('name="decision"');
  });

  it('answers an expired code and an already-answered one with that same message', async () => {
    const ctx = await createApp();
    const cookie = await claimOwner(ctx);
    const answered = await requestCode(ctx);
    await answerConnect(ctx, cookie, answered, { decision: 'deny' });
    const stale = await requestCode(ctx);
    await ctx.db.run(
      sql`UPDATE client_grants SET expires_at = ${new Date(Date.now() - CLIENT_GRANT_TTL_MS).toISOString()} WHERE status = 'pending'`,
    );

    for (const code of [answered, stale]) {
      const res = await getConnect(ctx, `?code=${code}`, { cookie });
      expect(res.statusCode).toBe(404);
      expect(res.body).toContain('not valid, has expired, or was already answered');
    }
  });

  it('is throttled after a run of failed lookups from one address', async () => {
    const ctx = await createApp();
    const cookie = await claimOwner(ctx);
    const real = await requestCode(ctx);
    for (let attempt = 0; attempt < MAX_CODE_LOOKUP_FAILURES_PER_IP; attempt += 1) {
      expect((await getConnect(ctx, '?code=NOPE-NOPE', { cookie })).statusCode).toBe(404);
    }

    const blocked = await getConnect(ctx, `?code=${real}`, { cookie });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.body).not.toContain('name="decision"');
  });

  it('holds the cap under a burst of concurrent guesses — each strike is taken before the awaited lookup', async () => {
    const ctx = await createApp();
    const cookie = await claimOwner(ctx);
    const burst = await Promise.all(
      Array.from({ length: MAX_CODE_LOOKUP_FAILURES_PER_IP * 3 }, () => getConnect(ctx, '?code=NOPE-NOPE', { cookie })),
    );
    const statuses = burst.map((res) => res.statusCode);
    expect(statuses.filter((status) => status === 404)).toHaveLength(MAX_CODE_LOOKUP_FAILURES_PER_IP);
    expect(statuses.filter((status) => status === 429)).toHaveLength(MAX_CODE_LOOKUP_FAILURES_PER_IP * 2);
  });

  it('holds the cap under a burst of concurrent POST guesses too', async () => {
    const ctx = await createApp();
    const cookie = await claimOwner(ctx);
    const burst = await Promise.all(
      Array.from({ length: MAX_CODE_LOOKUP_FAILURES_PER_IP * 3 }, () =>
        answerConnect(ctx, cookie, 'GUESS-GUESS', { decision: 'approve' }),
      ),
    );
    const statuses = burst.map((res) => res.statusCode);
    expect(statuses.filter((status) => status === 404)).toHaveLength(MAX_CODE_LOOKUP_FAILURES_PER_IP);
    expect(statuses.filter((status) => status === 429)).toHaveLength(MAX_CODE_LOOKUP_FAILURES_PER_IP * 2);
  });

  it('does not count a successful lookup against the limit', async () => {
    const ctx = await createApp();
    const cookie = await claimOwner(ctx);
    const code = await requestCode(ctx);
    for (let attempt = 0; attempt < MAX_CODE_LOOKUP_FAILURES_PER_IP * 2; attempt += 1) {
      expect((await getConnect(ctx, `?code=${code}`, { cookie })).statusCode).toBe(200);
    }
  });
});

describe('/ui/connect needs a browser session', () => {
  it('sends an anonymous browser to log in and back: the next= round trip lands on the very same link', async () => {
    const ctx = await createApp();
    await claimOwner(ctx);
    const code = await requestCode(ctx);
    const link = `/ui/connect?code=${code}`;

    const anonymous = await getConnect(ctx, `?code=${code}`);
    expect(anonymous.statusCode).toBe(303);
    expect(anonymous.headers.location).toBe(`/ui/login?next=${encodeURIComponent(link)}`);

    const loginPage = await ctx.app.inject({
      method: 'GET',
      url: anonymous.headers.location as string,
      headers: { host: LOOPBACK_HOST },
    });
    expect(loginPage.body).toContain(`name="next" value="${link}"`);

    const loggedIn = await ctx.app.inject({
      method: 'POST',
      url: '/ui/login',
      headers: { ...FORM_HEADERS, host: LOOPBACK_HOST, origin: LOOPBACK_ORIGIN },
      payload: formBody({ username: USERNAME, password: PASSWORD, next: link }),
    });
    expect(loggedIn.statusCode).toBe(303);
    expect(loggedIn.headers.location).toBe(link);
    const cookie = sessionCookieOf(loggedIn)!;
    expect(setCookieOf(loggedIn)).toContain('HttpOnly');
    expect((await getConnect(ctx, `?code=${code}`, { cookie })).statusCode).toBe(200);
  });

  it('refuses a bearer token on the page, and a POST from one', async () => {
    const ctx = await createApp();
    const cookie = await claimOwner(ctx);
    const { token } = await mintToken(ctx, cookie, { access: 'write' });
    const code = await requestCode(ctx);

    const page = await getConnect(ctx, `?code=${code}`, bearer(token));
    expect(page.statusCode).toBe(303); // /ui ignores Authorization: no credential, so back to login

    const post = await ctx.app.inject({
      method: 'POST',
      url: '/ui/connect',
      headers: { ...FORM_HEADERS, host: LOOPBACK_HOST, origin: LOOPBACK_ORIGIN, ...bearer(token) },
      payload: formBody({ code, decision: 'approve', access: 'write', duration: '30d' }),
    });
    expect(post.statusCode).toBe(303);
    expect(await ctx.db.all(sql`SELECT status FROM client_grants`)).toEqual([{ status: 'pending' }]);
    expect(PrincipalVia.enum.token).toBe('token');
  });

  it('rejects an approval from another origin (CSRF) and leaves the request pending', async () => {
    const ctx = await createApp();
    const cookie = await claimOwner(ctx);
    const code = await requestCode(ctx);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/ui/connect',
      headers: { ...browserHeaders(cookie), origin: 'https://evil.example' },
      payload: formBody({ code, decision: 'approve', access: 'write', duration: '30d' }),
    });
    expect(res.statusCode).toBe(403);
    expect(await ctx.db.all(sql`SELECT status FROM client_grants`)).toEqual([{ status: 'pending' }]);
  });

  it('rejects an approval that declares no origin at all while carrying the session cookie', async () => {
    const ctx = await createApp();
    const cookie = await claimOwner(ctx);
    const code = await requestCode(ctx);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/ui/connect',
      headers: { ...FORM_HEADERS, host: LOOPBACK_HOST, cookie },
      payload: formBody({ code, decision: 'approve', access: 'write', duration: '30d' }),
    });
    expect(res.statusCode).toBe(403);
    expect(await ctx.db.all(sql`SELECT status FROM client_grants`)).toEqual([{ status: 'pending' }]);
  });
});

describe('POST /ui/connect', () => {
  it('approves with the chosen scopes and duration, binds the approving user, and says so', async () => {
    const ctx = await createApp();
    const cookie = await claimOwner(ctx);
    const code = await requestCode(ctx);

    const res = await answerConnect(ctx, cookie, code, { decision: 'approve', access: 'write', duration: '7d' });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Approved');
    expect(await ctx.db.all(sql`SELECT status, user_id, scopes, duration FROM client_grants`)).toEqual([
      { status: 'approved', user_id: 'user-owner', scopes: '["fintrack:read","fintrack:write"]', duration: '7d' },
    ]);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('says "close this tab" for a stdio request too — its page may be a temporary one that closes', async () => {
    const ctx = await createApp();
    const cookie = await claimOwner(ctx);
    for (const decision of ['approve', 'deny'] as const) {
      const res = await answerConnect(ctx, cookie, await requestCode(ctx), { decision });
      expect(res.body).toContain('You can close this tab.');
      expect(res.body).not.toContain('Back to the dashboards');
    }
  });

  it('keeps the way back to the dashboards on a page that is only an error', async () => {
    const ctx = await createApp();
    const cookie = await claimOwner(ctx);
    const res = await getConnect(ctx, '?code=ZZZZ-ZZZZ', { cookie });
    expect(res.body).toContain('Back to the dashboards');
  });

  it('says "close this tab", not a dashboard link, for a `fintrack login` request', async () => {
    const ctx = await createApp();
    const cookie = await claimOwner(ctx);
    const started = await bindAuthRunEffects(ctx.runEffects)(() =>
      startGrant(authDepsOf(ctx), {
        client: { name: 'fintrack login', version: '0' },
        profile: 'default',
        channel: GrantChannel.enum.cli,
      }),
    );
    const code = started._unsafeUnwrap().userCode;
    const approved = await answerConnect(ctx, cookie, code, { decision: 'approve' });
    expect(approved.statusCode).toBe(200);
    expect(approved.body).toContain('You can close this tab.');
    expect(approved.body).not.toContain('Back to the dashboards');
  });

  it('denies, and says so', async () => {
    const ctx = await createApp();
    const cookie = await claimOwner(ctx);
    const res = await answerConnect(ctx, cookie, await requestCode(ctx), { decision: 'deny' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Denied');
    expect(await ctx.db.all(sql`SELECT status FROM client_grants`)).toEqual([{ status: 'denied' }]);
  });

  it('answers a second decision on the same code with the neutral message', async () => {
    const ctx = await createApp();
    const cookie = await claimOwner(ctx);
    const code = await requestCode(ctx);
    await answerConnect(ctx, cookie, code, { decision: 'deny' });
    const again = await answerConnect(ctx, cookie, code, { decision: 'approve', access: 'write', duration: '30d' });
    expect(again.statusCode).toBe(404);
    expect(again.body).toContain('not valid, has expired, or was already answered');
    expect(await ctx.db.all(sql`SELECT status FROM client_grants`)).toEqual([{ status: 'denied' }]);
  });

  it('refuses a malformed decision, access or duration without touching the request', async () => {
    const ctx = await createApp();
    const cookie = await claimOwner(ctx);
    const code = await requestCode(ctx);
    const bads: Array<Record<string, string>> = [
      { decision: 'approve', access: 'admin', duration: '24h' },
      { decision: 'approve', access: 'read', duration: 'forever' },
      { decision: 'maybe', access: 'read', duration: '24h' },
      { access: 'read', duration: '24h' },
    ];
    for (const bad of bads) {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/ui/connect',
        headers: browserHeaders(cookie),
        payload: formBody({ code, ...bad }),
      });
      expect(res.statusCode).toBe(422);
    }
    expect(await ctx.db.all(sql`SELECT status FROM client_grants`)).toEqual([{ status: 'pending' }]);
  });

  it('refuses "this session only" for a request that came from `fintrack login`', async () => {
    const ctx = await createApp();
    const cookie = await claimOwner(ctx);
    const started = await bindAuthRunEffects(ctx.runEffects)(() =>
      startGrant(authDepsOf(ctx), {
        client: { name: 'fintrack login', version: '0' },
        profile: 'default',
        channel: GrantChannel.enum.cli,
      }),
    );
    const res = await answerConnect(ctx, cookie, started._unsafeUnwrap().userCode, {
      decision: 'approve',
      duration: 'session',
    });
    expect(res.statusCode).toBe(422);
    expect(await ctx.db.all(sql`SELECT status FROM client_grants`)).toEqual([{ status: 'pending' }]);
  });

  it('throttles guesses at the code on POST too', async () => {
    const ctx = await createApp();
    const cookie = await claimOwner(ctx);
    for (let attempt = 0; attempt < MAX_CODE_LOOKUP_FAILURES_PER_IP; attempt += 1) {
      expect((await answerConnect(ctx, cookie, 'GUESS-GUESS', { decision: 'approve' })).statusCode).toBe(404);
    }
    expect((await answerConnect(ctx, cookie, 'GUESS-GUESS', { decision: 'approve' })).statusCode).toBe(429);
  });
});

describe('/ui/access/tokens lists stdio sign-ins next to the tokens', () => {
  const signedIn = async (ctx: Ctx, cookie: string, choice: { access: 'read' | 'write'; duration: SignInDuration }) => {
    const { session } = stdioSessionFor(ctx, { clientInfo: { name: 'Claude <Desktop>', version: '1' } });
    await answerConnect(ctx, cookie, userCodeIn(await session.resolve()), { decision: 'approve', ...choice });
    await session.resolve();
    return session;
  };

  it('shows the client, profile, access, approval, expiry and last use — and a revoke button', async () => {
    const ctx = await createApp();
    const cookie = await claimOwner(ctx);
    await signedIn(ctx, cookie, { access: 'write', duration: '7d' });

    const body = (
      await ctx.app.inject({ method: 'GET', url: '/ui/access/tokens', headers: { host: LOOPBACK_HOST, cookie } })
    ).body;

    expect(body).toContain('Claude sign-ins');
    expect(body).toContain('Claude &lt;Desktop&gt;');
    expect(body).not.toContain('Claude <Desktop>');
    expect(body).toMatch(/<td>default<\/td>/);
    expect(body).toContain('read + write');
    expect(body).toContain('<th>Signed in</th>'); // the token's creation is the redemption, not the approval
    expect(body).not.toContain('<th>Approved</th>');
    expect(body).toContain('token-status-active');
    expect(body).toMatch(/\/ui\/access\/tokens\/[^/]+\/revoke/);
    expect(body).toContain('No access tokens yet.'); // the PAT table is separate and empty
  });

  it('keeps a personal access token out of the sign-ins table and a sign-in out of the token table', async () => {
    const ctx = await createApp();
    const cookie = await claimOwner(ctx);
    await mintToken(ctx, cookie, { name: 'my-script' });
    await signedIn(ctx, cookie, { access: 'read', duration: '24h' });
    const body = (
      await ctx.app.inject({ method: 'GET', url: '/ui/access/tokens', headers: { host: LOOPBACK_HOST, cookie } })
    ).body;
    const [signIns, tokens] = body.split('<h2>Personal access tokens</h2>');
    expect(signIns).toContain('Claude &lt;Desktop&gt;');
    expect(signIns).not.toContain('my-script');
    expect(tokens).toContain('my-script');
    expect(tokens).not.toContain('Claude &lt;Desktop&gt;');
  });

  it('revokes a sign-in from the page; the very next stdio call asks again', async () => {
    const ctx = await createApp();
    const cookie = await claimOwner(ctx);
    const session = await signedIn(ctx, cookie, { access: 'read', duration: '24h' });
    const [row] = await ctx.db.all<{ id: string }>(sql`SELECT id FROM access_tokens WHERE kind = 'stdio'`);
    const id = row!.id;

    const revoked = await ctx.app.inject({
      method: 'POST',
      url: `/ui/access/tokens/${id}/revoke`,
      headers: browserHeaders(cookie),
    });

    expect(revoked.statusCode).toBe(303);
    expect((await session.resolve()).kind).toBe('not_signed_in');
    const body = (
      await ctx.app.inject({ method: 'GET', url: '/ui/access/tokens', headers: { host: LOOPBACK_HOST, cookie } })
    ).body;
    expect(body).toContain('token-status-revoked');
  });

  it('rejects a stdio sign-in used as a bearer token on /api — it is only for stdio', async () => {
    const ctx = await createApp();
    const cookie = await claimOwner(ctx);
    const { store } = stdioSessionFor(ctx);
    const session = stdioSessionFor(ctx, { store });
    await answerConnect(ctx, cookie, userCodeIn(await session.session.resolve()), {
      decision: 'approve',
      access: 'write',
    });
    await session.session.resolve();
    const token = store.saved()!;

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/status',
      headers: { host: LOOPBACK_HOST, ...bearer(token) },
    });
    expect(res.statusCode).toBe(401);
  });
});
