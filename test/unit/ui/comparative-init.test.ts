import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { TRANSACTION_ENTITY_TAG } from '../../../src/models/transaction.js';

// ui/dashboards/comparative.html is a plain browser-global fragment script (no build step, no
// module system), so runInit()'s async boot sequencing can't be unit-tested by importing it —
// exercising the real fragment via node:vm, mirroring test/unit/ui/overview-net-worth.test.ts's
// controllable-status tests (lines 194-256), is the only way to cover the actual locale-await,
// stale-fragment-detachment, and delayed-listener-registration behavior added for issue #174,
// rather than just the string content that behavior happens to produce once it runs.
const COMPARATIVE_HTML_PATH = fileURLToPath(new URL('../../../ui/dashboards/comparative.html', import.meta.url));
const MONEY_JS_PATH = fileURLToPath(new URL('../../../ui/money.js', import.meta.url));

type Listener = () => void;
type StubElement = {
  innerHTML: string;
  value: string;
  isConnected: boolean;
  style: { display: string; color: string };
  classList: { add: () => void; remove: () => void };
  appendChild: (child: { innerHTML: string }) => void;
  getContext: () => Record<string, unknown>;
  addEventListener: (type: string, handler: Listener) => void;
  fireEvent: (type: string) => void;
  // translatePage()'s month-select translation loop does Array.from(select.options)
  // unconditionally once a <select> is found — an empty array here just yields zero options to
  // translate, matching test/unit/ui/overview-net-worth.test.ts's same stub shape.
  options: never[];
};

const makeStubElement = (): StubElement => {
  const listeners: Record<string, Listener[]> = {};
  const el: StubElement = {
    innerHTML: '',
    value: '',
    isConnected: true,
    style: { display: '', color: '' },
    classList: { add() {}, remove() {} },
    appendChild(child) {
      el.innerHTML += child.innerHTML;
    },
    getContext: () => ({}),
    addEventListener(type, handler) {
      (listeners[type] ??= []).push(handler);
    },
    fireEvent(type) {
      (listeners[type] ?? []).forEach((handler) => handler());
    },
    options: [],
  };
  return el;
};

const makeStubDocument = () => {
  const elements = new Map<string, StubElement>();
  return {
    getElementById(id: string): StubElement {
      if (!elements.has(id)) elements.set(id, makeStubElement());
      return elements.get(id) as StubElement;
    },
    createElement: () => makeStubElement(),
    addEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    title: '',
  };
};

const extractFragmentScript = (html: string): string => {
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!match) throw new Error('comparative.html: no <script> tag found');
  return match[1] ?? '';
};

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
const makeDeferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

// Waits for a macrotask boundary — by then every microtask queued by a resolved promise chain
// (fetch's own resolution, res.json(), checkLocale()'s remaining awaits, runInit()'s continuation)
// has necessarily drained, unlike a fixed number of `await Promise.resolve()` hops which would need
// updating if that chain's depth ever changes.
const flushMicrotasks = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

type StatusResponse = { ok: boolean; json: () => Promise<{ locale: string }> };

// /api/status resolves only when the caller explicitly does so via the returned `resolveStatus`.
// /api/categories resolves immediately (empty list) so initDashboard() can reach its
// loadTransactionsData() call once past the locale gate — that call itself is stubbed per-test on
// sandbox.loadTransactionsData, so what it would otherwise fetch doesn't matter. Everything else
// stays dormant.
const loadComparativeSandboxWithControllableStatus = () => {
  const documentStub = makeStubDocument();
  const statusResponse = makeDeferred<StatusResponse>();
  const sandbox: Record<string, unknown> = {
    document: documentStub,
    console,
    Date,
    Math,
    Number,
    String,
    Array,
    JSON,
    Set,
    Promise,
    RegExp,
    parseInt,
    parseFloat,
    isNaN,
    encodeURIComponent,
    URLSearchParams,
    Intl,
    setTimeout,
    clearTimeout,
    fetch: (url: unknown) => {
      if (typeof url !== 'string') return new Promise(() => {});
      if (url.indexOf('/api/status') !== -1) return statusResponse.promise;
      if (url.indexOf('/api/categories') !== -1) return Promise.resolve({ ok: true, json: async () => [] });
      return new Promise(() => {});
    },
  };
  sandbox.window = sandbox;
  (sandbox.window as Record<string, unknown>).location = { pathname: '/ui/comparative', search: '' };
  (sandbox.window as Record<string, unknown>).history = { pushState() {} };

  vm.createContext(sandbox);
  vm.runInContext(readFileSync(MONEY_JS_PATH, 'utf-8'), sandbox, { filename: MONEY_JS_PATH });
  (sandbox.window as Record<string, unknown>).formatMoney = (value: number, currency: string) =>
    `${currency} ${value}`;

  const script = extractFragmentScript(readFileSync(COMPARATIVE_HTML_PATH, 'utf-8'));
  vm.runInContext(script, sandbox, { filename: COMPARATIVE_HTML_PATH });

  return { sandbox, documentStub, resolveStatus: statusResponse.resolve };
};

describe("runInit's boot sequencing (ui/dashboards/comparative.html)", () => {
  it('does not call loadTransactionsData (via initDashboard) until locale detection resolves', async () => {
    const { sandbox, resolveStatus } = loadComparativeSandboxWithControllableStatus();
    let loadCount = 0;
    sandbox.loadTransactionsData = () => {
      loadCount += 1;
    };

    // Still pending: initDashboard() must not have reached loadTransactionsData() yet.
    await flushMicrotasks();
    expect(loadCount).toBe(0);

    resolveStatus({ ok: true, json: async () => ({ locale: 'pt' }) });
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();

    expect(sandbox.currentLocale).toBe('pt');
    expect(loadCount).toBe(1);
  });

  it('does not resume into initDashboard if the fragment was navigated away from mid-flight', async () => {
    const { sandbox, documentStub, resolveStatus } = loadComparativeSandboxWithControllableStatus();
    let loadCount = 0;
    sandbox.loadTransactionsData = () => {
      loadCount += 1;
    };
    // Simulates app.js's renderFragment() tearing this fragment's DOM down for a new one while
    // checkLocale()'s request is still in flight — the exact race the isConnected guard exists for.
    documentStub.getElementById('panels-loading').isConnected = false;

    resolveStatus({ ok: true, json: async () => ({ locale: 'pt' }) });
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();

    expect(loadCount).toBe(0);
  });

  it('does not wire up the month/year/heatmap filter until locale resolves', async () => {
    // A change fired before locale resolves must not be able to call loadTransactionsData() with
    // currentLocale still at its English default — the same hazard the boot-call guard above exists
    // for, through a second entry point (the filter <select> elements).
    const { sandbox, documentStub, resolveStatus } = loadComparativeSandboxWithControllableStatus();
    let loadCount = 0;
    sandbox.loadTransactionsData = () => {
      loadCount += 1;
    };
    const monthSelect = documentStub.getElementById('month-select');

    monthSelect.fireEvent('change');
    expect(loadCount).toBe(0);

    resolveStatus({ ok: true, json: async () => ({ locale: 'pt' }) });
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();
    const callsFromBootItself = loadCount; // initDashboard()'s own loadTransactionsData() call

    monthSelect.fireEvent('change');
    expect(loadCount).toBe(callsFromBootItself + 1);
  });

  it('never wires up the filter at all if the fragment was detached before locale resolved', async () => {
    const { sandbox, documentStub, resolveStatus } = loadComparativeSandboxWithControllableStatus();
    let loadCount = 0;
    sandbox.loadTransactionsData = () => {
      loadCount += 1;
    };
    documentStub.getElementById('panels-loading').isConnected = false;

    resolveStatus({ ok: true, json: async () => ({ locale: 'pt' }) });
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();

    documentStub.getElementById('month-select').fireEvent('change');
    expect(loadCount).toBe(0);
  });
});

describe("live update after boot (ui/dashboards/comparative.html)", () => {
  const bootCompleted = async () => {
    const loaded = loadComparativeSandboxWithControllableStatus();
    let loadCount = 0;
    loaded.sandbox.loadTransactionsData = () => {
      loadCount += 1;
    };
    loaded.resolveStatus({ ok: true, json: async () => ({ locale: 'pt' }) });
    await flushMicrotasks();
    await flushMicrotasks();
    return { ...loaded, loads: () => loadCount };
  };

  it('refetches when an event arrives after boot completed', async () => {
    const { sandbox, loads } = await bootCompleted();
    expect(loads()).toBe(1);
    (sandbox.onAppDataChanged as (entities: string[]) => void)([TRANSACTION_ENTITY_TAG]);
    await flushMicrotasks();
    expect(loads()).toBe(2);
  });

  it('ignores an event while boot is still waiting for the locale', async () => {
    const { sandbox, resolveStatus } = loadComparativeSandboxWithControllableStatus();
    let loadCount = 0;
    sandbox.loadTransactionsData = () => {
      loadCount += 1;
    };
    (sandbox.onAppDataChanged as (entities: string[]) => void)([TRANSACTION_ENTITY_TAG]);
    await flushMicrotasks();
    expect(loadCount).toBe(0);
    resolveStatus({ ok: true, json: async () => ({ locale: 'pt' }) });
  });

  it('ignores an event once the fragment was torn down', async () => {
    const { sandbox, documentStub, loads } = await bootCompleted();
    documentStub.getElementById('panels-loading').isConnected = false;
    (sandbox.onAppDataChanged as (entities: string[]) => void)([TRANSACTION_ENTITY_TAG]);
    await flushMicrotasks();
    expect(loads()).toBe(1);
  });
});
