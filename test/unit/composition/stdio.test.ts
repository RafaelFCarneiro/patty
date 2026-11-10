import { okAsync } from 'neverthrow';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../../../src/config.js';

const mocks = vi.hoisted(() => ({
  boot: vi.fn(),
  connectStdio: vi.fn<(...args: unknown[]) => unknown>(),
  startHttpSidecar: vi.fn(),
}));

vi.mock('../../../src/composition/boot.js', () => ({ boot: mocks.boot }));
vi.mock('../../../src/diplomat/mcp/stdio.js', () => ({ connectStdio: mocks.connectStdio }));
vi.mock('../../../src/composition/http.js', () => ({ startHttpSidecar: mocks.startHttpSidecar }));

const { runStdio } = await import('../../../src/composition/stdio.js');

const configWith = (overrides: Partial<Config> = {}): Config =>
  ({
    PATTY_HTTP: false,
    PUBLIC_URL: undefined,
    HOST: '127.0.0.1',
    PORT: 3001,
    TRUST_PROXY: false,
    PATTY_PROFILE: 'work',
    PATTY_TOKEN: 'ptk_env',
    ...overrides,
  }) as Config;

type Handlers = Record<string, () => void>;
let handlers: Handlers;
let exit: ReturnType<typeof vi.spyOn>;
let order: string[];

const deferred = () => {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
};

const connection = (closing: { server?: Promise<void>; session?: Promise<void> } = {}) => {
  const server = { close: vi.fn(() => (order.push('server'), closing.server ?? Promise.resolve())) };
  const session = { close: vi.fn(() => (order.push('session'), closing.session ?? Promise.resolve())) };
  mocks.connectStdio.mockResolvedValue({ server, session });
  return { server, session };
};

const sidecar = (listening: boolean, port = 51737) => {
  const app = {
    close: vi.fn(() => (order.push('sidecar'), Promise.resolve())),
    server: { address: () => ({ port }) },
  };
  mocks.startHttpSidecar.mockResolvedValue({ listening, app });
  return app;
};

const booted = (stdio: unknown = undefined) => {
  const issueAndAnnounceSetup = vi.fn(async () => undefined);
  mocks.boot.mockReturnValue(
    okAsync({ runtime: { tag: 'runtime' }, prepared: { auth: { tag: 'auth' }, stdio, issueAndAnnounceSetup } }),
  );
  return issueAndAnnounceSetup;
};

beforeEach(() => {
  handlers = {};
  order = [];
  vi.spyOn(process, 'once').mockImplementation(((event: string, handler: () => void) => {
    handlers[`process:${event}`] = handler;
    return process;
  }) as never);
  vi.spyOn(process.stdin, 'once').mockImplementation(((event: string, handler: () => void) => {
    handlers[`stdin:${event}`] = handler;
    return process.stdin;
  }) as never);
  exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  Object.values(mocks).forEach((mock) => mock.mockReset());
});

describe('runStdio — startup', () => {
  it('under PATTY_AUTH=disabled connects as the owner, binds no sidecar and announces nothing', async () => {
    const announce = booted(undefined);
    connection();

    const started = await runStdio(configWith());

    expect(started.isOk()).toBe(true);
    expect(mocks.connectStdio).toHaveBeenCalledWith({ tag: 'runtime' }, expect.any(String), { mode: 'disabled' });
    expect(mocks.startHttpSidecar).not.toHaveBeenCalled();
    expect(announce).not.toHaveBeenCalled();
  });

  it('with a sign-in prepared, connects with the profile and env token and signs in through that sign-in', async () => {
    const signIn = vi.fn((..._args: unknown[]) => 'interpreter');
    booted({ signIn });
    connection();
    sidecar(false);

    await runStdio(configWith({ PUBLIC_URL: 'https://fin.example', PATTY_HTTP: true }));
    const auth = mocks.connectStdio.mock.calls[0]?.[2] as { signIn: (profile: string) => unknown };

    expect(auth).toMatchObject({ mode: 'required', profile: 'work', envToken: 'ptk_env' });
    expect(auth.signIn('work')).toBe('interpreter');
    expect(signIn).toHaveBeenCalledWith('work', expect.any(Function));
    expect((signIn.mock.calls[0]?.[1] as () => string)()).toBe('https://fin.example');
  });

  it('starts the sidecar with the runtime and auth, then announces the setup code at the bound origin', async () => {
    const announce = booted(undefined);
    connection();
    sidecar(true, 51737);

    await runStdio(configWith({ PATTY_HTTP: true, PORT: 51737 }));

    expect(mocks.startHttpSidecar).toHaveBeenCalledWith({ tag: 'runtime' }, expect.any(String), 51737, '127.0.0.1', {
      auth: { tag: 'auth' },
      trustProxy: false,
    });
    expect(announce).toHaveBeenCalledWith('http://127.0.0.1:51737');
  });

  it('names the bound origin in sign-in links only once the sidecar has bound', async () => {
    const signIn = vi.fn((..._args: unknown[]) => 'interpreter');
    booted({ signIn });
    connection();
    sidecar(true, 4242);

    await runStdio(configWith({ PATTY_HTTP: true }));
    (mocks.connectStdio.mock.calls[0]?.[2] as { signIn: (profile: string) => unknown }).signIn('work');

    expect((signIn.mock.calls[0]?.[1] as () => string)()).toBe('http://127.0.0.1:4242');
  });

  it('announces no setup code when the sidecar did not bind (another process owns the port and its code)', async () => {
    const announce = booted(undefined);
    connection();
    sidecar(false);

    await runStdio(configWith({ PATTY_HTTP: true }));

    expect(announce).not.toHaveBeenCalled();
  });

  it('shuts down on SIGINT, SIGTERM and when stdin ends or closes', async () => {
    booted(undefined);
    connection();

    await runStdio(configWith());

    expect(Object.keys(handlers).sort()).toEqual(['process:SIGINT', 'process:SIGTERM', 'stdin:close', 'stdin:end']);
  });
});

describe('runStdio — shutdown', () => {
  it('closes the server, the sidecar and the sign-in session, in order, then exits 0 once all settled', async () => {
    booted(undefined);
    const serverClosed = deferred();
    const { server, session } = connection({ server: serverClosed.promise });
    const app = sidecar(true);
    await runStdio(configWith({ PATTY_HTTP: true }));

    handlers['stdin:end']?.();

    expect(order).toEqual(['server', 'sidecar', 'session']);
    expect(server.close).toHaveBeenCalledOnce();
    expect(app.close).toHaveBeenCalledOnce();
    expect(session.close).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(exit).not.toHaveBeenCalled();

    serverClosed.resolve();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
  });

  it('shuts down once however many of the signals arrive', async () => {
    booted(undefined);
    const { server } = connection();
    await runStdio(configWith());

    handlers['stdin:end']?.();
    handlers['stdin:close']?.();
    handlers['process:SIGTERM']?.();

    expect(server.close).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledTimes(1));
  });

  it('closes no sidecar that never bound, and no session when there is none', async () => {
    booted(undefined);
    const { server } = connection();
    mocks.connectStdio.mockResolvedValue({ server, session: undefined });
    const app = sidecar(false);
    await runStdio(configWith({ PATTY_HTTP: true }));

    handlers['process:SIGINT']?.();

    expect(app.close).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
  });

  it('logs a server or sidecar that fails to close and still exits 0', async () => {
    const report = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    booted(undefined);
    const failure = new Error('close failed');
    const { server } = connection();
    server.close.mockRejectedValue(failure);
    await runStdio(configWith());

    handlers['process:SIGTERM']?.();

    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(report).toHaveBeenCalledWith(failure);
  });
});
