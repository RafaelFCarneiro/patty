import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BILL_ENTITY_TAG } from '../../../src/models/bill.js';
import { DASHBOARD_ENTITY_TAGS } from './entity-tags.js';
import { makeStubElement } from './fragment-sandbox.js';

// ui/app.js's live-update stream (ADR-036 §4), run in node:vm with a fake EventSource and fetch.
const read = (file: string) => readFileSync(fileURLToPath(new URL(`../../../ui/${file}`, import.meta.url)), 'utf-8');
const SHELL_SOURCE = read('app.js');
const RECONNECT_DELAY_MS = Number(SHELL_SOURCE.match(/RECONNECT_DELAY_MS = (\d+)/)?.[1]);
const EVENT_SOURCE_STATE = { connecting: 0, open: 1, closed: 2 } as const;

class FakeSource {
  static all: FakeSource[] = [];
  readyState: number = EVENT_SOURCE_STATE.connecting;
  onopen?: () => void;
  onerror?: () => void;
  onmessage?: (event: { data: string }) => void;
  constructor() {
    FakeSource.all.push(this);
  }
}

const NETWORK_ERROR = 'network-error';

const boot = async (statusCode: number | typeof NETWORK_ERROR) => {
  FakeSource.all = [];
  let onReady: (() => void) | undefined;
  const location = { pathname: '/ui/cards', search: '?month=3', href: '' };
  let booted = false;
  const fetchStatus = vi.fn((url: string) => {
    const checking = booted && url === '/api/status';
    if (checking && statusCode === NETWORK_ERROR) return Promise.reject(new Error('offline'));
    const status = checking ? statusCode : 200;
    return Promise.resolve({ ok: status === 200, status, json: () => Promise.resolve([]) });
  });
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
  vm.runInContext(SHELL_SOURCE, sandbox);
  onReady?.();
  await vi.advanceTimersByTimeAsync(0);
  booted = true;
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
    FakeSource.all[0]?.onmessage?.({ data: JSON.stringify({ entities: [BILL_ENTITY_TAG] }) });
    expect(calls).toEqual([[BILL_ENTITY_TAG]]);
  });

  it('goes to the login page with the current path when the stream is closed and the session lapsed', async () => {
    const { location, calls } = await boot(401);
    const source = FakeSource.all[0];
    if (source) source.readyState = EVENT_SOURCE_STATE.closed;
    source?.onerror?.();
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS * 2);
    expect(location.href).toBe('/ui/login?next=%2Fui%2Fcards%3Fmonth%3D3');
    expect(FakeSource.all).toHaveLength(1);
    expect(calls).toEqual([]);
  });

  it('reconnects once after the delay and resyncs every tag when closed with the session intact', async () => {
    const { location, calls } = await boot(200);
    const source = FakeSource.all[0];
    if (source) source.readyState = EVENT_SOURCE_STATE.closed;
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
    expect([...(calls[0] ?? [])].sort()).toEqual([...DASHBOARD_ENTITY_TAGS].sort());
    expect(location.href).toBe('');
  });

  it('reconnects once, with no login redirect, when the session check cannot reach the server', async () => {
    const { location, calls } = await boot(NETWORK_ERROR);
    const source = FakeSource.all[0];
    if (source) source.readyState = EVENT_SOURCE_STATE.closed;
    source?.onerror?.();
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS - 1);
    expect(FakeSource.all).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeSource.all).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS * 2);
    expect(FakeSource.all).toHaveLength(2);
    expect(location.href).toBe('');
    expect(calls).toEqual([]);
  });

  it('ignores an error from a source that was already replaced: no status check, no second reconnect', async () => {
    const { location, fetchStatus } = await boot(200);
    const [stale] = FakeSource.all;
    if (stale) stale.readyState = EVENT_SOURCE_STATE.closed;
    stale?.onerror?.();
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS);
    expect(FakeSource.all).toHaveLength(2);
    const checks = statusChecks(fetchStatus);
    stale?.onerror?.();
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS * 2);
    expect(statusChecks(fetchStatus)).toBe(checks);
    expect(FakeSource.all).toHaveLength(2);
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
