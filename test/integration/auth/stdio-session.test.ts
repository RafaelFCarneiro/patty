import { errAsync, ResultAsync } from 'neverthrow';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { keychainFailures, GRANT_POLL_INTERVAL_MS } from '../../../src/models/auth/sign-in.js';
import { conflict } from '../../../src/models/error.js';
import type { SignInDuration } from '../../../src/models/auth/grant.js';
import { STDIO_MESSAGES } from '../../../src/models/auth/message.js';
import { NPX_COMMAND } from '../../../src/models/package.js';
import type { GateOutcome } from '../../../src/diplomat/mcp/gate.js';
import {
  answerConnect,
  approveConnect,
  authDepsOf,
  browserHeaders,
  claimOwner,
  memoryStore,
  mintToken,
  movableClock,
  SIGN_IN_ORIGIN,
  stdioSessionFor,
  useAuthApp,
  userCodeIn,
} from './helpers.js';

const createApp = useAuthApp();

const HOUR_MS = 60 * 60 * 1000;
const READ = 'fintrack:read';
const WRITE = 'fintrack:write';

afterEach(() => vi.useRealTimers());

const granted = (outcome: GateOutcome): readonly string[] => {
  if (outcome.kind !== 'granted') throw new Error(`expected granted, got ${JSON.stringify(outcome)}`);
  return outcome.principal.scopes;
};

const grantRows = (ctx: Awaited<ReturnType<typeof createApp>>) =>
  ctx.db.all<{ status: string; client_name: string; profile: string; channel: string; user_code: string }>(
    sql`SELECT status, client_name, profile, channel, user_code FROM client_grants ORDER BY created_at`,
  );

const tokenRows = (ctx: Awaited<ReturnType<typeof createApp>>) =>
  ctx.db.all<{
    kind: string;
    client_name: string | null;
    profile: string | null;
    expires_at: string | null;
    revoked_at: string | null;
    scopes: string;
  }>(sql`SELECT kind, client_name, profile, expires_at, revoked_at, scopes FROM access_tokens`);

/** Sign in the way a person does: ask, follow the link, approve, call again. */
const signInVia = async (
  ctx: Awaited<ReturnType<typeof createApp>>,
  cookie: string,
  session: ReturnType<typeof stdioSessionFor>['session'],
  choice: { access?: 'read' | 'write'; duration?: SignInDuration } = {},
) => {
  const asked = await session.resolve();
  await approveConnect(ctx, cookie, userCodeIn(asked), choice);
  return granted(await session.resolve());
};

describe('StdioSession — not signed in', () => {
  it('asks once, with the link and the code, and reuses the same request on the next call', async () => {
    const ctx = await createApp();
    await claimOwner(ctx);
    const { session } = stdioSessionFor(ctx);

    const first = await session.resolve();
    const second = await session.resolve();

    expect(first.kind).toBe('not_signed_in');
    expect(first).toEqual(second);
    const code = userCodeIn(first);
    expect(first).toMatchObject({
      message: `FinTrack: not signed in. Open ${SIGN_IN_ORIGIN}/ui/connect?code=${code} and confirm the code ${code}.`,
    });
    expect(await grantRows(ctx)).toEqual([
      {
        status: 'pending',
        client_name: 'Claude Desktop',
        profile: 'default',
        channel: 'stdio',
        user_code: code.replace('-', ''),
      },
    ]);
  });

  it('puts nothing secret in the message: no device code, no token, no hash', async () => {
    const ctx = await createApp();
    await claimOwner(ctx);
    const { session } = stdioSessionFor(ctx);
    const outcome = await session.resolve();
    const [grant] = await ctx.db.all<{ device_code_hash: string }>(sql`SELECT device_code_hash FROM client_grants`);
    const device_code_hash = grant!.device_code_hash;
    const text = JSON.stringify(outcome);
    expect(text).not.toContain(device_code_hash);
    expect(text).not.toMatch(/ftk_/);
    expect(text).not.toMatch(/[A-Za-z0-9_-]{43}/);
  });

  it('appends where to claim the owner while nobody has', async () => {
    const ctx = await createApp();
    const { session } = stdioSessionFor(ctx);
    const outcome = await session.resolve();
    expect(outcome).toMatchObject({ kind: 'not_signed_in' });
    expect(JSON.stringify(outcome)).toContain(`Owner not set up yet? Run \`${NPX_COMMAND} auth setup\`.`);
  });

  it('says to use `login` or FINTRACK_TOKEN, with no link and no grant, when there is no HTTP server', async () => {
    const ctx = await createApp();
    await claimOwner(ctx);
    const { session } = stdioSessionFor(ctx, { origin: null });
    expect(await session.resolve()).toEqual({ kind: 'not_signed_in', message: STDIO_MESSAGES.notSignedInWithoutHttp });
    expect(await grantRows(ctx)).toEqual([]);
  });

  it('reports the client name and version the MCP client gave in initialize, cleaned', async () => {
    const ctx = await createApp();
    await claimOwner(ctx);
    const { session } = stdioSessionFor(ctx, { clientInfo: { name: 'Evil\nClient', version: '9.9' } });
    await session.resolve();
    expect((await grantRows(ctx))[0]?.client_name).toBe('Evil Client');
  });

  it('starts a fresh request once the pending one is denied', async () => {
    const ctx = await createApp();
    const cookie = await claimOwner(ctx);
    const { session } = stdioSessionFor(ctx);
    const firstCode = userCodeIn(await session.resolve());
    expect((await answerConnect(ctx, cookie, firstCode, { decision: 'deny' })).statusCode).toBe(200);

    const next = await session.resolve();
    expect(next.kind).toBe('not_signed_in');
    expect(userCodeIn(next)).not.toBe(firstCode);
    expect((await grantRows(ctx)).map((row) => row.status)).toEqual(['denied', 'pending']);
  });

  it('starts a fresh request once the pending one has expired', async () => {
    const ctx = await createApp();
    await claimOwner(ctx);
    const clock = movableClock();
    const { session } = stdioSessionFor(ctx, { clock: clock.now });
    const firstCode = userCodeIn(await session.resolve());
    clock.advance(11 * 60 * 1000);

    expect(userCodeIn(await session.resolve())).not.toBe(firstCode);
    expect((await grantRows(ctx)).map((row) => row.status)).toEqual(['expired', 'pending']);
  });
});

describe('StdioSession — signing in', () => {
  it('lets the next call through once the person approves, and saves a 24 hour sign-in to the keychain', async () => {
    const ctx = await createApp();
    const cookie = await claimOwner(ctx);
    const { session, store } = stdioSessionFor(ctx);

    expect(await signInVia(ctx, cookie, session, { access: 'write', duration: '24h' })).toEqual([READ, WRITE]);

    const saved = store.saved();
    expect(saved).toMatch(/^ftk_/);
    expect(store.calls.save).toBe(1);
    const [row, ...others] = await tokenRows(ctx);
    expect(others).toEqual([]);
    expect(row).toMatchObject({ kind: 'stdio', client_name: 'Claude Desktop', profile: 'default', revoked_at: null });
    // Only the hash is in the database; the plaintext went to the keychain.
    expect(JSON.stringify(await ctx.db.all(sql`SELECT * FROM access_tokens`))).not.toContain(saved);
    expect((await grantRows(ctx)).map((r) => r.status)).toEqual(['redeemed']);
  });

  it('honors a read-only choice', async () => {
    const ctx = await createApp();
    const cookie = await claimOwner(ctx);
    const { session } = stdioSessionFor(ctx);
    expect(await signInVia(ctx, cookie, session, { access: 'read' })).toEqual([READ]);
  });

  it('expires every sign-in within the window chosen, counted from approval', async () => {
    const ctx = await createApp();
    const cookie = await claimOwner(ctx);
    for (const [duration, hours] of [
      ['session', 12],
      ['24h', 24],
      ['7d', 168],
      ['30d', 720],
    ] as const) {
      const before = Date.now();
      await signInVia(ctx, cookie, stdioSessionFor(ctx).session, { duration });
      const rows = await tokenRows(ctx);
      const newest = rows.at(-1);
      const expires = Date.parse(newest?.expires_at ?? '');
      expect(expires, duration).toBeGreaterThan(before + hours * HOUR_MS - 1);
      expect(expires, duration).toBeLessThanOrEqual(Date.now() + hours * HOUR_MS);
    }
    expect((await tokenRows(ctx)).every((row) => row.expires_at !== null)).toBe(true);
  });

  it('adopts the approval on its own poll, before any further call, and saves it', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const ctx = await createApp();
    const cookie = await claimOwner(ctx);
    const { session, store } = stdioSessionFor(ctx);
    const code = userCodeIn(await session.resolve());
    await approveConnect(ctx, cookie, code, { duration: '7d' });

    await vi.advanceTimersByTimeAsync(GRANT_POLL_INTERVAL_MS);
    await vi.waitFor(() => expect(store.saved()).toMatch(/^ftk_/));
    expect(vi.getTimerCount()).toBe(0); // polling stopped once signed in
    await session.close();
  });

  it('keeps polling on an interval that does not hold the process open', async () => {
    const ctx = await createApp();
    await claimOwner(ctx);
    const { session } = stdioSessionFor(ctx);
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    await session.resolve();
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), GRANT_POLL_INTERVAL_MS);
    const timer = setIntervalSpy.mock.results[0]?.value as NodeJS.Timeout;
    expect(timer.hasRef()).toBe(false);
    setIntervalSpy.mockRestore();
    await session.close();
  });

  it('never approves for the wrong person: the grant binds the user who approved it', async () => {
    const ctx = await createApp();
    const cookie = await claimOwner(ctx);
    const { session } = stdioSessionFor(ctx);
    await signInVia(ctx, cookie, session);
    const [grant] = await ctx.db.all<{ user_id: string }>(sql`SELECT user_id FROM client_grants`);
    const [token] = await ctx.db.all<{ user_id: string }>(sql`SELECT user_id FROM access_tokens`);
    expect(grant?.user_id).toBe('user-owner');
    expect(token?.user_id).toBe('user-owner');
  });
});

describe('StdioSession — the principal it grants', () => {
  const principalOf = (outcome: GateOutcome) => {
    if (outcome.kind !== 'granted') throw new Error(`expected granted, got ${JSON.stringify(outcome)}`);
    return outcome.principal;
  };

  it('is the whole principal (user, role, scopes, via stdio, token id), however the credential was found', async () => {
    const ctx = await createApp();
    const cookie = await claimOwner(ctx);
    const first = stdioSessionFor(ctx);
    await signInVia(ctx, cookie, first.session, { access: 'write' });
    const [row] = await ctx.db.all<{ id: string }>(sql`SELECT id FROM access_tokens WHERE kind = 'stdio'`);
    const expected = { userId: 'user-owner', role: 'admin', scopes: [READ, WRITE], via: 'stdio', tokenId: row!.id };

    expect(principalOf(await first.session.resolve())).toEqual(expected); // adopted from the grant, then re-validated
    const restarted = stdioSessionFor(ctx, { store: first.store });
    expect(principalOf(await restarted.session.resolve())).toEqual(expected); // restored from the keychain

    const { token, id } = await mintToken(ctx, cookie, { access: 'read' });
    const viaEnv = stdioSessionFor(ctx, { envToken: token });
    expect(principalOf(await viaEnv.session.resolve())).toEqual({ ...expected, scopes: [READ], tokenId: id });
  });

  it('is handed out right after the approval is redeemed, without a second lookup', async () => {
    const ctx = await createApp();
    const cookie = await claimOwner(ctx);
    const { session } = stdioSessionFor(ctx);
    const asked = await session.resolve();
    await approveConnect(ctx, cookie, userCodeIn(asked), { access: 'read' });
    expect(principalOf(await session.resolve())).toMatchObject({ userId: 'user-owner', via: 'stdio', scopes: [READ] });
  });
});

describe('StdioSession — "this session only"', () => {
  it('never writes to the keychain, and keeps working from memory', async () => {
    const ctx = await createApp();
    const cookie = await claimOwner(ctx);
    const { session, store } = stdioSessionFor(ctx);

    await signInVia(ctx, cookie, session, { duration: 'session' });
    granted(await session.resolve());
    granted(await session.resolve());

    expect(store.saved()).toBeNull();
    expect(store.calls.save).toBe(0);
    expect(store.calls.clear).toBe(0);
  });

  it('revokes that sign-in when the session closes, so a restart asks again', async () => {
    const ctx = await createApp();
    const cookie = await claimOwner(ctx);
    const { session } = stdioSessionFor(ctx);
    await signInVia(ctx, cookie, session, { duration: 'session' });
    expect((await tokenRows(ctx))[0]?.revoked_at).toBeNull();

    await session.close();

    expect((await tokenRows(ctx))[0]?.revoked_at).not.toBeNull();
    const restarted = stdioSessionFor(ctx).session;
    expect((await restarted.resolve()).kind).toBe('not_signed_in');
  });

  it('leaves a saved sign-in alone on close', async () => {
    const ctx = await createApp();
    const cookie = await claimOwner(ctx);
    const { session, store } = stdioSessionFor(ctx);
    await signInVia(ctx, cookie, session, { duration: '24h' });

    await session.close();

    expect((await tokenRows(ctx))[0]?.revoked_at).toBeNull();
    expect(store.saved()).toMatch(/^ftk_/);
  });
});

describe('StdioSession — a keychain that will not keep the sign-in', () => {
  it('holds it in memory only and revokes it at close, rather than leave a live token nothing can find', async () => {
    const ctx = await createApp();
    const cookie = await claimOwner(ctx);
    const { session, store } = stdioSessionFor(ctx, { store: memoryStore(null, { refuseSave: true }) });

    await signInVia(ctx, cookie, session, { duration: '30d' });
    granted(await session.resolve()); // still works for this process
    expect(store.saved()).toBeNull();
    expect((await tokenRows(ctx))[0]?.revoked_at).toBeNull();

    await session.close();

    expect((await tokenRows(ctx))[0]?.revoked_at).not.toBeNull();
  });
});

describe('StdioSession — an unreadable keychain', () => {
  it('carries on as if nothing were saved: asks in the browser, and holds the sign-in in memory', async () => {
    const ctx = await createApp();
    const cookie = await claimOwner(ctx);
    const store = memoryStore(null, { refuseSave: true });
    store.load = () => errAsync(keychainFailures.unavailable(new Error('locked')));
    const { session } = stdioSessionFor(ctx, { store });

    expect((await session.resolve()).kind).toBe('not_signed_in');
    expect(await signInVia(ctx, cookie, session)).toEqual([READ]);
  });
});

describe('StdioSession — restart and the keychain', () => {
  it('is silently signed in on a restart, from the saved sign-in alone', async () => {
    const ctx = await createApp();
    const cookie = await claimOwner(ctx);
    const first = stdioSessionFor(ctx);
    await signInVia(ctx, cookie, first.session, { access: 'write' });

    const restarted = stdioSessionFor(ctx, { store: first.store });
    expect(granted(await restarted.session.resolve())).toEqual([READ, WRITE]);
    expect(await grantRows(ctx)).toHaveLength(1); // no new request
  });

  it('deletes a saved credential that turns out invalid, and asks again', async () => {
    const ctx = await createApp();
    await claimOwner(ctx);
    const store = memoryStore('ftk_not-a-credential-anyone-issued');
    const { session } = stdioSessionFor(ctx, { store });

    const outcome = await session.resolve();

    expect(outcome.kind).toBe('not_signed_in');
    expect(userCodeIn(outcome)).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(store.saved()).toBeNull();
  });

  it('does not delete a newer sign-in another process saved meanwhile — it picks that one up', async () => {
    const ctx = await createApp();
    const cookie = await claimOwner(ctx);
    const mine = stdioSessionFor(ctx);
    await signInVia(ctx, cookie, mine.session, { access: 'read' });
    const [mine1] = await ctx.db.all<{ id: string }>(sql`SELECT id FROM access_tokens`);
    const myTokenId = mine1!.id;

    // `fintrack login` in another terminal saves a fresh, valid sign-in; mine is then revoked.
    const other = stdioSessionFor(ctx, { store: memoryStore() });
    await signInVia(ctx, cookie, other.session, { access: 'write' });
    const theirs = other.store.saved()!;
    await mine.store.save(theirs);
    await ctx.app.inject({
      method: 'POST',
      url: `/ui/access/tokens/${myTokenId}/revoke`,
      headers: browserHeaders(cookie),
    });

    expect(granted(await mine.session.resolve())).toEqual([READ, WRITE]);
    expect(mine.store.saved()).toBe(theirs);
    expect(mine.store.calls.clear).toBe(0);
  });

  it('does not delete a newer sign-in saved by a concurrent login while the invalid one is checked', async () => {
    const ctx = await createApp();
    await claimOwner(ctx);
    const newer = 'ftk_saved-by-a-concurrent-login';
    const store = memoryStore('ftk_not-a-credential-anyone-issued');
    const load = store.load.bind(store);
    let loads = 0;
    store.load = () =>
      ResultAsync.fromSafePromise(
        (async () => {
          loads += 1;
          if (loads === 2) await store.save(newer); // lands after the first look, before the compare-before-clear
          return (await load())._unsafeUnwrap();
        })(),
      );
    const { session } = stdioSessionFor(ctx, { store });

    await session.resolve();

    expect(store.saved()).toBe(newer);
    expect(store.calls.clear).toBe(0);
  });

  it('flips to not signed in on the very next call once the sign-in is revoked', async () => {
    const ctx = await createApp();
    const cookie = await claimOwner(ctx);
    const { session, store } = stdioSessionFor(ctx);
    await signInVia(ctx, cookie, session);
    granted(await session.resolve());

    const [row] = await ctx.db.all<{ id: string }>(sql`SELECT id FROM access_tokens`);
    const id = row!.id;
    const revoke = await ctx.app.inject({
      method: 'POST',
      url: `/ui/access/tokens/${id}/revoke`,
      headers: browserHeaders(cookie),
    });
    expect(revoke.statusCode).toBe(303);

    const next = await session.resolve();
    expect(next.kind).toBe('not_signed_in');
    expect(next).toMatchObject({ message: expect.stringContaining('/ui/connect?code=') });
    expect(store.saved()).toBeNull();
  });

  it('flips to not signed in once the sign-in expires — the choice is exactly what they get', async () => {
    const ctx = await createApp();
    const cookie = await claimOwner(ctx);
    const clock = movableClock();
    const { session, store } = stdioSessionFor(ctx, { clock: clock.now });
    await signInVia(ctx, cookie, session, { duration: '24h' });

    clock.advance(23 * HOUR_MS);
    granted(await session.resolve());
    clock.advance(2 * HOUR_MS);
    expect((await session.resolve()).kind).toBe('not_signed_in');
    expect(store.saved()).toBeNull();
  });

  it('never slides the expiry: use does not extend a sign-in', async () => {
    const ctx = await createApp();
    const cookie = await claimOwner(ctx);
    const clock = movableClock();
    const { session } = stdioSessionFor(ctx, { clock: clock.now });
    await signInVia(ctx, cookie, session, { duration: '24h' });
    const [first] = await tokenRows(ctx);
    const before = first!.expires_at;

    for (let hour = 0; hour < 20; hour += 1) {
      clock.advance(HOUR_MS);
      granted(await session.resolve());
    }
    expect((await tokenRows(ctx))[0]?.expires_at).toBe(before);
  });

  it('does not sign in when the person’s account can no longer log in', async () => {
    const ctx = await createApp();
    const cookie = await claimOwner(ctx);
    const { session } = stdioSessionFor(ctx);
    await signInVia(ctx, cookie, session);
    await ctx.db.run(sql`UPDATE users SET disabled_at = ${new Date().toISOString()}`);
    expect((await session.resolve()).kind).toBe('not_signed_in');
  });
});

describe('StdioSession — FINTRACK_TOKEN', () => {
  it('signs in with a valid token, with its scopes, and starts no sign-in request', async () => {
    const ctx = await createApp();
    const cookie = await claimOwner(ctx);
    const { token } = await mintToken(ctx, cookie, { access: 'read' });
    const { session, store } = stdioSessionFor(ctx, { envToken: token });

    expect(granted(await session.resolve())).toEqual([READ]);
    expect(await grantRows(ctx)).toEqual([]);
    expect(store.calls).toEqual({ load: 0, save: 0, clear: 0 });
  });

  it('beats a saved sign-in: env > keychain > none', async () => {
    const ctx = await createApp();
    const cookie = await claimOwner(ctx);
    const saved = stdioSessionFor(ctx);
    await signInVia(ctx, cookie, saved.session, { access: 'write' });
    const { token } = await mintToken(ctx, cookie, { access: 'read' });

    const { session } = stdioSessionFor(ctx, { envToken: token, store: saved.store });
    expect(granted(await session.resolve())).toEqual([READ]); // the env token's, not the keychain's [read, write]
  });

  it('is an error — never a fallback — when the token is revoked, even with a valid sign-in saved', async () => {
    const ctx = await createApp();
    const cookie = await claimOwner(ctx);
    const saved = stdioSessionFor(ctx);
    await signInVia(ctx, cookie, saved.session);
    const { token, id } = await mintToken(ctx, cookie);
    const { session, store } = stdioSessionFor(ctx, { envToken: token, store: saved.store });
    granted(await session.resolve());

    await ctx.app.inject({
      method: 'POST',
      url: `/ui/access/tokens/${id}/revoke`,
      headers: browserHeaders(cookie),
    });

    expect(await session.resolve()).toEqual({ kind: 'not_signed_in', message: STDIO_MESSAGES.invalidEnvToken });
    expect(store.saved()).toBe(saved.store.saved()); // the keychain is untouched
    expect((await grantRows(ctx)).map((row) => row.status)).toEqual(['redeemed']); // and no new request began
  });

  it.each(['ftk_totally-made-up', 'not-even-shaped-like-one', `ftk_${'a'.repeat(400)}`])(
    'refuses %j with the invalid-token message and never touches the keychain',
    async (envToken) => {
      const ctx = await createApp();
      await claimOwner(ctx);
      const { session, store } = stdioSessionFor(ctx, { envToken, store: memoryStore('ftk_some-saved-sign-in') });
      expect(await session.resolve()).toEqual({ kind: 'not_signed_in', message: STDIO_MESSAGES.invalidEnvToken });
      expect(store.calls).toEqual({ load: 0, save: 0, clear: 0 });
      expect(await grantRows(ctx)).toEqual([]);
    },
  );

  it('never echoes the token it rejected', async () => {
    const ctx = await createApp();
    await claimOwner(ctx);
    const { session } = stdioSessionFor(ctx, { envToken: 'ftk_secret-looking-value' });
    expect(JSON.stringify(await session.resolve())).not.toContain('secret-looking-value');
  });

  it('expires with the token', async () => {
    const ctx = await createApp();
    const cookie = await claimOwner(ctx);
    const { token } = await mintToken(ctx, cookie, { expiry: '30' });
    const clock = movableClock();
    const { session } = stdioSessionFor(ctx, { envToken: token, clock: clock.now });
    granted(await session.resolve());
    clock.advance(31 * 24 * HOUR_MS);
    expect((await session.resolve()).kind).toBe('not_signed_in');
  });
});

describe('StdioSession — an error is not a sign-out', () => {
  it('says it could not check, and forgets nothing, when the database cannot be read right now', async () => {
    const ctx = await createApp();
    const cookie = await claimOwner(ctx);
    const saved = stdioSessionFor(ctx);
    await signInVia(ctx, cookie, saved.session);
    const failing = stdioSessionFor(ctx, { store: saved.store, run: (() => errAsync(conflict)) as never });

    expect(await failing.session.resolve()).toEqual({ kind: 'not_signed_in', message: STDIO_MESSAGES.cannotVerify });
    expect(saved.store.saved()).toMatch(/^ftk_/);
    expect(authDepsOf(ctx)).toBeDefined();
  });
});
