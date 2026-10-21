import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

// ui/dashboards/projections.html is a plain browser-global fragment script (no build step, no
// module system), so renderHeatMap() can't be imported directly. Loading the real file's <script>
// content into a minimal sandboxed `document`/`window` with node:vm exercises the actual deployed
// fragment instead of a re-implementation, mirroring test/unit/ui/overview-kpis.test.ts's approach.
// Covers issue #174: heat-map cells/rows/columns must be {currency: amount} maps, and the color-
// intensity (opacity) scale must compare each cell only against its own currency's max — never a
// blended cross-currency number.
const PROJECTIONS_HTML_PATH = fileURLToPath(new URL('../../../ui/dashboards/projections.html', import.meta.url));
const MONEY_JS_PATH = fileURLToPath(new URL('../../../ui/money.js', import.meta.url));

// A single stub shape covers every DOM role renderHeatMap touches: header/footer rows only ever
// get `.innerHTML` assigned directly, while body elements accumulate appended `<tr>` children's own
// `.innerHTML` — appendChild here concatenates, mimicking a real DOM closely enough to assert on
// the resulting markup.
type StubElement = {
  innerHTML: string;
  value: string;
  classList: { add: () => void; remove: () => void };
  appendChild: (child: { innerHTML: string }) => void;
  addEventListener: () => void;
  getContext: () => Record<string, unknown>;
};

const makeStubElement = (): StubElement => {
  const el: StubElement = {
    innerHTML: '',
    value: '',
    classList: { add() {}, remove() {} },
    appendChild(child) {
      el.innerHTML += child.innerHTML;
    },
    addEventListener() {},
    getContext: () => ({}),
  };
  return el;
};

// Captures every `new Chart(ctx, config)` call's config so tests can assert on the series data and
// tooltip/axis callbacks without a real canvas or rendering engine.
class StubChart {
  static instances: StubChart[] = [];
  config: {
    data: { labels: string[]; datasets: Array<{ label: string; data: number[] }> };
    options: {
      plugins: { tooltip: { callbacks: { label: (ctx: unknown) => string } } };
      scales: { y: { ticks: { callback: (value: number) => string } } };
    };
  };
  constructor(_ctx: unknown, config: StubChart['config']) {
    this.config = config;
    StubChart.instances.push(this);
  }
  destroy() {}
}

const makeStubDocument = () => {
  const elements = new Map<string, StubElement>();
  return {
    getElementById(id: string): StubElement {
      if (!elements.has(id)) elements.set(id, makeStubElement());
      return elements.get(id) as StubElement;
    },
    createElement: () => makeStubElement(),
    addEventListener() {},
  };
};

const firstChart = (): StubChart => {
  const chart = StubChart.instances[0];
  if (!chart) throw new Error('no Chart instance was created');
  return chart;
};

const extractFragmentScript = (html: string): string => {
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!match) throw new Error('projections.html: no <script> tag found');
  return match[1] ?? '';
};

// Same deterministic formatMoney stub as the other ui/ fragment tests — `${currency} ${value}`, so
// assertions don't depend on Intl locale data, while the real ui/money.js still supplies the
// DEFAULT_CURRENCY/addMultiCurrency/valueIn/primaryCurrencyOf/magnitudeOf/mergeCurrencyMaps/
// formatMultiCurrencyWith globals this fragment depends on (issue #174) instead of local copies.
const loadProjectionsSandbox = () => {
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
  (sandbox.window as Record<string, unknown>).location = { pathname: '/ui/projections', search: '' };
  (sandbox.window as Record<string, unknown>).history = { pushState() {} };

  vm.createContext(sandbox);
  vm.runInContext(readFileSync(MONEY_JS_PATH, 'utf-8'), sandbox, { filename: MONEY_JS_PATH });
  (sandbox.window as Record<string, unknown>).formatMoney = (value: number, currency: string) =>
    `${currency} ${value}`;

  const script = extractFragmentScript(readFileSync(PROJECTIONS_HTML_PATH, 'utf-8'));
  vm.runInContext(script, sandbox, { filename: PROJECTIONS_HTML_PATH });

  return { sandbox, documentStub };
};

type Tx = {
  date: string;
  type: 'income' | 'expense' | 'transfer';
  amount: number;
  currency?: string;
  categoryId: string;
  categoryName: string;
};

const tx = (overrides: Partial<Tx>): Tx => ({
  date: '2026-09-05',
  type: 'expense',
  amount: 0,
  categoryId: 'cat-1',
  categoryName: 'Category',
  ...overrides,
});

const SEPT_2026 = { month: 9, year: 2026 };
const OCT_2026 = { month: 10, year: 2026 };

describe('renderHeatMap (ui/dashboards/projections.html)', () => {
  it('keeps a cell in its own currency instead of blending it into one BRL-labeled number', () => {
    const { sandbox, documentStub } = loadProjectionsSandbox();
    sandbox.categories = [{ id: 'cat-travel', name: 'Viagem', kind: 'expense' }];
    sandbox.projectionMonths = [SEPT_2026];
    sandbox.allTransactions = [
      tx({ type: 'expense', amount: 200, currency: 'USD', categoryId: 'cat-travel', categoryName: 'Viagem' }),
    ];

    (sandbox.renderHeatMap as () => void)();

    expect(documentStub.getElementById('heatmap-expense-body').innerHTML).toContain('USD 200');
    expect(documentStub.getElementById('heatmap-expense-body').innerHTML).not.toContain('BRL 200');
  });

  it('sums a row/column across months per currency, and a mixed-currency cell shows both', () => {
    const { sandbox, documentStub } = loadProjectionsSandbox();
    sandbox.categories = [{ id: 'cat-mixed', name: 'Assinaturas', kind: 'expense' }];
    sandbox.projectionMonths = [SEPT_2026, OCT_2026];
    sandbox.allTransactions = [
      tx({ date: '2026-09-05', amount: 30, currency: 'BRL', categoryId: 'cat-mixed', categoryName: 'Assinaturas' }),
      tx({ date: '2026-09-06', amount: 4, currency: 'USD', categoryId: 'cat-mixed', categoryName: 'Assinaturas' }),
      tx({ date: '2026-10-05', amount: 30, currency: 'BRL', categoryId: 'cat-mixed', categoryName: 'Assinaturas' }),
    ];

    (sandbox.renderHeatMap as () => void)();

    const body = documentStub.getElementById('heatmap-expense-body').innerHTML;
    // September's cell mixes BRL and USD — both must appear, never collapsed into one number.
    expect(body).toContain('BRL 30 / USD 4');
    // October's cell is BRL-only.
    expect(body).toContain('BRL 30');
    // Row total across both months: BRL 60 (30+30), USD 4.
    expect(body).toContain('BRL 60 / USD 4');
  });

  it('renders empty cells for months with no activity in that category', () => {
    const { sandbox, documentStub } = loadProjectionsSandbox();
    sandbox.categories = [{ id: 'cat-rent', name: 'Aluguel', kind: 'income' }];
    sandbox.projectionMonths = [SEPT_2026, OCT_2026];
    sandbox.allTransactions = [
      tx({
        date: '2026-09-05',
        type: 'income',
        amount: 1000,
        currency: 'BRL',
        categoryId: 'cat-rent',
        categoryName: 'Aluguel',
      }),
    ];

    (sandbox.renderHeatMap as () => void)();

    const body = documentStub.getElementById('heatmap-income-body').innerHTML;
    expect(body).toContain('heatmap-empty');
    expect(body).toContain('BRL 1000');
  });

  it('excludes transfers from every row/cell/column/total', () => {
    const { sandbox, documentStub } = loadProjectionsSandbox();
    sandbox.categories = [{ id: 'cat-x', name: 'X', kind: 'expense' }];
    sandbox.projectionMonths = [SEPT_2026];
    sandbox.allTransactions = [
      tx({ type: 'transfer', amount: 999999, currency: 'BRL', categoryId: 'cat-x', categoryName: 'X' }),
    ];

    (sandbox.renderHeatMap as () => void)();

    expect(documentStub.getElementById('heatmap-expense-body').innerHTML).not.toContain('999999');
  });

  it('shows a category-less fallback total on the footer, per currency, never blended', () => {
    const { sandbox, documentStub } = loadProjectionsSandbox();
    sandbox.categories = [
      { id: 'cat-a', name: 'A', kind: 'expense' },
      { id: 'cat-b', name: 'B', kind: 'expense' },
    ];
    sandbox.projectionMonths = [SEPT_2026];
    sandbox.allTransactions = [
      tx({ amount: 100, currency: 'BRL', categoryId: 'cat-a', categoryName: 'A' }),
      tx({ amount: 5, currency: 'USD', categoryId: 'cat-b', categoryName: 'B' }),
    ];

    (sandbox.renderHeatMap as () => void)();

    const foot = documentStub.getElementById('heatmap-expense-foot').innerHTML;
    expect(foot).toContain('BRL 100 / USD 5');
  });

  it('scales a cell\'s color intensity against its OWN currency\'s max, never a cross-currency blend', () => {
    // Regression test: comparing a 0.0001 BTC cell's raw units directly against a 1000 BRL cell's
    // would always crush BTC toward the opacity floor. A lone BTC cell (nothing else to compare it
    // against in its own currency) must render at full intensity (background alpha 1, i.e. no
    // rgba(...) alpha channel at all), not the 0.12 floor.
    const { sandbox, documentStub } = loadProjectionsSandbox();
    sandbox.categories = [
      { id: 'cat-big-brl', name: 'BigBRL', kind: 'expense' },
      { id: 'cat-lone-btc', name: 'LoneBTC', kind: 'expense' },
    ];
    sandbox.projectionMonths = [SEPT_2026];
    sandbox.allTransactions = [
      tx({ amount: 50000, currency: 'BRL', categoryId: 'cat-big-brl', categoryName: 'BigBRL' }),
      tx({ amount: 0.0001, currency: 'BTC', categoryId: 'cat-lone-btc', categoryName: 'LoneBTC' }),
    ];

    (sandbox.renderHeatMap as () => void)();

    const body = documentStub.getElementById('heatmap-expense-body').innerHTML;
    const btcCellMatch = body.match(/style="background:(rgba\([^)]*\));[^"]*"[^>]*>\s*BTC 0\.0001/);
    expect(btcCellMatch).not.toBeNull();
    // A lone cell is, by definition, its own currency's max — ratio 1, full intensity. The old
    // shared-max code (comparing 0.0001 raw BTC units against a 50000 BRL max) would instead land
    // on the 0.12 opacity floor here.
    expect(btcCellMatch?.[1]).toBe('rgba(244, 63, 94, 1)');
  });
});

describe('renderProjectionLineChart (ui/dashboards/projections.html, via renderHeatMap)', () => {
  const rentTx = (overrides: Partial<Tx>): Tx =>
    tx({ categoryId: 'cat-rent', categoryName: 'Aluguel', type: 'income', ...overrides });

  it('renders only the representative currency\'s monthly totals, excluding every other currency', () => {
    const { sandbox } = loadProjectionsSandbox();
    sandbox.categories = [{ id: 'cat-rent', name: 'Aluguel', kind: 'income' }];
    sandbox.projectionMonths = [SEPT_2026, OCT_2026];
    sandbox.allTransactions = [
      rentTx({ date: '2026-09-05', amount: 1000, currency: 'BRL' }),
      rentTx({ date: '2026-09-06', amount: 50, currency: 'USD' }),
      rentTx({ date: '2026-10-05', amount: 2000, currency: 'BRL' }),
    ];

    (sandbox.renderHeatMap as () => void)();

    const chart = firstChart();
    expect(chart.config.data.datasets[0]!.label).toBe('Receitas Projetadas');
    expect(chart.config.data.datasets[0]!.data).toEqual([1000, 2000]); // BRL only — USD's 50 excluded
  });

  it('labels tooltip and y-axis values with the selected currency, not a bare number', () => {
    const { sandbox } = loadProjectionsSandbox();
    sandbox.categories = [{ id: 'cat-rent', name: 'Aluguel', kind: 'income' }];
    sandbox.projectionMonths = [SEPT_2026];
    sandbox.allTransactions = [rentTx({ amount: 1000, currency: 'BRL' })];

    (sandbox.renderHeatMap as () => void)();

    const chart = firstChart();
    const tooltipCtx = { dataset: { label: 'Receitas Projetadas' }, raw: 1000 };
    const label = chart.config.options.plugins.tooltip.callbacks.label(tooltipCtx);
    expect(label).toBe('Receitas Projetadas: BRL 1000');
    expect(chart.config.options.scales.y.ticks.callback(500)).toBe('BRL 500');
  });
});
