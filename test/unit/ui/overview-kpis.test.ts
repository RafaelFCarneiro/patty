import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

// ui/dashboards/overview.html is a plain browser-global fragment script (no build step, no module
// system), so renderKPIs() can't be imported directly. Loading the real file's <script> content
// into a minimal sandboxed `document`/`window` with node:vm exercises the actual deployed fragment
// instead of a re-implementation, mirroring test/unit/ui/overview-net-worth.test.ts's approach.
// Covers issue #174: every KPI accumulator must be a {currency: amount} map, never a single
// blended-and-mislabeled total.
const OVERVIEW_HTML_PATH = fileURLToPath(new URL('../../../ui/dashboards/overview.html', import.meta.url));
const MONEY_JS_PATH = fileURLToPath(new URL('../../../ui/money.js', import.meta.url));

type StubElement = {
  innerHTML: string;
  textContent: string;
  style: { display: string; color: string };
};

const makeStubElement = (): StubElement => ({
  innerHTML: '',
  textContent: '',
  style: { display: '', color: '' },
});

const makeStubDocument = () => {
  const elements = new Map<string, StubElement>();
  return {
    getElementById(id: string): StubElement {
      if (!elements.has(id)) elements.set(id, makeStubElement());
      return elements.get(id) as StubElement;
    },
  };
};

const extractFragmentScript = (html: string): string => {
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!match) throw new Error('overview.html: no <script> tag found');
  return match[1] ?? '';
};

// Same deterministic formatMoney stub as overview-net-worth.test.ts — `${currency} ${value}`, so
// assertions below don't depend on Intl locale data, while the real ui/money.js still supplies the
// DEFAULT_CURRENCY/addMultiCurrency/valueIn/primaryCurrencyOf/magnitudeOf/mergeCurrencyMaps globals
// overview.html now depends on (issue #174) instead of defining local copies.
const loadOverviewSandbox = () => {
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

  vm.createContext(sandbox);
  vm.runInContext(readFileSync(MONEY_JS_PATH, 'utf-8'), sandbox, { filename: MONEY_JS_PATH });
  (sandbox.window as Record<string, unknown>).formatMoney = (value: number, currency: string) =>
    `${currency} ${value}`;

  const script = extractFragmentScript(readFileSync(OVERVIEW_HTML_PATH, 'utf-8'));
  vm.runInContext(script, sandbox, { filename: OVERVIEW_HTML_PATH });

  return { sandbox, documentStub };
};

type Tx = {
  type: 'income' | 'expense' | 'transfer';
  status: 'effective' | 'pending';
  amount: number;
  currency?: string;
};

const tx = (overrides: Partial<Tx>): Tx => ({ type: 'expense', status: 'effective', amount: 0, ...overrides });

describe('renderKPIs (ui/dashboards/overview.html)', () => {
  it('keeps each currency in its own bucket instead of blending them into one BRL-labeled total', () => {
    const { sandbox, documentStub } = loadOverviewSandbox();
    sandbox.allTransactions = [
      tx({ type: 'income', amount: 1000, currency: 'BRL' }),
      tx({ type: 'income', amount: 50, currency: 'USD' }),
      tx({ type: 'expense', amount: 0.0015, currency: 'BTC' }),
    ];
    sandbox.creditCards = [];
    (sandbox.renderKPIs as (cardBills: unknown[]) => void)([]);

    expect(documentStub.getElementById('kpi-income-val').textContent).toBe('BRL 1000 / USD 50');
    expect(documentStub.getElementById('kpi-expense-val').textContent).toBe('BTC 0.0015');
  });

  it('defaults a transaction with no currency field to DEFAULT_CURRENCY rather than dropping it', () => {
    const { sandbox, documentStub } = loadOverviewSandbox();
    const { DEFAULT_CURRENCY } = sandbox as unknown as { DEFAULT_CURRENCY: string };
    sandbox.allTransactions = [tx({ type: 'income', amount: 200 })];
    sandbox.creditCards = [];
    (sandbox.renderKPIs as (cardBills: unknown[]) => void)([]);

    expect(documentStub.getElementById('kpi-income-val').textContent).toBe(`${DEFAULT_CURRENCY} 200`);
  });

  it('splits effective vs. pending per currency, not just for the primary one', () => {
    const { sandbox, documentStub } = loadOverviewSandbox();
    sandbox.allTransactions = [
      tx({ type: 'expense', status: 'effective', amount: 100, currency: 'BRL' }),
      tx({ type: 'expense', status: 'pending', amount: 10, currency: 'BRL' }),
      tx({ type: 'expense', status: 'effective', amount: 20, currency: 'USD' }),
      tx({ type: 'expense', status: 'pending', amount: 5, currency: 'USD' }),
    ];
    sandbox.creditCards = [];
    (sandbox.renderKPIs as (cardBills: unknown[]) => void)([]);

    expect(documentStub.getElementById('kpi-expense-eff').textContent).toBe('BRL 100 / USD 20');
    expect(documentStub.getElementById('kpi-expense-pend').textContent).toBe('BRL 10 / USD 5');
  });

  it('excludes transfers from every KPI bucket', () => {
    const { sandbox, documentStub } = loadOverviewSandbox();
    sandbox.allTransactions = [
      tx({ type: 'income', amount: 100, currency: 'BRL' }),
      tx({ type: 'transfer', amount: 999999, currency: 'BRL' }),
    ];
    sandbox.creditCards = [];
    (sandbox.renderKPIs as (cardBills: unknown[]) => void)([]);

    expect(documentStub.getElementById('kpi-income-val').textContent).toBe('BRL 100');
  });

  it('colors the balance KPI from its own primary currency, never a cross-currency blend', () => {
    // BRL is negative (expense-heavy) while USD is positive — primaryCurrencyOf must pick BRL
    // (present, so preferred over alphabetical) and color from BRL's own sign, not some blended
    // cross-currency number that ADR-026 explicitly forbids computing.
    const { sandbox, documentStub } = loadOverviewSandbox();
    sandbox.allTransactions = [
      tx({ type: 'expense', amount: 500, currency: 'BRL' }),
      tx({ type: 'income', amount: 1000, currency: 'USD' }),
    ];
    sandbox.creditCards = [];
    (sandbox.renderKPIs as (cardBills: unknown[]) => void)([]);

    const balanceEl = documentStub.getElementById('kpi-balance-val');
    expect(balanceEl.textContent).toBe('BRL -500 / USD 1000');
    expect(balanceEl.style.color).toBe('var(--expense-color)');
  });

  it('renders the DEFAULT_CURRENCY zero fallback for an empty month, the empty/fallback case', () => {
    const { sandbox, documentStub } = loadOverviewSandbox();
    const { DEFAULT_CURRENCY } = sandbox as unknown as { DEFAULT_CURRENCY: string };
    sandbox.allTransactions = [];
    sandbox.creditCards = [];
    (sandbox.renderKPIs as (cardBills: unknown[]) => void)([]);

    expect(documentStub.getElementById('kpi-income-val').textContent).toBe(`${DEFAULT_CURRENCY} 0`);
    expect(documentStub.getElementById('kpi-expense-val').textContent).toBe(`${DEFAULT_CURRENCY} 0`);
    expect(documentStub.getElementById('kpi-balance-val').textContent).toBe(`${DEFAULT_CURRENCY} 0`);
    expect(documentStub.getElementById('kpi-cards-val').textContent).toBe(`${DEFAULT_CURRENCY} 0`);
  });

  it("sums each card's open bill in that card's own (fixed-at-creation) currency", () => {
    const { sandbox, documentStub } = loadOverviewSandbox();
    sandbox.allTransactions = [];
    sandbox.creditCards = [
      { name: 'Nubank Ultravioleta', currency: 'BRL' },
      { name: 'Global Card', currency: 'USD' },
    ];
    const cardBills = [
      { cardName: 'Nubank Ultravioleta', data: { total: 300 } },
      { cardName: 'Global Card', data: { total: 40 } },
    ];
    (sandbox.renderKPIs as (cardBills: unknown[]) => void)(cardBills);

    expect(documentStub.getElementById('kpi-cards-val').textContent).toBe('BRL 300 / USD 40');
  });

  it('falls back to DEFAULT_CURRENCY for a bill whose card lookup finds no match', () => {
    const { sandbox, documentStub } = loadOverviewSandbox();
    const { DEFAULT_CURRENCY } = sandbox as unknown as { DEFAULT_CURRENCY: string };
    sandbox.allTransactions = [];
    sandbox.creditCards = []; // no card named 'Ghost Card' — the find() below returns undefined
    const cardBills = [{ cardName: 'Ghost Card', data: { total: 75 } }];
    (sandbox.renderKPIs as (cardBills: unknown[]) => void)(cardBills);

    expect(documentStub.getElementById('kpi-cards-val').textContent).toBe(`${DEFAULT_CURRENCY} 75`);
  });
});
