import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

// ui/dashboards/comparative.html is a plain browser-global fragment script (no build step, no
// module system), so calculateAndRenderAll() can't be imported directly. Loading the real file's
// <script> content into a minimal sandboxed `document`/`window` with node:vm exercises the actual
// deployed fragment, mirroring test/unit/ui/overviewKpis.test.ts's approach. Covers issue #174's
// comparative-dashboard behavior: per-currency KPI/category totals, same-currency percentage
// calculations, the mergeCurrencyMaps sort fix, transfer exclusion, and representative-currency
// chart selection/labeling.
const COMPARATIVE_HTML_PATH = fileURLToPath(new URL('../../../ui/dashboards/comparative.html', import.meta.url));
const MONEY_JS_PATH = fileURLToPath(new URL('../../../ui/money.js', import.meta.url));

type StubElement = {
  innerHTML: string;
  textContent: string;
  style: { display: string; color: string };
  appendChild: (child: { innerHTML: string }) => void;
  getContext: () => Record<string, unknown>;
  addEventListener: () => void;
};

const makeStubElement = (): StubElement => {
  const el: StubElement = {
    innerHTML: '',
    textContent: '',
    style: { display: '', color: '' },
    appendChild(child) {
      el.innerHTML += child.innerHTML;
    },
    getContext: () => ({}),
    addEventListener() {},
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
  };
};

// Captures every `new Chart(ctx, config)` call's config so tests can assert on the series data and
// tooltip/axis callbacks without a real canvas or rendering engine.
class StubChart {
  static instances: StubChart[] = [];
  config: {
    data: { labels?: string[]; datasets: Array<{ label?: string; data: number[] }> };
    options: {
      plugins: { tooltip: { callbacks: { label: (ctx: unknown) => string } } };
      scales?: { y: { ticks: { callback: (value: number) => string } } };
    };
  };
  constructor(_ctx: unknown, config: StubChart['config']) {
    this.config = config;
    StubChart.instances.push(this);
  }
  destroy() {}
}

const firstChart = (): StubChart => {
  const chart = StubChart.instances[0];
  if (!chart) throw new Error('no Chart instance was created');
  return chart;
};

const extractFragmentScript = (html: string): string => {
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!match) throw new Error('comparative.html: no <script> tag found');
  return match[1] ?? '';
};

// Same deterministic formatMoney stub as the other ui/ fragment tests — `${currency} ${value}`, so
// assertions don't depend on Intl locale data, while the real ui/money.js still supplies the
// DEFAULT_CURRENCY/addMultiCurrency/valueIn/primaryCurrencyOf/magnitudeOf/mergeCurrencyMaps/
// formatMultiCurrencyWith globals this fragment depends on (issue #174) instead of local copies.
const loadComparativeSandbox = () => {
  StubChart.instances = [];
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
    Chart: StubChart,
  };
  sandbox.window = sandbox;
  (sandbox.window as Record<string, unknown>).location = { pathname: '/ui/comparative', search: '' };
  (sandbox.window as Record<string, unknown>).history = { pushState() {} };

  vm.createContext(sandbox);
  vm.runInContext(readFileSync(MONEY_JS_PATH, 'utf-8'), sandbox, { filename: MONEY_JS_PATH });
  (sandbox.window as Record<string, unknown>).formatMoney = (value: number, currency: string) => `${currency} ${value}`;

  const script = extractFragmentScript(readFileSync(COMPARATIVE_HTML_PATH, 'utf-8'));
  vm.runInContext(script, sandbox, { filename: COMPARATIVE_HTML_PATH });

  return { sandbox, documentStub };
};

type Tx = {
  date: string;
  type: 'income' | 'expense' | 'transfer';
  status: 'effective' | 'pending';
  amount: number;
  currency?: string;
  categoryId: string;
  categoryName: string;
};

const tx = (overrides: Partial<Tx>): Tx => ({
  date: '2026-09-05',
  type: 'expense',
  status: 'effective',
  amount: 0,
  categoryId: 'cat-1',
  categoryName: 'Category',
  ...overrides,
});

const withMonth = (sandbox: Record<string, unknown>) => {
  sandbox.selectedMonth = 9;
  sandbox.selectedYear = 2026;
  sandbox.categories = [];
};

describe('calculateAndRenderAll KPIs (ui/dashboards/comparative.html)', () => {
  it('keeps each currency in its own bucket instead of blending them into one BRL-labeled total', () => {
    const { sandbox, documentStub } = loadComparativeSandbox();
    withMonth(sandbox);
    sandbox.allTransactions = [
      tx({ type: 'income', amount: 1000, currency: 'BRL' }),
      tx({ type: 'income', amount: 50, currency: 'USD' }),
      tx({ type: 'expense', amount: 0.001, currency: 'BTC' }),
    ];

    (sandbox.calculateAndRenderAll as () => void)();

    expect(documentStub.getElementById('kpi-income-val').textContent).toBe('BRL 1000 / USD 50');
    expect(documentStub.getElementById('kpi-expense-val').textContent).toBe('BTC 0.001');
  });

  it('splits effective vs. pending per currency', () => {
    const { sandbox, documentStub } = loadComparativeSandbox();
    withMonth(sandbox);
    sandbox.allTransactions = [
      tx({ type: 'expense', status: 'effective', amount: 100, currency: 'BRL' }),
      tx({ type: 'expense', status: 'pending', amount: 10, currency: 'BRL' }),
      tx({ type: 'expense', status: 'effective', amount: 20, currency: 'USD' }),
      tx({ type: 'expense', status: 'pending', amount: 5, currency: 'USD' }),
    ];

    (sandbox.calculateAndRenderAll as () => void)();

    expect(documentStub.getElementById('kpi-expense-eff').textContent).toBe('BRL 100 / USD 20');
    expect(documentStub.getElementById('kpi-expense-pend').textContent).toBe('BRL 10 / USD 5');
  });

  it('excludes transfers from every KPI bucket', () => {
    const { sandbox, documentStub } = loadComparativeSandbox();
    withMonth(sandbox);
    sandbox.allTransactions = [
      tx({ type: 'income', amount: 100, currency: 'BRL' }),
      tx({ type: 'transfer', amount: 999999, currency: 'BRL' }),
    ];

    (sandbox.calculateAndRenderAll as () => void)();

    expect(documentStub.getElementById('kpi-income-val').textContent).toBe('BRL 100');
  });

  it('colors the balance KPI from its own primary currency, never a cross-currency blend', () => {
    const { sandbox, documentStub } = loadComparativeSandbox();
    withMonth(sandbox);
    sandbox.allTransactions = [
      tx({ type: 'expense', amount: 500, currency: 'BRL' }),
      tx({ type: 'income', amount: 1000, currency: 'USD' }),
    ];

    (sandbox.calculateAndRenderAll as () => void)();

    const balanceEl = documentStub.getElementById('kpi-balance-val');
    expect(balanceEl.textContent).toBe('BRL -500 / USD 1000');
    expect(balanceEl.style.color).toBe('var(--expense-color)');
  });

  it('renders the DEFAULT_CURRENCY zero fallback for an empty month', () => {
    const { sandbox, documentStub } = loadComparativeSandbox();
    withMonth(sandbox);
    const { DEFAULT_CURRENCY } = sandbox as unknown as { DEFAULT_CURRENCY: string };
    sandbox.allTransactions = [];

    (sandbox.calculateAndRenderAll as () => void)();

    expect(documentStub.getElementById('kpi-income-val').textContent).toBe(`${DEFAULT_CURRENCY} 0`);
    expect(documentStub.getElementById('kpi-balance-val').textContent).toBe(`${DEFAULT_CURRENCY} 0`);
  });
});

describe('renderCategoryColumns sort/percentage (ui/dashboards/comparative.html)', () => {
  it('sorts by the additive effective+pending total, not a last-write-wins overwrite', () => {
    // Regression test for the mergeCurrencyMaps fix: a category with BRL 1000 effective AND BRL 1
    // pending must sort ABOVE a category with a flat BRL 500 — Object.assign({}, effective,
    // pending) would have silently corrupted this to {BRL: 1}, sorting it near the bottom instead.
    const { sandbox, documentStub } = loadComparativeSandbox();
    withMonth(sandbox);
    sandbox.allTransactions = [
      tx({ status: 'effective', amount: 1000, currency: 'BRL', categoryId: 'cat-a', categoryName: 'Mercado' }),
      tx({ status: 'pending', amount: 1, currency: 'BRL', categoryId: 'cat-a', categoryName: 'Mercado' }),
      tx({ status: 'effective', amount: 500, currency: 'BRL', categoryId: 'cat-b', categoryName: 'Transporte' }),
    ];

    (sandbox.calculateAndRenderAll as () => void)();

    const html = documentStub.getElementById('expense-categories-list').innerHTML;
    expect(html.indexOf('Mercado')).toBeLessThan(html.indexOf('Transporte'));
    expect(html).toContain('BRL 1001'); // Mercado's total: 1000 + 1, not just 1
  });

  it("computes a row's percentage against its own currency's total, never a cross-currency blend", () => {
    // Viagem is 100% of USD expenses even though USD is a small slice of the month's total
    // magnitude across currencies — percentages only ever compare same-currency amounts.
    const { sandbox, documentStub } = loadComparativeSandbox();
    withMonth(sandbox);
    sandbox.allTransactions = [
      tx({ amount: 10000, currency: 'BRL', categoryId: 'cat-a', categoryName: 'Mercado' }),
      tx({ amount: 200, currency: 'USD', categoryId: 'cat-b', categoryName: 'Viagem' }),
    ];

    (sandbox.calculateAndRenderAll as () => void)();

    const html = documentStub.getElementById('expense-categories-list').innerHTML;
    const viagemSection = html.slice(html.indexOf('Viagem'));
    expect(viagemSection).toContain('100.0%');
  });
});

describe('renderComparativeCharts (ui/dashboards/comparative.html)', () => {
  it("renders only the representative currency's series, excluding every other currency", () => {
    const { sandbox } = loadComparativeSandbox();
    withMonth(sandbox);
    sandbox.allTransactions = [
      tx({ type: 'expense', amount: 1000, currency: 'BRL', categoryId: 'cat-a', categoryName: 'Mercado' }),
      tx({ type: 'expense', amount: 200, currency: 'USD', categoryId: 'cat-b', categoryName: 'Viagem' }),
    ];

    (sandbox.calculateAndRenderAll as () => void)();

    // Chart instances, in creation order: bar, income pie, expense pie.
    const expensePie = StubChart.instances[2];
    expect(expensePie?.config.data.labels).toEqual(['Mercado']);
    expect(expensePie?.config.data.labels).not.toContain('Viagem');
  });

  it('labels the bar chart tooltip and y-axis with the selected currency', () => {
    const { sandbox } = loadComparativeSandbox();
    withMonth(sandbox);
    sandbox.allTransactions = [tx({ type: 'expense', amount: 1000, currency: 'BRL' })];

    (sandbox.calculateAndRenderAll as () => void)();

    const bar = firstChart();
    const label = bar.config.options.plugins.tooltip.callbacks.label({ dataset: { label: 'Efetivado' }, raw: 1000 });
    expect(label).toBe('Efetivado: BRL 1000');
    expect(bar.config.options.scales?.y.ticks.callback(500)).toBe('BRL 500');
  });
});
