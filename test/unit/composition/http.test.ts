import { Server } from 'node:net';
import { okAsync } from 'neverthrow';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../../../src/config.js';

const mocks = vi.hoisted(() => ({ boot: vi.fn(), startServingRelay: vi.fn() }));

vi.mock('../../../src/composition/boot.js', () => ({ boot: mocks.boot }));
vi.mock('../../../src/composition/change-log.js', () => ({ startServingRelay: mocks.startServingRelay }));
// Routes, hooks and the MCP route are the edges' business; this suite is about the process lifecycle around them.
vi.mock('../../../src/diplomat/http/hooks/auth.js', () => ({ registerAuthHook: vi.fn() }));
vi.mock('../../../src/diplomat/http/hooks/demo-marker.js', () => ({ registerDemoMarkerHook: vi.fn() }));
vi.mock('../../../src/diplomat/http/routes.js', () => ({ registerRoutes: vi.fn() }));
vi.mock('../../../src/diplomat/mcp/route.js', () => ({ registerMcpRoute: vi.fn() }));

const { runHttp } = await import('../../../src/composition/http.js');

const CONFIG = { HOST: '127.0.0.1', PORT: 0, TRUST_PROXY: false } as Config;

type Handlers = Record<string, () => void>;
let handlers: Handlers;
let order: string[];
let exit: ReturnType<typeof vi.spyOn>;

const deferred = () => {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
};

const booted = (closeLog: () => Promise<void>) => {
  const runtime = { changeLog: { close: vi.fn(closeLog) }, changeBus: { subscribe: vi.fn() } };
  const issueAndAnnounceSetup = vi.fn(async () => undefined);
  mocks.boot.mockReturnValue(okAsync({ runtime, prepared: { auth: { mode: 'disabled' }, issueAndAnnounceSetup } }));
  return { runtime, issueAndAnnounceSetup };
};

beforeEach(() => {
  handlers = {};
  order = [];
  vi.spyOn(process, 'on').mockImplementation(((event: string, handler: () => void) => {
    handlers[event] = handler;
    return process;
  }) as never);
  exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  // The listening socket's close is the server shutting down: observe it in the same order as the other stages.
  const closeServer = Server.prototype.close;
  vi.spyOn(Server.prototype, 'close').mockImplementation(function (this: Server, ...args: Parameters<Server['close']>) {
    order.push('server');
    return closeServer.apply(this, args);
  });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  Object.values(mocks).forEach((mock) => mock.mockReset());
});

describe('runHttp — change relay lifecycle (ADR-036)', () => {
  it('starts the change relay on the runtime once listening, before announcing the setup code', async () => {
    const { runtime, issueAndAnnounceSetup } = booted(async () => undefined);
    mocks.startServingRelay.mockImplementation(async () => (order.push('relay-start'), { stop: vi.fn() }));
    issueAndAnnounceSetup.mockImplementation(async () => void order.push('announce'));

    const started = await runHttp(CONFIG);

    expect(started.isOk()).toBe(true);
    expect(mocks.startServingRelay).toHaveBeenCalledExactlyOnceWith(runtime);
    expect(order).toEqual(['relay-start', 'announce']);
    handlers.SIGTERM?.();
    await vi.waitFor(() => expect(exit).toHaveBeenCalled());
  });

  it('on a signal stops the relay, then the server, then the change log, and exits only after all three', async () => {
    const relayStopped = deferred();
    const logClosed = deferred();
    booted(() => (order.push('change-log'), logClosed.promise));
    mocks.startServingRelay.mockResolvedValue({ stop: vi.fn(() => (order.push('relay'), relayStopped.promise)) });
    await runHttp(CONFIG);

    handlers.SIGINT?.();
    await vi.waitFor(() => expect(order).toEqual(['relay']));
    expect(exit).not.toHaveBeenCalled();

    relayStopped.resolve();
    await vi.waitFor(() => expect(order).toEqual(['relay', 'server', 'change-log']));
    expect(exit).not.toHaveBeenCalled();

    logClosed.resolve();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(order).toEqual(['relay', 'server', 'change-log']);
  });

  it('shuts down once however many signals arrive', async () => {
    const { runtime } = booted(async () => undefined);
    mocks.startServingRelay.mockResolvedValue({ stop: vi.fn(async () => undefined) });
    await runHttp(CONFIG);

    handlers.SIGINT?.();
    handlers.SIGTERM?.();
    handlers.SIGINT?.();

    await vi.waitFor(() => expect(exit).toHaveBeenCalledTimes(1));
    expect(runtime.changeLog.close).toHaveBeenCalledOnce();
  });

  it('shuts down without a relay when it could not start', async () => {
    const { runtime } = booted(async () => undefined);
    mocks.startServingRelay.mockResolvedValue(null);
    await runHttp(CONFIG);

    handlers.SIGTERM?.();

    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(runtime.changeLog.close).toHaveBeenCalledOnce();
  });
});
