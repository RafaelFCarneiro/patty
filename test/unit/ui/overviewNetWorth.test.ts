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

// Sandbox globals kept intentionally narrow — only what the fragment's top-level (synchronous)
// script body actually touches while `fetch` stays dormant: DOM stubs, Date/URLSearchParams for the
// month/year query-param bootstrap, and window.formatMoney (normally supplied by ui/money.js, loaded
// separately by the shell) as a deterministic stub so assertions don't depend on Intl locale data.
const loadOverviewSandbox = () => {
  const script = extractFragmentScript(readFileSync(OVERVIEW_HTML_PATH, 'utf-8'));
  const documentStub = makeStubDocument();
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
    fetch: () => new Promise(() => {}),
  };
  sandbox.window = sandbox;
  (sandbox.window as Record<string, unknown>).location = { pathname: '/ui/overview', search: '' };
  (sandbox.window as Record<string, unknown>).history = { pushState() {} };
  (sandbox.window as Record<string, unknown>).formatMoney = (value: number, currency: string) =>
    `${currency} ${value}`;
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox, { filename: OVERVIEW_HTML_PATH });
  return { sandbox, documentStub };
};

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
