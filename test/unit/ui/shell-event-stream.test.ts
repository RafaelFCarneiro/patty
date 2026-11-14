import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeStubElement } from './fragment-sandbox.js';

// ui/app.js's live-update stream (ADR-036 §4), run in node:vm with a fake EventSource and fetch.
const read = (file: string) => readFileSync(fileURLToPath(new URL(`../../../ui/${file}`, import.meta.url)), 'utf-8');
const RECONNECT_DELAY_MS = 3000;
const CLOSED = 2;
const CONNECTING = 0;

class FakeSource {
  static all: FakeSource[] = [];
  readyState = CONNECTING;
  onopen?: () => void;
  onerror?: () => void;
  onmessage?: (event: { data: string }) => void;
  constructor() {
    FakeSource.all.push(this);
  }
}

const boot = async (statusCode: number) => {
  FakeSource.all = [];
  let onReady: (() => void) | undefined;
  const location = { pathname: '/ui/cards', search: '?month=3', href: '' };
  const fetchStatus = vi.fn((url: string) =>
    Promise.resolve(
      url === '/api/status' && statusCode !== 200
        ? { ok: false, status: statusCode, json: () => Promise.resolve(null) }
        : { ok: true, status: 200, json: () => Promise.resolve([]) },
    ),
  );
  const document = {
    title: '',
    getElementById: () => makeStubElement(),
    querySelector: () => makeStubElement(),
    querySelectorAll: () => [],
    createElement: () => makeStubElement(),
    addEventListener: (type: string, handler: () => void) => {
      if (type === 'DOMContentLoaded') onReady = handler;
    },
    body: makeStubElement(),
  };
  const sandbox: Record<string, unknown> = {
    document, console: { ...console, error() {} }, fetch: fetchStatus, Intl, Number, Object, Math, Array,
    Promise, Date, String, JSON, encodeURIComponent, setTimeout, clearTimeout, URLSearchParams,
    EventSource: FakeSource, location, history: { pushState() {} }, addEventListener() {},
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('money.js'), sandbox);
  vm.runInContext(read('app.js'), sandbox);
  onReady?.();
  await vi.advanceTimersByTimeAsync(0);
  const calls: string[][] = [];
  sandbox.onAppDataChanged = (entities: string[]) => calls.push(entities);
  return { location, calls, fetchStatus };
};

const statusChecks = (fetchStatus: ReturnType<typeof vi.fn>) =>
  fetchStatus.mock.calls.filter(([url]) => url === '/api/status').length;

describe('shell event stream (ui/app.js)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('still forwards a message to the fragment', async () => {
    const { calls } = await boot(200);
    FakeSource.all[0]?.onmessage?.({ data: JSON.stringify({ entities: ['bill'] }) });
    expect(calls).toEqual([['bill']]);
  });

  it('goes to the login page with the current path when the stream is closed and the session lapsed', async () => {
    const { location, calls } = await boot(401);
    const source = FakeSource.all[0];
    if (source) source.readyState = CLOSED;
    source?.onerror?.();
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS * 2);
    expect(location.href).toBe('/ui/login?next=%2Fui%2Fcards%3Fmonth%3D3');
    expect(FakeSource.all).toHaveLength(1);
    expect(calls).toEqual([]);
  });

  it('reconnects once after the delay and resyncs every tag when closed with the session intact', async () => {
    const { location, calls } = await boot(200);
    const source = FakeSource.all[0];
    if (source) source.readyState = CLOSED;
    source?.onerror?.();
    source?.onerror?.();
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS - 1);
    expect(FakeSource.all).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeSource.all).toHaveLength(2);
    expect(calls).toEqual([]);
    FakeSource.all[1]?.onopen?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(expect.arrayContaining(['transaction', 'bill', 'account', 'userSettings']));
    expect(location.href).toBe('');
  });

  it('does not reconnect while the browser retries, and resyncs when it reopens', async () => {
    const { calls, fetchStatus } = await boot(200);
    const before = statusChecks(fetchStatus);
    FakeSource.all[0]?.onopen?.();
    expect(calls).toEqual([]);
    FakeSource.all[0]?.onerror?.();
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS * 2);
    expect(FakeSource.all).toHaveLength(1);
    expect(statusChecks(fetchStatus)).toBe(before);
    FakeSource.all[0]?.onopen?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
  });
});
