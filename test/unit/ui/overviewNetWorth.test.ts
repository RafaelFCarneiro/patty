import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

// ui/dashboards/overview.html is a plain browser-global fragment script (no build step, no module
// system — see ui/money.js's own header comment for the same reasoning), so renderNetWorth() can't
// be imported directly. Loading the real file's <script> content into a minimal sandboxed
// `document`/`window` with node:vm exercises the actual deployed fragment instead of a
// re-implementation, mirroring test/unit/ui/money.test.ts's approach for ui/money.js. `fetch` is
// stubbed to a never-resolving promise so the fragment's own async boot chain (checkLocale,
// loadDashboardData, ...) stays dormant — the test drives renderNetWorth() directly by setting the
// module-scope `consolidatedNetWorth`/`currentLocale` vars it reads.
const OVERVIEW_HTML_PATH = fileURLToPath(new URL('../../../ui/dashboards/overview.html', import.meta.url));

type StubElement = {
  innerHTML: string;
  textContent: string;
  value: string;
  style: { display: string };
  classList: { add: () => void; remove: () => void; toggle: () => void; contains: () => boolean };
  addEventListener: () => void;
  querySelector: () => null;
  querySelectorAll: () => never[];
  setAttribute: () => void;
  getAttribute: () => null;
  appendChild: () => void;
  // Real DOM elements default to true once attached; overview.html's initOverview reads this on its
  // captured #dashboard-loading marker to detect a torn-down fragment (see the detached-fragment
  // describe block below) — mirroring the property node:vm's minimal sandbox otherwise has no notion of.
  isConnected: boolean;
  // translatePage()'s month-select translation loop does Array.from(select.options) unconditionally
  // once a <select> is found — an empty array here just yields zero options to translate.
  options: never[];
};

const makeStubElement = (): StubElement => ({
  innerHTML: '',
  textContent: '',
  value: '',
  style: { display: '' },
  classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  addEventListener() {},
  querySelector: () => null,
  querySelectorAll: () => [],
  setAttribute() {},
  getAttribute: () => null,
  appendChild() {},
  isConnected: true,
  options: [],
});

const makeStubDocument = () => {
  const elements = new Map<string, StubElement>();
  return {
    getElementById(id: string): StubElement {
      if (!elements.has(id)) elements.set(id, makeStubElement());
      return elements.get(id) as StubElement;
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    createElement: () => makeStubElement(),
    title: '',
  };
};

const extractFragmentScript = (html: string): string => {
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!match) throw new Error('overview.html: no <script> tag found');
  return match[1] ?? '';
};

type StatusResponse = { ok: boolean; json: () => Promise<{ locale: string }> };

// Builds the sandbox global object shared by both loaders below — DOM stubs, the handful of
// built-ins the fragment's top-level (synchronous) script body touches (Date/URLSearchParams for
// the month/year query-param bootstrap, ...), and window.formatMoney (normally supplied by
// ui/money.js, loaded separately by the shell) as a deterministic stub so assertions don't depend
// on Intl locale data. `fetch` is the one thing callers customize.
const makeSandboxBase = (
  documentStub: ReturnType<typeof makeStubDocument>,
  fetchImpl: (url: string) => Promise<unknown>,
) => {
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
    fetch: fetchImpl,
  };
  sandbox.window = sandbox;
  (sandbox.window as Record<string, unknown>).location = { pathname: '/ui/overview', search: '' };
  (sandbox.window as Record<string, unknown>).history = { pushState() {} };
  (sandbox.window as Record<string, unknown>).formatMoney = (value: number, currency: string) =>
    `${currency} ${value}`;
  return sandbox;
};

const runFragmentScript = (sandbox: Record<string, unknown>) => {
  const script = extractFragmentScript(readFileSync(OVERVIEW_HTML_PATH, 'utf-8'));
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox, { filename: OVERVIEW_HTML_PATH });
};

// `fetch` stubbed to a never-resolving promise so the fragment's own async boot chain (checkLocale,
// loadDashboardData, ...) stays dormant — for tests that drive a function (renderNetWorth,
// handleFintrackDataChanged) directly rather than exercising initOverview's own async sequencing.
const loadOverviewSandbox = () => {
  const documentStub = makeStubDocument();
  const sandbox = makeSandboxBase(documentStub, () => new Promise(() => {}));
  runFragmentScript(sandbox);
  return { sandbox, documentStub };
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
// (fetch's own resolution, res.json(), checkLocale()'s remaining awaits, initOverview's
// continuation) has necessarily drained, unlike a fixed number of `await Promise.resolve()` hops
// which would need updating if that chain's depth ever changes.
const flushMicrotasks = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

// Same fragment script as loadOverviewSandbox, except /api/status resolves only when the caller
// explicitly does so via the returned `resolveStatus` — every other fetch() target stays dormant,
// same as the plain sandbox. Exercises initOverview's actual async sequencing (the previous helper
// deliberately never lets checkLocale() resolve at all), for the locale-await/detached-fragment
// behavior a bare source-order check can't cover.
const loadOverviewSandboxWithControllableStatus = () => {
  const documentStub = makeStubDocument();
  const statusResponse = makeDeferred<StatusResponse>();
  const sandbox = makeSandboxBase(documentStub, (url) =>
    typeof url === 'string' && url.indexOf('/api/status') !== -1 ? statusResponse.promise : new Promise(() => {}),
  );
  runFragmentScript(sandbox);
  return { sandbox, documentStub, resolveStatus: statusResponse.resolve };
};

describe("initOverview's boot sequencing (ui/dashboards/overview.html)", () => {
  it('registers the live-update hook once locale detection resolves, fragment still attached', async () => {
    const { sandbox, resolveStatus } = loadOverviewSandboxWithControllableStatus();
    expect((sandbox.window as Record<string, unknown>).fintrackOnDataChanged).toBeUndefined();

    resolveStatus({ ok: true, json: async () => ({ locale: 'pt' }) });
    await flushMicrotasks();
    await flushMicrotasks();

    expect(sandbox.currentLocale).toBe('pt');
    expect(typeof (sandbox.window as Record<string, unknown>).fintrackOnDataChanged).toBe('function');
  });

  it('does not resume — no hook, no reload — if the fragment was navigated away from mid-flight', async () => {
    const { sandbox, documentStub, resolveStatus } = loadOverviewSandboxWithControllableStatus();
    // Simulates app.js's renderFragment() tearing this fragment's DOM down for a new one while
    // checkLocale()'s request is still in flight — the exact race the isConnected guard exists for.
    documentStub.getElementById('dashboard-loading').isConnected = false;

    resolveStatus({ ok: true, json: async () => ({ locale: 'pt' }) });
    await flushMicrotasks();
    await flushMicrotasks();

    expect((sandbox.window as Record<string, unknown>).fintrackOnDataChanged).toBeUndefined();
  });
});

describe('handleFintrackDataChanged (ui/dashboards/overview.html)', () => {
  it('refetches on currency_rate and settings changes, not just transaction/account/category/recurring', () => {
    const { sandbox } = loadOverviewSandbox();
    let callCount = 0;
    sandbox.loadDashboardData = () => {
      callCount += 1;
    };
    const handle = sandbox.handleFintrackDataChanged as (entities: string[]) => void;

    handle(['currency_rate']);
    handle(['settings']);
    handle(['transaction']);

    expect(callCount).toBe(3);
  });

  it('ignores entity tags the net-worth badge does not depend on', () => {
    const { sandbox } = loadOverviewSandbox();
    let called = false;
    sandbox.loadDashboardData = () => {
      called = true;
    };
    const handle = sandbox.handleFintrackDataChanged as (entities: string[]) => void;

    handle(['budget']);

    expect(called).toBe(false);
  });
});

describe('renderNetWorth (ui/dashboards/overview.html)', () => {
  it('renders the converted total with no excluded note when every account converted', () => {
    const { sandbox, documentStub } = loadOverviewSandbox();
    sandbox.consolidatedNetWorth = { baseCurrency: 'BRL', total: 1234.56, excluded: [] };
    (sandbox.renderNetWorth as () => void)();

    const el = documentStub.getElementById('net-worth-summary');
    expect(el.style.display).toBe('block');
    expect(el.innerHTML).toContain('BRL 1234.56');
    expect(el.innerHTML).toContain('Net worth (home currency)');
    expect(el.innerHTML).not.toContain('nw-excluded');
  });

  it('surfaces the excluded-account count instead of silently omitting unconverted accounts', () => {
    const { sandbox, documentStub } = loadOverviewSandbox();
    sandbox.consolidatedNetWorth = { baseCurrency: 'BRL', total: 500, excluded: ['acc-1', 'acc-2'] };
    (sandbox.renderNetWorth as () => void)();

    const el = documentStub.getElementById('net-worth-summary');
    expect(el.innerHTML).toContain('nw-excluded');
    expect(el.innerHTML).toContain('2 account(s) excluded (no rate)');
  });

  it('shows the "n.a." fallback — never a fabricated total — when consolidatedNetWorth is absent', () => {
    const { sandbox, documentStub } = loadOverviewSandbox();
    sandbox.consolidatedNetWorth = null;
    (sandbox.renderNetWorth as () => void)();

    const el = documentStub.getElementById('net-worth-summary');
    expect(el.style.display).toBe('block');
    expect(el.innerHTML).toContain('nw-total na');
    expect(el.innerHTML).toContain('—');
    expect(el.innerHTML).not.toMatch(/BRL|USD|R\$|\$/);
  });

  it('translates the label and excluded note when currentLocale is pt', () => {
    const { sandbox, documentStub } = loadOverviewSandbox();
    sandbox.currentLocale = 'pt';
    sandbox.consolidatedNetWorth = { baseCurrency: 'BRL', total: 100, excluded: ['acc-1'] };
    (sandbox.renderNetWorth as () => void)();

    const el = documentStub.getElementById('net-worth-summary');
    expect(el.innerHTML).toContain('Patrimônio Líquido (moeda base)');
    expect(el.innerHTML).toContain('1 conta(s) excluída(s) (sem cotação)');
  });
});
