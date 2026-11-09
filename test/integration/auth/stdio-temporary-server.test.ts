import { errAsync } from 'neverthrow';
import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { conflict } from '../../../src/models/error.js';
import { STDIO_MESSAGES } from '../../../src/models/auth/message.js';
import {
  answerAt,
  approveConnect,
  claimOwner,
  countedTemporaryServer,
  memoryStore,
  movableClock,
  SIGN_IN_ORIGIN,
  stdioSessionFor,
  useAuthApp,
  userCodeIn,
} from './helpers.js';

const createApp = useAuthApp();

type Ctx = Awaited<ReturnType<typeof createApp>>;

const sessionWithTemporaryServer = async (options: Parameters<typeof stdioSessionFor>[1] = {}) => {
  const ctx = await createApp();
  const cookie = await claimOwner(ctx);
  const temporary = countedTemporaryServer(ctx);
  const made = stdioSessionFor(ctx, { origin: null, temporaryServer: temporary.start, ...options });
  return { ctx, cookie, temporary, ...made };
};

const stillServing = async (origin: string): Promise<boolean> =>
  fetch(`${origin}/api/health`).then(
    () => true,
    () => false,
  );

const originOf = (message: string): string => /(http:\/\/localhost:\d+)\/ui\/connect/.exec(message)![1]!;

afterEach(() => vi.useRealTimers());

describe('StdioSession — a sidecar that is not serving a link of its own', () => {
  it('asks the temporary page’s approver for the password too: a wrong one keeps the request pending', async () => {
    const { ctx, session } = await sessionWithTemporaryServer();
    try {
      const asked = await session.resolve();
      const origin = originOf(asked.kind === 'not_signed_in' ? asked.message : '');

      expect(await answerAt(origin, userCodeIn(asked), { decision: 'approve', password: 'not-the-password' })).toBe(
        403,
      );
      expect(await answerAt(origin, userCodeIn(asked), { decision: 'approve', password: null })).toBe(403);

      expect(await ctx.db.all(sql`SELECT status FROM client_grants`)).toEqual([{ status: 'pending' }]);
      expect(await session.resolve()).toMatchObject({ kind: 'not_signed_in' });
    } finally {
      await session.close();
    }
  });

  it('serves /ui/connect from a temporary server of its own; the link works end to end on THIS database', async () => {
    const { ctx, session, temporary } = await sessionWithTemporaryServer();

    const asked = await session.resolve();
    const message = asked.kind === 'not_signed_in' ? asked.message : '';
    const origin = originOf(message);
    const code = userCodeIn(asked);

    expect(temporary.counts).toEqual({ started: 1, closed: 0 });
    expect(message).toBe(
      `PATTY: not signed in. Open ${origin}/ui/connect?code=${code} and confirm the code ${code}.`,
    );
    expect(await answerAt(origin, code, { decision: 'approve', access: 'write' })).toBe(200);
    const signedIn = await session.resolve();
    expect(signedIn).toMatchObject({ kind: 'granted', principal: { via: 'stdio', userId: 'user-owner' } });
    // The grant and the token are rows of THIS database — the page that approved it opened the same one.
    expect(await ctx.db.all(sql`SELECT status FROM client_grants`)).toEqual([{ status: 'redeemed' }]);
    expect(await ctx.db.all(sql`SELECT kind FROM access_tokens`)).toEqual([{ kind: 'stdio' }]);
  });

  it('starts it once for the pending request: later calls name the same page and the same code', async () => {
    const { session, temporary } = await sessionWithTemporaryServer();
    const first = await session.resolve();
    const second = await session.resolve();
    expect(second).toEqual(first);
    expect(temporary.counts.started).toBe(1);
    await session.close();
  });

  it('closes it once the request is redeemed', async () => {
    const { session, temporary } = await sessionWithTemporaryServer();
    const asked = await session.resolve();
    const origin = originOf(asked.kind === 'not_signed_in' ? asked.message : '');
    await answerAt(origin, userCodeIn(asked), { decision: 'approve' });

    await session.resolve();

    expect(temporary.counts).toEqual({ started: 1, closed: 1 });
    expect(await stillServing(origin)).toBe(false);
  });

  it('closes it when the request is denied — and serves the next request from a fresh one', async () => {
    const { session, temporary } = await sessionWithTemporaryServer();
    const asked = await session.resolve();
    const origin = originOf(asked.kind === 'not_signed_in' ? asked.message : '');
    await answerAt(origin, userCodeIn(asked), { decision: 'deny' });

    const next = await session.resolve();

    expect(temporary.counts).toEqual({ started: 2, closed: 1 });
    expect(await stillServing(origin)).toBe(false);
    expect(originOf(next.kind === 'not_signed_in' ? next.message : '')).toBe(temporary.origins[1]);
    await session.close();
    expect(temporary.counts).toEqual({ started: 2, closed: 2 });
  });

  it('closes it when the request expires unanswered', async () => {
    const clock = movableClock();
    const { session, temporary } = await sessionWithTemporaryServer({ clock: clock.now });
    const asked = await session.resolve();
    const origin = originOf(asked.kind === 'not_signed_in' ? asked.message : '');

    clock.advance(11 * 60 * 1000);
    await session.resolve();

    expect(temporary.counts).toEqual({ started: 2, closed: 1 });
    expect(await stillServing(origin)).toBe(false);
    await session.close();
  });

  it('closes it on shutdown while a request is still pending', async () => {
    const { session, temporary } = await sessionWithTemporaryServer();
    const asked = await session.resolve();
    const origin = originOf(asked.kind === 'not_signed_in' ? asked.message : '');

    await session.close();

    expect(temporary.counts).toEqual({ started: 1, closed: 1 });
    expect(await stillServing(origin)).toBe(false);
  });

  it('closes it when creating the request throws outright, not just when it returns an error', async () => {
    const { session, temporary } = await sessionWithTemporaryServer({
      run: (() => Promise.reject(new Error('the database blew up'))) as never,
    });
    expect(await session.resolve()).toEqual({ kind: 'not_signed_in', message: STDIO_MESSAGES.cannotVerify });
    expect(temporary.counts).toEqual({ started: 1, closed: 1 });
  });

  it('starts nothing, and closes nothing, when the temporary server itself cannot start', async () => {
    const { session, temporary } = await sessionWithTemporaryServer({
      temporaryServer: () => Promise.reject(new Error('no port')),
    });
    expect(await session.resolve()).toEqual({ kind: 'not_signed_in', message: STDIO_MESSAGES.cannotVerify });
    expect(temporary.counts).toEqual({ started: 0, closed: 0 });
  });

  it('closes it when the request could not even be created', async () => {
    const { session, temporary } = await sessionWithTemporaryServer({ run: (() => errAsync(conflict)) as never });
    expect(await session.resolve()).toEqual({ kind: 'not_signed_in', message: STDIO_MESSAGES.cannotVerify });
    expect(temporary.counts).toEqual({ started: 1, closed: 1 });
  });
});

describe('StdioSession — when no temporary server is wanted', () => {
  const signedInBefore = async (ctx: Ctx, cookie: string) => {
    const first = stdioSessionFor(ctx);
    await approveConnect(ctx, cookie, userCodeIn(await first.session.resolve()));
    await first.session.resolve();
    return first.store;
  };

  it('starts none when a saved sign-in is valid', async () => {
    const ctx = await createApp();
    const cookie = await claimOwner(ctx);
    const store = await signedInBefore(ctx, cookie);
    const temporary = countedTemporaryServer(ctx);
    const { session } = stdioSessionFor(ctx, { store, origin: null, temporaryServer: temporary.start });

    expect((await session.resolve()).kind).toBe('granted');
    expect(temporary.counts.started).toBe(0);
  });

  it('starts none under PATTY_TOKEN, valid or not', async () => {
    const ctx = await createApp();
    await claimOwner(ctx);
    const temporary = countedTemporaryServer(ctx);
    const { session } = stdioSessionFor(ctx, {
      envToken: 'ptk_not-a-real-token',
      origin: null,
      temporaryServer: temporary.start,
    });
    expect((await session.resolve()).kind).toBe('not_signed_in');
    expect(temporary.counts.started).toBe(0);
  });

  it('starts none when the sidecar (or PUBLIC_URL) already names a page', async () => {
    const ctx = await createApp();
    await claimOwner(ctx);
    const temporary = countedTemporaryServer(ctx);
    const { session } = stdioSessionFor(ctx, { origin: SIGN_IN_ORIGIN, temporaryServer: temporary.start });
    const asked = await session.resolve();
    expect(asked).toMatchObject({ message: expect.stringContaining(SIGN_IN_ORIGIN) });
    expect(temporary.counts.started).toBe(0);
    await session.close();
  });

  it('starts none when HTTP is off (no temporaryServer): the message points to login / PATTY_TOKEN', async () => {
    const ctx = await createApp();
    await claimOwner(ctx);
    const { session } = stdioSessionFor(ctx, { origin: null, store: memoryStore() });
    expect(await session.resolve()).toEqual({ kind: 'not_signed_in', message: STDIO_MESSAGES.notSignedInWithoutHttp });
  });
});
