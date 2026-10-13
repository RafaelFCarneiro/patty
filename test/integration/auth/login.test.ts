import type { AddressInfo } from 'node:net';
import { sql } from 'drizzle-orm';
import { errAsync } from 'neverthrow';
import { KeychainUnavailableError } from '../../../src/common/keychain.js';
import { describe, expect, it, vi } from 'vitest';
import type { CliIo, Shell } from '../../../src/authCli.js';
import { bindAuthRunEffects } from '../../../src/authRuntime.js';
import { EXIT_FAILURE, EXIT_INTERRUPTED, EXIT_OK } from '../../../src/common/cli.js';
import { loadConfig } from '../../../src/config.js';
import type { Terminal } from '../../../src/diplomat/cli/terminal.js';
import { LOGIN_MESSAGES, offerSignIn, runLogin, runLogout } from '../../../src/loginCli.js';
import { conflict } from '../../../src/models/error.js';
import { AUTH_MESSAGES, GRANT_POLL_INTERVAL_MS, NPX_COMMAND } from '../../../src/models/auth.js';
import { startSignInServer } from '../../../src/signInServer.js';
import type { AppContext } from '../app-builder.js';
import {
  authDepsOf,
  answerConnect,
  claimOwner,
  LOOPBACK_ORIGIN,
  memoryStore,
  mintToken,
  useAuthApp,
  type MemoryStore,
} from './helpers.js';

const createApp = useAuthApp();

const LINK = /Open (\S+\/ui\/connect\?code=([0-9A-Z]{4}-[0-9A-Z]{4})) and confirm the code ([0-9A-Z]{4}-[0-9A-Z]{4})\./;

type Setup = {
  /** What the person at the browser does each time the command waits: approve/deny the pending request, or nothing. */
  whenWaiting?: (code: string, ctx: AppContext, cookie: string) => Promise<void> | void;
  authRequired?: boolean;
  defaultProfile?: string;
  store?: MemoryStore;
  terminal?: Terminal | null;
  claimed?: boolean;
};

const rig = async (setup: Setup = {}) => {
  const ctx = await createApp();
  const cookie = setup.claimed === false ? '' : await claimOwner(ctx);
  const out: string[] = [];
  const err: string[] = [];
  const stores = new Map<string, MemoryStore>();
  const storeFor = (profile: string): MemoryStore => {
    if (!stores.has(profile)) stores.set(profile, profile === 'default' && setup.store ? setup.store : memoryStore());
    return stores.get(profile)!;
  };
  const interrupt = new AbortController();
  const server = { origin: LOOPBACK_ORIGIN, close: vi.fn(async () => undefined) };
  const shell: Shell = {
    deps: authDepsOf(ctx),
    run: bindAuthRunEffects(ctx.runEffects),
    close: vi.fn(),
    authRequired: setup.authRequired ?? true,
    defaultProfile: setup.defaultProfile ?? 'default',
    store: storeFor,
    startServer: vi.fn(async () => server),
  };
  const waits: number[] = [];
  const io: CliIo = {
    openShell: vi.fn(async () => shell),
    openTerminal: () => setup.terminal ?? null,
    readPasswordFromStdin: async () => '',
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    version: '1.2.3',
    wait: async (ms, signal) => {
      waits.push(ms);
      const code = [...out.join('\n').matchAll(new RegExp(LINK, 'g'))].at(-1)?.[3];
      if (code && setup.whenWaiting) await setup.whenWaiting(code, ctx, cookie);
      if (signal.aborted) return;
    },
    interruptSignal: () => interrupt.signal,
  };
  return { ctx, cookie, out, err, io, shell, server, stores, storeFor, waits, interrupt };
};

const approve =
  (choice: { access?: 'read' | 'write'; duration?: '24h' | '7d' | '30d' } = {}) =>
  async (code: string, ctx: AppContext, cookie: string) => {
    await answerConnect(ctx, cookie, code, { decision: 'approve', ...choice });
  };

const grants = (ctx: AppContext) =>
  ctx.db.all<Record<string, unknown>>(
    sql`SELECT status, profile, channel, client_name, client_version, hint_access, hint_duration FROM client_grants`,
  );

describe('fintrack login', () => {
  it('prints the link and the code, waits for the approval, and saves the sign-in to the keychain', async () => {
    const r = await rig({ whenWaiting: approve({ access: 'write', duration: '7d' }) });

    const exit = await runLogin([], r.io);

    expect(exit).toBe(EXIT_OK);
    const [, link, linkCode, code] = LINK.exec(r.out.join('\n'))!;
    expect(link).toBe(`${LOOPBACK_ORIGIN}/ui/connect?code=${linkCode}`);
    expect(code).toBe(linkCode);
    expect(r.out).toContain(LOGIN_MESSAGES.waiting);
    expect(r.out.at(-1)).toMatch(/^Signed in on profile "default" \(write\) until \d{4}-\d{2}-\d{2}T/);
    expect(r.storeFor('default').saved()).toMatch(/^ftk_/);
    expect(r.waits).toEqual([GRANT_POLL_INTERVAL_MS]);
    expect(r.err).toEqual([]);
    expect(r.server.close).toHaveBeenCalledOnce();
    expect(r.shell.close).toHaveBeenCalledOnce();
  });

  it('reports itself as `fintrack login` with this build’s version, over the cli channel', async () => {
    const r = await rig({ whenWaiting: approve() });
    await runLogin([], r.io);
    expect(await grants(r.ctx)).toEqual([
      {
        status: 'redeemed',
        profile: 'default',
        channel: 'cli',
        client_name: 'fintrack login',
        client_version: '1.2.3',
        hint_access: null,
        hint_duration: null,
      },
    ]);
  });

  it('never prints the device code or the token', async () => {
    const r = await rig({ whenWaiting: approve() });
    await runLogin([], r.io);
    const saved = r.storeFor('default').saved()!;
    const printed = [...r.out, ...r.err].join('\n');
    expect(printed).not.toContain(saved);
    expect(printed).not.toMatch(/ftk_/);
    expect(printed).not.toMatch(/[A-Za-z0-9_-]{43}/);
  });

  it('signs in as the profile asked for, and pre-selects the scope and duration it was given', async () => {
    const r = await rig({
      whenWaiting: async (code, ctx, cookie) => {
        const page = await ctx.app.inject({
          method: 'GET',
          url: `/ui/connect?code=${code}`,
          headers: { host: '127.0.0.1:51737', cookie },
        });
        expect(page.body).toMatch(/value="write" checked/);
        expect(page.body).toMatch(/value="30d" checked/);
        expect(page.body).not.toContain('value="session"');
        await approve({ access: 'write', duration: '30d' })(code, ctx, cookie);
      },
    });

    const exit = await runLogin(['--profile', 'work', '--duration', '30d', '--scope', 'write'], r.io);

    expect(exit).toBe(EXIT_OK);
    expect(r.storeFor('work').saved()).toMatch(/^ftk_/);
    expect(r.storeFor('default').saved()).toBeNull();
    expect((await grants(r.ctx))[0]).toMatchObject({ profile: 'work', hint_access: 'write', hint_duration: '30d' });
    expect(r.out.at(-1)).toContain('profile "work"');
  });

  it('uses FINTRACK_PROFILE (the shell’s default) when no --profile is given', async () => {
    const r = await rig({ defaultProfile: 'laptop', whenWaiting: approve() });
    await runLogin([], r.io);
    expect(r.storeFor('laptop').saved()).toMatch(/^ftk_/);
  });

  it('fails when the request is denied, saving nothing', async () => {
    const r = await rig({
      whenWaiting: async (code, ctx, cookie) => void (await answerConnect(ctx, cookie, code, { decision: 'deny' })),
    });
    expect(await runLogin([], r.io)).toBe(EXIT_FAILURE);
    expect(r.err).toContain(LOGIN_MESSAGES.denied);
    expect(r.storeFor('default').saved()).toBeNull();
    expect(r.server.close).toHaveBeenCalledOnce();
  });

  it('fails when the request expires before anyone answers', async () => {
    const r = await rig({
      whenWaiting: async (_code, ctx) =>
        void (await ctx.db.run(sql`UPDATE client_grants SET expires_at = '2000-01-01T00:00:00.000Z'`)),
    });
    expect(await runLogin([], r.io)).toBe(EXIT_FAILURE);
    expect(r.err).toContain(LOGIN_MESSAGES.expired);
    expect(r.storeFor('default').saved()).toBeNull();
  });

  it('cancels cleanly on Ctrl-C: says so, exits 130, saves nothing, closes the server and database', async () => {
    const r = await rig({ whenWaiting: async () => r.interrupt.abort() });
    expect(await runLogin([], r.io)).toBe(EXIT_INTERRUPTED);
    expect(r.err).toContain(LOGIN_MESSAGES.cancelled);
    expect(r.storeFor('default').saved()).toBeNull();
    expect(r.server.close).toHaveBeenCalledOnce();
    expect(r.shell.close).toHaveBeenCalledOnce();
  });

  it('refuses under FINTRACK_AUTH=disabled, starting nothing', async () => {
    const r = await rig({ authRequired: false });
    expect(await runLogin([], r.io)).toBe(EXIT_FAILURE);
    expect(r.err).toEqual([LOGIN_MESSAGES.authDisabled]);
    expect(r.shell.startServer).not.toHaveBeenCalled();
    expect(await grants(r.ctx)).toEqual([]);
  });

  it('points an unclaimed owner at `auth setup`, starting nothing', async () => {
    const r = await rig({ claimed: false });
    expect(await runLogin([], r.io)).toBe(EXIT_FAILURE);
    expect(r.err).toEqual([AUTH_MESSAGES.ownerUnclaimed]);
    expect(AUTH_MESSAGES.ownerUnclaimed).toContain(`${NPX_COMMAND} auth setup`);
    expect(r.shell.startServer).not.toHaveBeenCalled();
  });

  it('says so — and does not claim a cleanup — when the keychain refuses AND the revocation fails', async () => {
    const r = await rig({ store: memoryStore(null, { refuseSave: true }), whenWaiting: approve() });
    const run = r.shell.run;
    let failRevoke = false;
    const store = r.storeFor('default');
    const save = store.save.bind(store);
    store.save = async (token) => {
      failRevoke = true; // the very next write is the revocation
      return save(token);
    };
    r.shell.run = ((flow: Parameters<typeof run>[0]) => (failRevoke ? errAsync(conflict) : run(flow))) as typeof run;

    expect(await runLogin([], r.io)).toBe(EXIT_FAILURE);

    expect(r.err).toContain(LOGIN_MESSAGES.keychainRefusedAndStillActive);
    expect(r.err).not.toContain(LOGIN_MESSAGES.keychainRefused);
    expect(await r.ctx.db.all(sql`SELECT revoked_at IS NOT NULL AS revoked FROM access_tokens`)).toEqual([
      { revoked: 0 },
    ]);
  });

  it('revokes the sign-in again when the keychain will not keep it (a secret nothing can find)', async () => {
    const r = await rig({ store: memoryStore(null, { refuseSave: true }), whenWaiting: approve() });
    expect(await runLogin([], r.io)).toBe(EXIT_FAILURE);
    expect(r.err).toContain(LOGIN_MESSAGES.keychainRefused);
    expect(await r.ctx.db.all(sql`SELECT kind, revoked_at IS NOT NULL AS revoked FROM access_tokens`)).toEqual([
      { kind: 'stdio', revoked: 1 },
    ]);
  });

  it.each([
    [['--duration', 'session'], 'session'],
    [['--duration', 'forever'], 'forever'],
    [['--scope', 'admin'], 'admin'],
    [['--profile', 'has space'], 'profile'],
    [['stray'], 'stray'],
    [['--nope'], 'nope'],
  ])('rejects %j before opening anything', async (args, mention) => {
    const r = await rig();
    expect(await runLogin(args, r.io)).toBe(EXIT_FAILURE);
    expect(r.err.join('\n')).toContain(mention);
    expect(r.io.openShell).not.toHaveBeenCalled();
  });
});

describe('fintrack logout', () => {
  const signedInRig = async () => {
    const r = await rig({ whenWaiting: approve({ access: 'write' }) });
    await runLogin([], r.io);
    r.out.length = 0;
    return r;
  };

  it('revokes the saved sign-in and removes it from the keychain', async () => {
    const r = await signedInRig();
    const token = r.storeFor('default').saved()!;

    expect(await runLogout([], r.io)).toBe(EXIT_OK);

    expect(r.out).toEqual([LOGIN_MESSAGES.signedOut('default')]);
    expect(r.storeFor('default').saved()).toBeNull();
    expect(await r.ctx.db.all(sql`SELECT revoked_at IS NOT NULL AS revoked FROM access_tokens`)).toEqual([
      { revoked: 1 },
    ]);
    const status = await r.ctx.app.inject({
      method: 'GET',
      url: '/api/status',
      headers: { host: '127.0.0.1:51737', authorization: `Bearer ${token}` },
    });
    expect(status.statusCode).toBe(401);
  });

  it('is idempotent: with nothing saved it says so and succeeds', async () => {
    const r = await signedInRig();
    await runLogout([], r.io);
    r.out.length = 0;
    expect(await runLogout([], r.io)).toBe(EXIT_OK);
    expect(r.out).toEqual([LOGIN_MESSAGES.notSignedIn('default')]);
  });

  it('acts on the profile named, and leaves the others signed in', async () => {
    const r = await rig({ whenWaiting: approve() });
    await runLogin(['--profile', 'work'], r.io);
    await runLogin([], r.io);

    expect(await runLogout(['--profile', 'work'], r.io)).toBe(EXIT_OK);

    expect(r.storeFor('work').saved()).toBeNull();
    expect(r.storeFor('default').saved()).toMatch(/^ftk_/);
    expect(
      await r.ctx.db.all(sql`SELECT profile, revoked_at IS NOT NULL AS revoked FROM access_tokens ORDER BY profile`),
    ).toEqual([
      { profile: 'default', revoked: 0 },
      { profile: 'work', revoked: 1 },
    ]);
  });

  it('clears the entry even when its sign-in already ended (expired or revoked elsewhere)', async () => {
    const r = await signedInRig();
    await r.ctx.db.run(sql`UPDATE access_tokens SET revoked_at = '2020-01-01T00:00:00.000Z'`);
    expect(await runLogout([], r.io)).toBe(EXIT_OK);
    expect(r.storeFor('default').saved()).toBeNull();
  });

  it('does not delete a newer sign-in another process saved while it was revoking', async () => {
    const r = await signedInRig();
    const store = r.storeFor('default');
    const newer = 'ftk_saved-by-another-process';
    const load = store.load.bind(store);
    let loads = 0;
    store.load = async () => {
      loads += 1;
      const token = await load();
      if (loads === 1) await store.save(newer); // another `login` lands between our read and our delete
      return token;
    };

    expect(await runLogout([], r.io)).toBe(EXIT_OK);

    expect(store.saved()).toBe(newer);
    expect(store.calls.clear).toBe(0);
  });

  it('fails — never "Not signed in" — when the keychain cannot be read, and revokes nothing', async () => {
    const r = await signedInRig();
    r.storeFor('default').load = async () => {
      throw new KeychainUnavailableError(new Error('locked'));
    };

    await expect(runLogout([], r.io)).rejects.toBeInstanceOf(KeychainUnavailableError);

    expect(r.out).toEqual([]);
    expect(await r.ctx.db.all(sql`SELECT revoked_at IS NOT NULL AS revoked FROM access_tokens`)).toEqual([
      { revoked: 0 },
    ]);
  });

  it('does not revoke a personal access token someone put in the keychain — only a stdio sign-in', async () => {
    const r = await rig();
    const { token } = await mintToken(r.ctx, r.cookie, { name: 'script' });
    r.storeFor('default').save(token);
    await runLogout([], r.io);
    expect(await r.ctx.db.all(sql`SELECT kind, revoked_at IS NOT NULL AS revoked FROM access_tokens`)).toEqual([
      { kind: 'pat', revoked: 0 },
    ]);
  });

  it('rejects stray arguments before opening anything', async () => {
    const r = await rig();
    expect(await runLogout(['--duration', '24h'], r.io)).toBe(EXIT_FAILURE);
    expect(r.io.openShell).not.toHaveBeenCalled();
  });
});

describe('setup’s optional sign-in step', () => {
  const terminalAnswering = (answer: string | Error) => {
    const asked: string[] = [];
    const closed = vi.fn();
    const terminal: Terminal = {
      ask: async (question) => {
        asked.push(question);
        if (answer instanceof Error) throw answer;
        return answer;
      },
      askSecret: async () => '',
      tell: () => undefined,
      close: closed,
    };
    return { terminal, asked, closed };
  };

  it.each(['', 'y', 'Y', 'yes'])('signs the client in on %j', async (answer) => {
    const t = terminalAnswering(answer);
    const r = await rig({ terminal: t.terminal, whenWaiting: approve() });
    await offerSignIn(r.io, 'default');
    expect(t.asked).toEqual([LOGIN_MESSAGES.offer]);
    expect(t.closed).toHaveBeenCalledOnce();
    expect(r.storeFor('default').saved()).toMatch(/^ftk_/);
  });

  it('signs in as the client’s profile', async () => {
    const r = await rig({ terminal: terminalAnswering('y').terminal, whenWaiting: approve() });
    await offerSignIn(r.io, 'work');
    expect(r.storeFor('work').saved()).toMatch(/^ftk_/);
    expect(r.storeFor('default').saved()).toBeNull();
  });

  it.each(['n', 'N', 'no'])('skips on %j with a hint, touching nothing', async (answer) => {
    const r = await rig({ terminal: terminalAnswering(answer).terminal });
    await offerSignIn(r.io, 'default');
    expect(r.out).toEqual([LOGIN_MESSAGES.skippedByChoice('default')]);
    expect(r.io.openShell).not.toHaveBeenCalled();
  });

  it('skips on Ctrl-D, the same way', async () => {
    const t = terminalAnswering(new Error('cancelled'));
    const r = await rig({ terminal: t.terminal });
    await offerSignIn(r.io, 'default');
    expect(r.out).toEqual([LOGIN_MESSAGES.skippedByChoice('default')]);
    expect(t.closed).toHaveBeenCalledOnce();
  });

  it('skips without a terminal, with a one-line hint naming the pinned command and the profile', async () => {
    const r = await rig({ terminal: null });
    await offerSignIn(r.io, 'work');
    expect(r.out).toHaveLength(1);
    expect(r.out[0]).toBe(LOGIN_MESSAGES.skippedNoTerminal('work'));
    expect(r.out[0]).toContain(`${NPX_COMMAND} login --profile work`);
    expect(r.io.openShell).not.toHaveBeenCalled();
  });

  it('does not fail the setup when the sign-in is denied', async () => {
    const r = await rig({
      terminal: terminalAnswering('y').terminal,
      whenWaiting: async (code, ctx, cookie) => void (await answerConnect(ctx, cookie, code, { decision: 'deny' })),
    });
    await expect(offerSignIn(r.io, 'default')).resolves.toBeUndefined();
    expect(r.err).toContain(LOGIN_MESSAGES.denied);
  });
});

describe('startSignInServer — where `fintrack login` sends the browser', () => {
  const configFor = async (port: number) => {
    process.env['DB_PATH'] = '/tmp/fintrack-never-opened.db';
    process.env['FINTRACK_DB_KEY'] = 'c'.repeat(64);
    return {
      ...loadConfig(),
      HOST: '127.0.0.1',
      PORT: port,
      PUBLIC_URL: undefined,
      FINTRACK_AUTH: 'required' as const,
    };
  };

  it('does not reuse a FinTrack already running on HOST:PORT — it may have opened another database', async () => {
    const running = await createApp();
    await running.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (running.app.server.address() as AddressInfo).port;
    const mine = await createApp();

    const server = await startSignInServer(await configFor(port), mine.db);
    try {
      expect(server.origin).not.toBe(`http://127.0.0.1:${port}`);
      expect((await fetch(`${server.origin}/api/health`)).status).toBe(200);
    } finally {
      await server.close();
    }
    expect((await fetch(`http://127.0.0.1:${port}/api/health`)).status).toBe(200); // the other one is untouched
  });

  it('serves /ui/connect itself, from a temporary loopback app with authentication required', async () => {
    const ctx = await createApp();
    await claimOwner(ctx);
    const server = await startSignInServer(await configFor(0), ctx.db);
    try {
      expect(server.origin).toMatch(/^http:\/\/localhost:\d+$/);
      expect((await fetch(`${server.origin}/api/health`)).status).toBe(200);
      const anonymous = await fetch(`${server.origin}/ui/connect?code=ABCD-EFGH`, { redirect: 'manual' });
      expect(anonymous.status).toBe(303);
      expect(anonymous.headers.get('location')).toContain('/ui/login');
      expect((await fetch(`${server.origin}/api/status`)).status).toBe(401);
    } finally {
      await server.close();
    }
    await expect(fetch(`${server.origin}/api/health`)).rejects.toThrow();
  });

  it('serves loopback only, under the host name localhost (its own cookie), whatever HOST is', async () => {
    const ctx = await createApp();
    const server = await startSignInServer({ ...(await configFor(0)), HOST: '0.0.0.0' }, ctx.db);
    try {
      expect(server.origin).toMatch(/^http:\/\/localhost:\d+$/);
      expect((await fetch(`${server.origin}/api/health`)).status).toBe(200);
    } finally {
      await server.close();
    }
  });
});
