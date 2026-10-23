import { sql } from 'drizzle-orm';
import { okAsync } from 'neverthrow';
import { describe, expect, it } from 'vitest';
import { bindAuthRunEffects } from '../../../src/composition/auth.js';
import { authenticateToken } from '../../../src/controllers/access-tokens.js';
import type { AuthDeps } from '../../../src/controllers/deps.js';
import {
  approveGrant,
  denyGrant,
  findConsent,
  pruneExpiredGrants,
  redeemGrant,
  startGrant,
} from '../../../src/controllers/grants.js';
import { sessionPrincipal } from '../../../src/logic/auth/session.js';
import { tokenPrincipal } from '../../../src/logic/auth/token.js';
import { authErrors } from '../../../src/models/auth/errors.js';
import {
  CLIENT_GRANT_TTL_MS,
  GrantChannel,
  type RedeemResult,
  type StartGrantInput,
} from '../../../src/models/auth/grant.js';
import { OWNER_USER_ID } from '../../../src/models/auth/owner.js';
import { OWNER_PRINCIPAL, type Principal, PrincipalVia } from '../../../src/models/auth/principal.js';
import { AccessTokenKind } from '../../../src/models/auth/token.js';
import { conflict } from '../../../src/models/error.js';
import { authDepsOf, bearer, claimOwner, movableClock, PASSWORD, useAuthApp } from './helpers.js';

const createApp = useAuthApp();

const MINUTE_MS = 60 * 1000;
const CLIENT = { name: 'Claude Desktop', version: '1.2.3' };
const STDIO_REQUEST: StartGrantInput = { client: CLIENT, profile: 'default', channel: GrantChannel.enum.stdio };

type Ctx = Awaited<ReturnType<typeof createApp>>;

const world = async (overrides: Partial<AuthDeps> = {}) => {
  const ctx = await createApp();
  await claimOwner(ctx);
  const base = authDepsOf(ctx);
  const deps: AuthDeps = { ...base, ...overrides };
  const run = bindAuthRunEffects(ctx.authRunEffects);
  const owner = (await deps.users.findById(OWNER_USER_ID))!;
  const [held] = await deps.sessions.listByUser(OWNER_USER_ID);
  return { ctx, deps, run, session: sessionPrincipal(owner, held!), owner };
};

const start = async (w: Awaited<ReturnType<typeof world>>, input: StartGrantInput = STDIO_REQUEST) => {
  const started = await w.run(() => startGrant(w.deps, input));
  if (started.isErr()) throw new Error(`startGrant failed: ${JSON.stringify(started.error)}`);
  return started.value;
};

const signedIn = (result: RedeemResult) => {
  if (result.kind !== 'signed_in') throw new Error(`expected signed_in, got ${result.kind}`);
  return result;
};

const dump = (ctx: Ctx) => ctx.db.all(sql`SELECT * FROM client_grants`);

describe('startGrant', () => {
  it('returns the device code once and a displayable user code; stores only hashes', async () => {
    const w = await world();
    const started = await start(w);

    expect(started.deviceCode).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(started.userCode).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    const [row] = await w.ctx.db.all<Record<string, unknown>>(sql`SELECT * FROM client_grants`);
    expect(row).toMatchObject({
      device_code_hash: w.deps.secrets.hashSecret(started.deviceCode),
      user_code: started.userCode.replace('-', ''),
      status: 'pending',
      client_name: 'Claude Desktop',
      client_version: '1.2.3',
      profile: 'default',
      channel: 'stdio',
      user_id: null,
      scopes: null,
      duration: null,
    });
    expect(JSON.stringify(await dump(w.ctx))).not.toContain(started.deviceCode);
    expect(Date.parse(started.expiresAt) - Date.now()).toBeGreaterThan(CLIENT_GRANT_TTL_MS - MINUTE_MS);
    expect(Date.parse(started.expiresAt) - Date.now()).toBeLessThanOrEqual(CLIENT_GRANT_TTL_MS);
  });

  it('records what `fintrack login` would like pre-selected', async () => {
    const w = await world();
    await start(w, {
      client: { name: 'fintrack login', version: '0' },
      profile: 'work',
      channel: GrantChannel.enum.cli,
      hint: { access: 'write', duration: '7d' },
    });
    expect(await w.ctx.db.all(sql`SELECT hint_access, hint_duration, channel, profile FROM client_grants`)).toEqual([
      { hint_access: 'write', hint_duration: '7d', channel: 'cli', profile: 'work' },
    ]);
  });

  it('draws another user code when one collides with a still-pending request', async () => {
    const codes = ['AAAAAAAA', 'AAAAAAAA', 'BBBBBBBB'];
    const base = authDepsOf(await createApp());
    void base;
    const w = await world();
    const sequence = { ...w.deps.secrets, randomUserCode: () => codes.shift() ?? 'ZZZZZZZZ' };
    const deps = { ...w.deps, secrets: sequence };

    const first = await w.run(() => startGrant(deps, STDIO_REQUEST));
    const second = await w.run(() => startGrant(deps, STDIO_REQUEST));

    expect(first._unsafeUnwrap().userCode).toBe('AAAA-AAAA');
    expect(second._unsafeUnwrap().userCode).toBe('BBBB-BBBB');
  });

  it('turns a concurrently drawn duplicate code into a retryable conflict, not a raw constraint error', async () => {
    const w = await world();
    const sameCode = { ...w.deps, secrets: { ...w.deps.secrets, randomUserCode: () => 'AAAAAAAA' } };
    // Two requests that both saw 'AAAAAAAA' as free (as two racing processes would)…
    const first = (await startGrant(sameCode, STDIO_REQUEST))._unsafeUnwrap();
    const second = (await startGrant(sameCode, STDIO_REQUEST))._unsafeUnwrap();

    expect((await w.run(() => okAsync(first))).isOk()).toBe(true);
    // …the loser hits the partial unique index; the engine sees a VersionConflict (retry), never a thrown SQLite error.
    expect((await w.run(() => okAsync(second)))._unsafeUnwrapErr()).toEqual(conflict);
    expect(await w.ctx.db.all(sql`SELECT 1 FROM client_grants`)).toHaveLength(1);
  });

  it('fails instead of looping if it can never draw a free user code', async () => {
    const w = await world();
    const stuck = { ...w.deps, secrets: { ...w.deps.secrets, randomUserCode: () => 'AAAAAAAA' } };
    expect((await w.run(() => startGrant(stuck, STDIO_REQUEST))).isOk()).toBe(true);
    expect((await w.run(() => startGrant(stuck, STDIO_REQUEST)))._unsafeUnwrapErr()).toEqual(conflict);
  });
});

describe('approveGrant / denyGrant', () => {
  it('binds the approving user, the chosen scopes and duration, and mints no token yet', async () => {
    const w = await world();
    const started = await start(w);

    const approved = await w.run(() =>
      approveGrant(w.deps, w.session, {
        userCode: started.userCode,
        access: 'write',
        duration: '7d',
        password: PASSWORD,
      }),
    );

    expect(approved.isOk()).toBe(true);
    expect(await w.ctx.db.all(sql`SELECT status, user_id, scopes, duration FROM client_grants`)).toEqual([
      { status: 'approved', user_id: OWNER_USER_ID, scopes: '["fintrack:read","fintrack:write"]', duration: '7d' },
    ]);
    expect(await w.ctx.db.all(sql`SELECT 1 FROM access_tokens`)).toEqual([]);
  });

  it('takes the code however it was typed — case and dashes do not matter', async () => {
    const w = await world();
    const started = await start(w);
    const typed = started.userCode.toLowerCase().replace('-', ' ');
    expect(
      (
        await w.run(() =>
          approveGrant(w.deps, w.session, { userCode: typed, access: 'read', duration: '24h', password: PASSWORD }),
        )
      ).isOk(),
    ).toBe(true);
  });

  it.each([
    ['a personal access token', PrincipalVia.enum.token],
    ['a stdio sign-in', PrincipalVia.enum.stdio],
    ['the trusted owner', PrincipalVia.enum.owner],
  ])('refuses to approve for %s — only a browser session may', async (_label, via) => {
    const w = await world();
    const started = await start(w);
    const principal: Principal = { ...OWNER_PRINCIPAL, via };

    const answered = await w.run(() =>
      approveGrant(w.deps, principal, {
        userCode: started.userCode,
        access: 'write',
        duration: '30d',
        password: PASSWORD,
      }),
    );
    const denied = await w.run(() => denyGrant(w.deps, principal, started.userCode));

    expect(answered._unsafeUnwrapErr()).toEqual(authErrors.sessionRequired);
    expect(denied._unsafeUnwrapErr()).toEqual(authErrors.sessionRequired);
    expect(await w.ctx.db.all(sql`SELECT status FROM client_grants`)).toEqual([{ status: 'pending' }]);
  });

  it('treats an unknown code, an expired one and an already-answered one alike: invalid', async () => {
    const clock = movableClock();
    const w = await world({ clock: clock.now });
    const unknown = await w.run(() =>
      approveGrant(w.deps, w.session, { userCode: 'ZZZZ-ZZZZ', access: 'read', duration: '24h', password: PASSWORD }),
    );
    expect(unknown._unsafeUnwrapErr()).toEqual(authErrors.invalidGrant);

    const answered = await start(w);
    await w.run(() => denyGrant(w.deps, w.session, answered.userCode));
    const again = await w.run(() =>
      approveGrant(w.deps, w.session, {
        userCode: answered.userCode,
        access: 'read',
        duration: '24h',
        password: PASSWORD,
      }),
    );
    expect(again._unsafeUnwrapErr()).toEqual(authErrors.invalidGrant);

    const stale = await start(w);
    clock.advance(CLIENT_GRANT_TTL_MS);
    const late = await w.run(() =>
      approveGrant(w.deps, w.session, {
        userCode: stale.userCode,
        access: 'read',
        duration: '24h',
        password: PASSWORD,
      }),
    );
    expect(late._unsafeUnwrapErr()).toEqual(authErrors.invalidGrant);
  });

  it('cannot approve the same request twice', async () => {
    const w = await world();
    const started = await start(w);
    const first = await w.run(() =>
      approveGrant(w.deps, w.session, {
        userCode: started.userCode,
        access: 'read',
        duration: '24h',
        password: PASSWORD,
      }),
    );
    const second = await w.run(() =>
      approveGrant(w.deps, w.session, {
        userCode: started.userCode,
        access: 'write',
        duration: '30d',
        password: PASSWORD,
      }),
    );
    expect(first.isOk()).toBe(true);
    expect(second._unsafeUnwrapErr()).toEqual(authErrors.invalidGrant);
    expect(await w.ctx.db.all(sql`SELECT scopes, duration FROM client_grants`)).toEqual([
      { scopes: '["fintrack:read"]', duration: '24h' },
    ]);
  });

  it('refuses "this session only" for a request made by `fintrack login`, leaving it pending', async () => {
    const w = await world();
    const started = await start(w, { ...STDIO_REQUEST, channel: GrantChannel.enum.cli });
    const answered = await w.run(() =>
      approveGrant(w.deps, w.session, {
        userCode: started.userCode,
        access: 'read',
        duration: 'session',
        password: PASSWORD,
      }),
    );
    expect(answered._unsafeUnwrapErr()).toMatchObject({ code: 'validation' });
    expect(await w.ctx.db.all(sql`SELECT status FROM client_grants`)).toEqual([{ status: 'pending' }]);
  });

  it('denies, and a denial is terminal', async () => {
    const w = await world();
    const started = await start(w);
    expect((await w.run(() => denyGrant(w.deps, w.session, started.userCode))).isOk()).toBe(true);
    expect(await w.ctx.db.all(sql`SELECT status, user_id FROM client_grants`)).toEqual([
      { status: 'denied', user_id: null },
    ]);
    expect((await w.run(() => redeemGrant(w.deps, started.deviceCode)))._unsafeUnwrap()).toEqual({ kind: 'denied' });
    expect((await w.run(() => redeemGrant(w.deps, started.deviceCode)))._unsafeUnwrap()).toEqual({ kind: 'denied' });
    expect(await w.ctx.db.all(sql`SELECT 1 FROM access_tokens`)).toEqual([]);
  });
});

describe('redeemGrant', () => {
  const approve = (
    w: Awaited<ReturnType<typeof world>>,
    userCode: string,
    access: 'read' | 'write' = 'read',
    duration: '24h' | '7d' | '30d' | 'session' = '24h',
  ) => w.run(() => approveGrant(w.deps, w.session, { userCode, access, duration, password: PASSWORD }));

  it('says "pending" until a person answers, and writes nothing', async () => {
    const w = await world();
    const started = await start(w);
    expect((await w.run(() => redeemGrant(w.deps, started.deviceCode)))._unsafeUnwrap()).toEqual({ kind: 'pending' });
    expect(await w.ctx.db.all(sql`SELECT 1 FROM access_tokens`)).toEqual([]);
  });

  it('mints a stdio token once approved: plaintext returned, only the hash stored, grant marked redeemed', async () => {
    const w = await world();
    const started = await start(w);
    await approve(w, started.userCode, 'write', '7d');

    const result = signedIn((await w.run(() => redeemGrant(w.deps, started.deviceCode)))._unsafeUnwrap());

    expect(result.token).toMatch(/^ftk_[A-Za-z0-9_-]{43}$/);
    expect(result.scopes).toEqual(['fintrack:read', 'fintrack:write']);
    expect(result.duration).toBe('7d');
    const rows = await w.ctx.db.all<Record<string, unknown>>(sql`SELECT * FROM access_tokens`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: result.tokenId,
      user_id: OWNER_USER_ID,
      kind: 'stdio',
      client_name: 'Claude Desktop',
      profile: 'default',
      token_hash: w.deps.secrets.hashSecret(result.token),
      expires_at: result.expiresAt,
      revoked_at: null,
    });
    expect(JSON.stringify(await w.ctx.db.all(sql`SELECT * FROM access_tokens`))).not.toContain(result.token);
    expect(JSON.stringify(await dump(w.ctx))).not.toContain(result.token);
    expect(await w.ctx.db.all(sql`SELECT status FROM client_grants`)).toEqual([{ status: 'redeemed' }]);
  });

  it.each([
    ['session', 12],
    ['24h', 24],
    ['7d', 168],
    ['30d', 720],
  ] as const)('gives a %s sign-in an expiry %i hours after approval — never none', async (duration, hours) => {
    const w = await world();
    const started = await start(w);
    await approve(w, started.userCode, 'read', duration);
    const [grant] = await w.ctx.db.all<{ approved_at: string }>(sql`SELECT approved_at FROM client_grants`);
    const approved_at = grant!.approved_at;

    const result = signedIn((await w.run(() => redeemGrant(w.deps, started.deviceCode)))._unsafeUnwrap());

    expect(Date.parse(result.expiresAt) - Date.parse(approved_at)).toBe(hours * 60 * MINUTE_MS);
  });

  it('is single-use: the second redeem finds a spent grant and mints nothing', async () => {
    const w = await world();
    const started = await start(w);
    await approve(w, started.userCode);
    signedIn((await w.run(() => redeemGrant(w.deps, started.deviceCode)))._unsafeUnwrap());

    expect((await w.run(() => redeemGrant(w.deps, started.deviceCode)))._unsafeUnwrap()).toEqual({ kind: 'invalid' });
    expect(await w.ctx.db.all(sql`SELECT 1 FROM access_tokens`)).toHaveLength(1);
  });

  it('cannot mint twice from a stale view: replaying the first redemption is refused by the version', async () => {
    const w = await world();
    const started = await start(w);
    await approve(w, started.userCode);

    // Two redemptions that both read the grant while it was still approved (as two racing processes would).
    const first = (await redeemGrant(w.deps, started.deviceCode))._unsafeUnwrap();
    const second = (await redeemGrant(w.deps, started.deviceCode))._unsafeUnwrap();

    expect((await w.run(() => okAsync(first))).isOk()).toBe(true);
    expect((await w.run(() => okAsync(second)))._unsafeUnwrapErr()).toEqual(conflict);
    expect(await w.ctx.db.all(sql`SELECT 1 FROM access_tokens`)).toHaveLength(1);
    expect(await w.ctx.db.all(sql`SELECT status FROM client_grants`)).toEqual([{ status: 'redeemed' }]);
  });

  it('knows nothing about a device code it never issued', async () => {
    const w = await world();
    expect((await w.run(() => redeemGrant(w.deps, 'not-a-device-code')))._unsafeUnwrap()).toEqual({ kind: 'invalid' });
  });

  it('expires after the window — pending or approved — and the expiry is terminal and recorded', async () => {
    const clock = movableClock();
    const w = await world({ clock: clock.now });
    const stalePending = await start(w);
    const staleApproved = await start(w);
    await approve(w, staleApproved.userCode);
    clock.advance(CLIENT_GRANT_TTL_MS);

    expect((await w.run(() => redeemGrant(w.deps, stalePending.deviceCode)))._unsafeUnwrap()).toEqual({
      kind: 'expired',
    });
    expect((await w.run(() => redeemGrant(w.deps, staleApproved.deviceCode)))._unsafeUnwrap()).toEqual({
      kind: 'expired',
    });
    expect((await w.run(() => redeemGrant(w.deps, staleApproved.deviceCode)))._unsafeUnwrap()).toEqual({
      kind: 'expired',
    });
    expect(
      (await w.ctx.db.all<{ status: string }>(sql`SELECT status FROM client_grants`)).map((r) => r.status),
    ).toEqual(['expired', 'expired']);
    expect(await w.ctx.db.all(sql`SELECT 1 FROM access_tokens`)).toEqual([]);
  });

  it('mints nothing for an approver who can no longer log in', async () => {
    const w = await world();
    const started = await start(w);
    await approve(w, started.userCode);
    await w.ctx.db.run(sql`UPDATE users SET disabled_at = ${new Date().toISOString()}`);
    expect((await w.run(() => redeemGrant(w.deps, started.deviceCode)))._unsafeUnwrap()).toEqual({ kind: 'invalid' });
    expect(await w.ctx.db.all(sql`SELECT 1 FROM access_tokens`)).toEqual([]);
  });

  it('mints a token that works on the stdio channel and is refused as a bearer on /api', async () => {
    const w = await world();
    const started = await start(w);
    await approve(w, started.userCode, 'write');
    const { token } = signedIn((await w.run(() => redeemGrant(w.deps, started.deviceCode)))._unsafeUnwrap());
    const hash = w.deps.secrets.hashSecret(token);

    const viaStdio = (await w.run(() => authenticateToken(w.deps, hash, PrincipalVia.enum.stdio)))._unsafeUnwrap();
    expect(viaStdio).toMatchObject({ via: 'stdio', scopes: ['fintrack:read', 'fintrack:write'] });
    expect((await w.run(() => authenticateToken(w.deps, hash)))._unsafeUnwrap()).toBeNull();

    const status = await w.ctx.app.inject({
      method: 'GET',
      url: '/api/status',
      headers: { host: '127.0.0.1:51737', ...bearer(token) },
    });
    expect(status.statusCode).toBe(401);
    expect(AccessTokenKind.enum.stdio).toBe('stdio');
    expect(tokenPrincipal).toBeDefined();
  });
});

describe('findConsent — what the consent page shows and pre-selects', () => {
  it('describes a pending request and defaults to read-only for 24 hours', async () => {
    const w = await world();
    const started = await start(w);
    const consent = await findConsent(w.deps, OWNER_USER_ID, started.userCode.toLowerCase());
    expect(consent).toMatchObject({
      request: { userCode: started.userCode, clientName: 'Claude Desktop', clientVersion: '1.2.3', profile: 'default' },
      choice: { access: 'read', duration: '24h' },
    });
  });

  it('is null for an unknown, expired or answered code', async () => {
    const clock = movableClock();
    const w = await world({ clock: clock.now });
    const answered = await start(w);
    await w.run(() => denyGrant(w.deps, w.session, answered.userCode));
    const stale = await start(w);
    clock.advance(CLIENT_GRANT_TTL_MS);

    expect(await findConsent(w.deps, OWNER_USER_ID, 'ZZZZ-ZZZZ')).toBeNull();
    expect(await findConsent(w.deps, OWNER_USER_ID, answered.userCode)).toBeNull();
    expect(await findConsent(w.deps, OWNER_USER_ID, stale.userCode)).toBeNull();
  });

  it('remembers the last completed choice for the same client and profile — and only that', async () => {
    const w = await world();
    const first = await start(w);
    await w.run(() =>
      approveGrant(w.deps, w.session, {
        userCode: first.userCode,
        access: 'write',
        duration: '7d',
        password: PASSWORD,
      }),
    );
    await w.run(() => redeemGrant(w.deps, first.deviceCode));

    const again = await start(w);
    expect((await findConsent(w.deps, OWNER_USER_ID, again.userCode))?.choice).toEqual({
      access: 'write',
      duration: '7d',
    });

    const otherProfile = await start(w, { ...STDIO_REQUEST, profile: 'work' });
    expect((await findConsent(w.deps, OWNER_USER_ID, otherProfile.userCode))?.choice).toEqual({
      access: 'read',
      duration: '24h',
    });
    const otherClient = await start(w, { ...STDIO_REQUEST, client: { name: 'VS Code', version: '1' } });
    expect((await findConsent(w.deps, OWNER_USER_ID, otherClient.userCode))?.choice).toEqual({
      access: 'read',
      duration: '24h',
    });
  });

  it('remembers the most recently APPROVED choice, not the most recently requested', async () => {
    const w = await world();
    const older = await start(w); // requested first…
    const newer = await start(w); // …requested second
    await w.run(() =>
      approveGrant(w.deps, w.session, { userCode: newer.userCode, access: 'read', duration: '7d', password: PASSWORD }),
    );
    await w.run(() => redeemGrant(w.deps, newer.deviceCode));
    await new Promise((resolve) => setTimeout(resolve, 5));
    // …but the OLDER request is approved last, so it is the person's latest completed choice.
    await w.run(() =>
      approveGrant(w.deps, w.session, {
        userCode: older.userCode,
        access: 'write',
        duration: '30d',
        password: PASSWORD,
      }),
    );
    await w.run(() => redeemGrant(w.deps, older.deviceCode));

    const next = await start(w);
    expect((await findConsent(w.deps, OWNER_USER_ID, next.userCode))?.choice).toEqual({
      access: 'write',
      duration: '30d',
    });
  });

  it('does not remember an approval that was never redeemed, or a denial', async () => {
    const w = await world();
    const approvedOnly = await start(w);
    await w.run(() =>
      approveGrant(w.deps, w.session, {
        userCode: approvedOnly.userCode,
        access: 'write',
        duration: '30d',
        password: PASSWORD,
      }),
    );
    const denied = await start(w);
    await w.run(() => denyGrant(w.deps, w.session, denied.userCode));

    const next = await start(w);
    expect((await findConsent(w.deps, OWNER_USER_ID, next.userCode))?.choice).toEqual({
      access: 'read',
      duration: '24h',
    });
  });

  it('lets the asker’s hint win over the last choice', async () => {
    const w = await world();
    const first = await start(w);
    await w.run(() =>
      approveGrant(w.deps, w.session, {
        userCode: first.userCode,
        access: 'write',
        duration: '7d',
        password: PASSWORD,
      }),
    );
    await w.run(() => redeemGrant(w.deps, first.deviceCode));
    const hinted = await start(w, { ...STDIO_REQUEST, hint: { access: 'read', duration: '30d' } });
    expect((await findConsent(w.deps, OWNER_USER_ID, hinted.userCode))?.choice).toEqual({
      access: 'read',
      duration: '30d',
    });
  });
});

describe('pruneExpiredGrants', () => {
  it('deletes unredeemed grants past their window and keeps the rest', async () => {
    const clock = movableClock();
    const w = await world({ clock: clock.now });
    const redeemed = await start(w);
    await w.run(() =>
      approveGrant(w.deps, w.session, {
        userCode: redeemed.userCode,
        access: 'read',
        duration: '24h',
        password: PASSWORD,
      }),
    );
    await w.run(() => redeemGrant(w.deps, redeemed.deviceCode));
    await start(w);
    clock.advance(CLIENT_GRANT_TTL_MS + 1);
    const fresh = await start(w);

    const pruned = await w.run(() => pruneExpiredGrants(w.deps));

    expect(pruned._unsafeUnwrap()).toBe(1);
    const statuses = await w.ctx.db.all<{ status: string; user_code: string }>(
      sql`SELECT status, user_code FROM client_grants`,
    );
    expect(statuses.map((row) => row.status).sort()).toEqual(['pending', 'redeemed']);
    expect(statuses.find((row) => row.status === 'pending')?.user_code).toBe(fresh.userCode.replace('-', ''));
  });

  const redeem = async (
    w: Awaited<ReturnType<typeof world>>,
    input: StartGrantInput,
    choice: { access: 'read' | 'write'; duration: '24h' | '7d' | '30d' },
  ) => {
    const started = await start(w, input);
    await w.run(() => approveGrant(w.deps, w.session, { userCode: started.userCode, ...choice, password: PASSWORD }));
    await w.run(() => redeemGrant(w.deps, started.deviceCode));
    await new Promise((resolve) => setTimeout(resolve, 3)); // distinct approval times
    return started;
  };

  it('deletes redeemed grants superseded for the same client and profile, keeping the newest', async () => {
    const w = await world();
    await redeem(w, STDIO_REQUEST, { access: 'read', duration: '24h' });
    await redeem(w, STDIO_REQUEST, { access: 'read', duration: '7d' });
    await redeem(w, STDIO_REQUEST, { access: 'write', duration: '30d' });
    await redeem(w, { ...STDIO_REQUEST, profile: 'work' }, { access: 'read', duration: '24h' });
    await redeem(
      w,
      { ...STDIO_REQUEST, client: { name: 'VS Code', version: '1' } },
      { access: 'read', duration: '24h' },
    );

    const pruned = await w.run(() => pruneExpiredGrants(w.deps));

    expect(pruned._unsafeUnwrap()).toBe(2);
    const left = await w.ctx.db.all<{ profile: string; client_name: string; duration: string }>(
      sql`SELECT profile, client_name, duration FROM client_grants ORDER BY approved_at`,
    );
    expect(left).toHaveLength(3); // the newest per (profile, client): default/Claude Desktop, work, VS Code
    expect(left.filter((row) => row.client_name === 'Claude Desktop' && row.profile === 'default')).toEqual([
      { profile: 'default', client_name: 'Claude Desktop', duration: '30d' },
    ]);
  });

  it('keeps what the consent form remembers: lastRedeemed still returns the kept row after a prune', async () => {
    const w = await world();
    await redeem(w, STDIO_REQUEST, { access: 'read', duration: '7d' });
    await redeem(w, STDIO_REQUEST, { access: 'write', duration: '30d' });
    const before = await w.deps.clientGrants.lastRedeemed(OWNER_USER_ID, 'default', 'Claude Desktop');

    await w.run(() => pruneExpiredGrants(w.deps));

    const after = await w.deps.clientGrants.lastRedeemed(OWNER_USER_ID, 'default', 'Claude Desktop');
    expect(after?.id).toBe(before?.id);
    expect(after).toMatchObject({ scopes: ['fintrack:read', 'fintrack:write'], duration: '30d' });
  });

  it('never touches a live pending or approved grant, whatever redeemed ones exist beside it', async () => {
    const w = await world();
    await redeem(w, STDIO_REQUEST, { access: 'read', duration: '24h' });
    await redeem(w, STDIO_REQUEST, { access: 'read', duration: '7d' });
    const pending = await start(w);
    const approved = await start(w);
    await w.run(() =>
      approveGrant(w.deps, w.session, {
        userCode: approved.userCode,
        access: 'read',
        duration: '24h',
        password: PASSWORD,
      }),
    );

    await w.run(() => pruneExpiredGrants(w.deps));

    const codes = await w.ctx.db.all<{ status: string; user_code: string }>(
      sql`SELECT status, user_code FROM client_grants WHERE status IN ('pending', 'approved') ORDER BY status`,
    );
    expect(codes).toEqual([
      { status: 'approved', user_code: approved.userCode.replace('-', '') },
      { status: 'pending', user_code: pending.userCode.replace('-', '') },
    ]);
    // …and the approved one can still be redeemed afterwards.
    expect((await w.run(() => redeemGrant(w.deps, approved.deviceCode)))._unsafeUnwrap().kind).toBe('signed_in');
  });

  it('is idempotent: a second prune finds nothing more', async () => {
    const w = await world();
    await redeem(w, STDIO_REQUEST, { access: 'read', duration: '24h' });
    await redeem(w, STDIO_REQUEST, { access: 'read', duration: '7d' });
    expect((await w.run(() => pruneExpiredGrants(w.deps)))._unsafeUnwrap()).toBe(1);
    expect((await w.run(() => pruneExpiredGrants(w.deps)))._unsafeUnwrap()).toBe(0);
  });
});
