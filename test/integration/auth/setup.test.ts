import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { okAsync } from 'neverthrow';
import { describe, expect, it } from 'vitest';
import { issueSetupCode } from '../../../src/controllers/auth.js';
import { prepareAuth } from '../../../src/composition/auth.js';
import { bindAuthRunEffects } from '../../../src/composition/auth.js';
import { TERMINAL_SETUP_HINT } from '../../../src/models/auth/message.js';
import { AuthMode } from '../../../src/models/auth/mode.js';
import { OWNER_USER_ID } from '../../../src/models/auth/owner.js';
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
    const runAuth = bindAuthRunEffects(ctx.authRunEffects);
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

  it('leaves exactly one valid code when a starter loses the race to issue (insert, then update)', async () => {
    const ctx = await createApp();
    const run = bindAuthRunEffects(ctx.authRunEffects);
    const deps = authDepsOf(ctx);
    const issue = () => issueSetupCode(deps, AuthMode.enum.required);

    // Starter B reads while no code exists and decides to INSERT the singleton…
    await ctx.db.run(sql`DELETE FROM setup_codes`);
    const staleInsert = (await issue())._unsafeUnwrap();
    // …but starter A commits its own code first.
    const a = (await run(issue))._unsafeUnwrap()?.code as string;

    // B's insert now collides with A's row. It must not silently no-op (leaving B printing a code that was
    // never stored): it retries, re-reads, and replaces A's code in place.
    let attempts = 0;
    const b = (await run(() => (attempts++ === 0 ? okAsync(staleInsert) : issue())))._unsafeUnwrap();
    expect(attempts).toBe(2);

    expect(await ctx.db.all(sql`SELECT 1 FROM setup_codes`)).toHaveLength(1);
    expect((await post(ctx, { code: a, username: USERNAME, password: PASSWORD })).statusCode).toBe(403);
    expect((await post(ctx, { code: b?.code as string, username: USERNAME, password: PASSWORD })).statusCode).toBe(303);
  });

  it('leaves exactly one valid code when a starter loses the race to replace it (stale update)', async () => {
    const ctx = await createApp();
    const run = bindAuthRunEffects(ctx.authRunEffects);
    const deps = authDepsOf(ctx);
    const issue = () => issueSetupCode(deps, AuthMode.enum.required);

    const staleUpdate = (await issue())._unsafeUnwrap(); // B read the row at version v…
    const a = (await run(issue))._unsafeUnwrap()?.code as string; // …A bumped it to v+1
    let attempts = 0;
    const b = (await run(() => (attempts++ === 0 ? okAsync(staleUpdate) : issue())))._unsafeUnwrap();

    expect(attempts).toBe(2);
    expect(await ctx.db.all(sql`SELECT 1 FROM setup_codes`)).toHaveLength(1);
    expect((await post(ctx, { code: a, username: USERNAME, password: PASSWORD })).statusCode).toBe(403);
    expect((await post(ctx, { code: b?.code as string, username: USERNAME, password: PASSWORD })).statusCode).toBe(303);
  });

  it('issues no code when auth is disabled', async () => {
    const ctx = await createApp({ auth: { FINTRACK_AUTH: AuthMode.enum.disabled } });
    expect(ctx.announced).toEqual([]);
    expect(await ctx.db.all(sql`SELECT 1 FROM setup_codes`)).toEqual([]);
  });

  it('issues no code when nothing serves HTTP', async () => {
    const ctx = await createApp({ auth: {} });
    await ctx.db.run(sql`DELETE FROM setup_codes`);
    const announced: string[] = [];
    const prepared = await prepareAuth(
      { ...REQUIRED_AUTH, MCP_TRANSPORT: 'stdio', FINTRACK_HTTP: false },
      ctx.db,
      ctx.authRunEffects,
    );
    await prepared.issueAndAnnounceSetup('http://127.0.0.1:51737', (message) => announced.push(message));
    expect(announced).toEqual([]);
    expect(await ctx.db.all(sql`SELECT 1 FROM setup_codes`)).toEqual([]);
  });

  it('issues no code once the owner is claimed', async () => {
    const ctx = await createApp();
    await claimOwner(ctx);
    const announced: string[] = [];
    const prepared = await prepareAuth(REQUIRED_AUTH, ctx.db, ctx.authRunEffects);
    await prepared.issueAndAnnounceSetup('http://127.0.0.1:51737', (message) => announced.push(message));
    expect(announced).toEqual([]);
  });
});

describe('issuing and announcing the setup code', () => {
  /** A database whose only setup code is the one a first process printed. */
  const withFirstProcessCode = async () => {
    const ctx = await createApp();
    return { ctx, printedByFirstProcess: codeFrom(ctx.announced) };
  };

  it('issues nothing until a server binds, so a process that never binds cannot replace the printed code', async () => {
    const { ctx, printedByFirstProcess } = await withFirstProcessCode();

    // A second stdio process: prepares auth, then its sidecar fails to bind (the first owns the port), so
    // main.ts never calls issueAndAnnounceSetup.
    await prepareAuth(REQUIRED_AUTH, ctx.db, ctx.authRunEffects);

    const response = await post(ctx, { code: printedByFirstProcess, username: USERNAME, password: PASSWORD });
    expect(response.statusCode).toBe(303); // the code the first process announced still works
  });

  it('prints once bound, naming the real origin — a PORT=0 instance has no usable URL before that', async () => {
    const ctx = await createApp();
    const announced: string[] = [];
    const prepared = await prepareAuth({ ...REQUIRED_AUTH, PORT: 0 }, ctx.db, ctx.authRunEffects);
    expect(announced).toEqual([]);

    await prepared.issueAndAnnounceSetup('http://127.0.0.1:54321', (message) => announced.push(message));
    expect(announced).toHaveLength(1);
    expect(announced[0]).toContain('http://127.0.0.1:54321/ui/setup');
    expect(announced[0]).not.toContain(':0/');
  });

  it('replaces the earlier code only at that point, and the new one works', async () => {
    const { ctx, printedByFirstProcess } = await withFirstProcessCode();
    const announced: string[] = [];
    const prepared = await prepareAuth(REQUIRED_AUTH, ctx.db, ctx.authRunEffects);
    await prepared.issueAndAnnounceSetup('http://127.0.0.1:51737', (message) => announced.push(message));

    expect((await post(ctx, { code: printedByFirstProcess, username: USERNAME, password: PASSWORD })).statusCode).toBe(
      403,
    );
    expect((await post(ctx, { code: codeFrom(announced), username: USERNAME, password: PASSWORD })).statusCode).toBe(
      303,
    );
  });

  it('names PUBLIC_URL rather than the bind address when one is configured', async () => {
    const ctx = await createApp();
    const announced: string[] = [];
    const prepared = await prepareAuth(
      { ...REQUIRED_AUTH, PUBLIC_URL: 'https://fintrack.example.com' },
      ctx.db,
      ctx.authRunEffects,
    );
    await prepared.issueAndAnnounceSetup('http://127.0.0.1:51737', (message) => announced.push(message));
    expect(announced[0]).toContain('https://fintrack.example.com/ui/setup');
    expect(announced[0]).not.toContain('127.0.0.1');
  });
});

describe('POST /ui/setup', () => {
  it('lets exactly one of two simultaneous claims win, leaving one owner', async () => {
    const ctx = await createApp();
    const code = codeFrom(ctx.announced);
    const [first, second] = await Promise.all([
      post(ctx, { code, username: 'first-claimant', password: PASSWORD }),
      post(ctx, { code, username: 'second-claimant', password: PASSWORD }),
    ]);

    // The loser retries on the version conflict, finds the owner claimed, and is refused.
    expect([first.statusCode, second.statusCode].sort()).toEqual([303, 409]);
    const winner = first.statusCode === 303 ? 'first-claimant' : 'second-claimant';
    const users = await owners(ctx);
    expect(users).toHaveLength(1);
    expect(users[0]?.username).toBe(winner);
  });

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

  it('tells the person, on the setup page and in the startup banner, that the terminal can claim it too', async () => {
    const ctx = await createApp();
    const page = await ctx.app.inject({ method: 'GET', url: '/ui/setup' });
    expect(page.body).toContain(TERMINAL_SETUP_HINT);
    expect(ctx.announced.join('\n')).toContain(TERMINAL_SETUP_HINT);
  });
});

describe('prepareAuth — what the stdio channel signs in with (ADR-034)', () => {
  it('hands the stdio session its identity deps when auth is required, even with no HTTP server', async () => {
    const ctx = await createApp();
    const prepared = await prepareAuth(
      { ...REQUIRED_AUTH, MCP_TRANSPORT: 'stdio', FINTRACK_HTTP: false },
      ctx.db,
      ctx.authRunEffects,
    );
    expect(prepared.stdio).not.toBeNull();
    expect(prepared.stdio?.signIn).toBeTypeOf('function');
    expect(prepared.auth.mode).toBe(AuthMode.enum.disabled); // nothing serves HTTP, so there are no sessions to guard
  });

  it('also does so beside the HTTP sidecar, which then guards its own surface', async () => {
    const ctx = await createApp();
    const prepared = await prepareAuth(
      { ...REQUIRED_AUTH, MCP_TRANSPORT: 'stdio', FINTRACK_HTTP: true },
      ctx.db,
      ctx.authRunEffects,
    );
    expect(prepared.stdio).not.toBeNull();
    expect(prepared.auth.mode).toBe(AuthMode.enum.required);
  });

  it('gives stdio nothing under an explicit FINTRACK_AUTH=disabled — it acts as the owner', async () => {
    const ctx = await createApp();
    const prepared = await prepareAuth(
      { ...REQUIRED_AUTH, FINTRACK_AUTH: AuthMode.enum.disabled, MCP_TRANSPORT: 'stdio' },
      ctx.db,
      ctx.authRunEffects,
    );
    expect(prepared.stdio).toBeNull();
  });

  it('gives stdio nothing when the transport is HTTP', async () => {
    const ctx = await createApp();
    expect(
      (await prepareAuth({ ...REQUIRED_AUTH, MCP_TRANSPORT: 'http' }, ctx.db, ctx.authRunEffects)).stdio,
    ).toBeNull();
  });

  it('prunes sign-in requests that ran out unanswered at startup, keeping the live and the redeemed', async () => {
    const ctx = await createApp();
    const row = (id: string, userCode: string, status: string, expiresAt: string) =>
      sql`INSERT INTO client_grants (id, device_code_hash, user_code, client_name, client_version, profile, channel, status, created_at, expires_at, version)
          VALUES (${id}, ${`hash-${id}`}, ${userCode}, 'c', '1', 'default', 'stdio', ${status}, '2020-01-01T00:00:00.000Z', ${expiresAt}, 0)`;
    const future = new Date(Date.now() + 60_000).toISOString();
    const past = '2020-01-01T00:10:00.000Z';
    await ctx.db.run(row('stale-pending', 'AAAAAAAA', 'pending', past));
    await ctx.db.run(row('stale-denied', 'BBBBBBBB', 'denied', past));
    await ctx.db.run(row('stale-redeemed', 'CCCCCCCC', 'redeemed', past));
    await ctx.db.run(row('live-pending', 'DDDDDDDD', 'pending', future));

    await prepareAuth(REQUIRED_AUTH, ctx.db, ctx.authRunEffects);

    const kept = await ctx.db.all<{ id: string }>(sql`SELECT id FROM client_grants ORDER BY id`);
    expect(kept.map((grant) => grant.id)).toEqual(['live-pending', 'stale-redeemed']);
  });

  it('never prunes anything under an explicit FINTRACK_AUTH=disabled', async () => {
    const ctx = await createApp();
    await ctx.db.run(
      sql`INSERT INTO client_grants (id, device_code_hash, user_code, client_name, client_version, profile, channel, status, created_at, expires_at, version)
          VALUES ('old', 'h', 'AAAAAAAA', 'c', '1', 'default', 'stdio', 'pending', '2020-01-01T00:00:00.000Z', '2020-01-01T00:10:00.000Z', 0)`,
    );
    await prepareAuth({ ...REQUIRED_AUTH, FINTRACK_AUTH: AuthMode.enum.disabled }, ctx.db, ctx.authRunEffects);
    expect(await ctx.db.all(sql`SELECT 1 FROM client_grants`)).toHaveLength(1);
  });
});
