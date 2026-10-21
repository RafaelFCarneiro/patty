import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

// ui/dashboards/overview.html is a plain browser-global fragment script (no build step, no module
// system), so renderCategoryChart() can't be imported directly. Loading the real file's <script>
// content into a minimal sandboxed `document`/`window` with node:vm exercises the actual deployed
// fragment, mirroring test/unit/ui/overview-kpis.test.ts's approach. Covers issue #174's chart
// representative-currency selection: Chart.js can only render one numeric series, so the chart
// picks ONE real currency (never a blended/converted total) and must exclude every other currency's
// categories from that series while still labeling values with the chosen currency in tooltips.
const OVERVIEW_HTML_PATH = fileURLToPath(new URL('../../../ui/dashboards/overview.html', import.meta.url));
const MONEY_JS_PATH = fileURLToPath(new URL('../../../ui/money.js', import.meta.url));

type StubElement = {
  innerHTML: string;
  getContext: () => Record<string, unknown>;
  width: number;
  height: number;
};

const makeStubCanvas = (): StubElement => ({
  innerHTML: '',
  getContext: () => ({ clearRect() {}, fillText() {} }),
  width: 200,
  height: 200,
});

const makeStubDocument = () => {
  const elements = new Map<string, StubElement>();
  return {
    getElementById(id: string): StubElement {
      if (!elements.has(id)) elements.set(id, makeStubCanvas());
      return elements.get(id) as StubElement;
    },
  };
};

// Captures every `new Chart(ctx, config)` call's config so tests can assert on the series data and
// the tooltip-label callback without a real canvas or rendering engine.
class StubChart {
  static instances: StubChart[] = [];
  config: {
    data: { labels: string[]; datasets: Array<{ data: number[] }> };
    options: { plugins: { tooltip: { callbacks: { label: (ctx: unknown) => string } } } };
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
  if (!match) throw new Error('overview.html: no <script> tag found');
  return match[1] ?? '';
};

const loadOverviewSandbox = () => {
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
  (sandbox.window as Record<string, unknown>).location = { pathname: '/ui/overview', search: '' };
  (sandbox.window as Record<string, unknown>).history = { pushState() {} };

  vm.createContext(sandbox);
  vm.runInContext(readFileSync(MONEY_JS_PATH, 'utf-8'), sandbox, { filename: MONEY_JS_PATH });
  (sandbox.window as Record<string, unknown>).formatMoney = (value: number, currency: string) =>
    `${currency} ${value}`;

  const script = extractFragmentScript(readFileSync(OVERVIEW_HTML_PATH, 'utf-8'));
  vm.runInContext(script, sandbox, { filename: OVERVIEW_HTML_PATH });

  return { sandbox };
};

type Tx = { type: 'income' | 'expense' | 'transfer'; amount: number; currency?: string; categoryName?: string };
const tx = (overrides: Partial<Tx>): Tx => ({ type: 'expense', amount: 0, ...overrides });

describe('renderCategoryChart (ui/dashboards/overview.html)', () => {
  it('renders only the representative currency\'s categories, excluding every other currency', () => {
    const { sandbox } = loadOverviewSandbox();
    sandbox.allTransactions = [
      tx({ amount: 1000, currency: 'BRL', categoryName: 'Mercado' }),
      tx({ amount: 500, currency: 'BRL', categoryName: 'Transporte' }),
      tx({ amount: 200, currency: 'USD', categoryName: 'Viagem' }),
    ];

    (sandbox.renderCategoryChart as () => void)();

    const chart = firstChart();
    expect(chart.config.data.labels).toEqual(['Mercado', 'Transporte']);
    expect(chart.config.data.labels).not.toContain('Viagem');
    expect(chart.config.data.datasets[0]!.data).toEqual([1000, 500]);
  });

  it('labels tooltip values with the selected currency, not a bare number', () => {
    const { sandbox } = loadOverviewSandbox();
    sandbox.allTransactions = [tx({ amount: 200, currency: 'USD', categoryName: 'Viagem' })];

    (sandbox.renderCategoryChart as () => void)();

    const chart = firstChart();
    const label = chart.config.options.plugins.tooltip.callbacks.label({ label: 'Viagem', raw: 200 });
    expect(label).toBe('Viagem: USD 200');
  });

  it('excludes transfers from the category chart entirely', () => {
    const { sandbox } = loadOverviewSandbox();
    sandbox.allTransactions = [
      tx({ amount: 1000, currency: 'BRL', categoryName: 'Mercado' }),
      tx({ type: 'transfer', amount: 999999, currency: 'BRL', categoryName: 'Mercado' }),
    ];

    (sandbox.renderCategoryChart as () => void)();

    const chart = firstChart();
    expect(chart.config.data.datasets[0]!.data).toEqual([1000]);
  });
});
