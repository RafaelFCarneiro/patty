import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

// ui/dashboards/overview.html is a plain browser-global fragment script (no build step, no module
// system), so renderCalendar() can't be imported directly. Loading the real file's <script> content
// into a minimal sandboxed `document`/`window` with node:vm exercises the actual deployed fragment,
// mirroring test/unit/ui/overview-kpis.test.ts's approach. Covers issue #174's calendar-day fix:
// income/expense/transfer must resolve their OWN primary currency independently, so a same-day mix
// of currencies never silently hides a real flow.
const OVERVIEW_HTML_PATH = fileURLToPath(new URL('../../../ui/dashboards/overview.html', import.meta.url));
const MONEY_JS_PATH = fileURLToPath(new URL('../../../ui/money.js', import.meta.url));

type StubElement = {
  innerHTML: string;
  textContent: string;
  style: { display: string; color: string };
  classList: { add: () => void; remove: () => void; toggle: () => void; contains: () => boolean };
  children: StubElement[];
  appendChild: (child: StubElement) => void;
  addEventListener: () => void;
  querySelector: () => StubElement | null;
};

const makeStubElement = (): StubElement => {
  const children: StubElement[] = [];
  const el: StubElement = {
    innerHTML: '',
    textContent: '',
    style: { display: '', color: '' },
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    children,
    appendChild(child) {
      children.push(child);
      el.innerHTML += child.innerHTML;
    },
    addEventListener() {},
    querySelector: () => null,
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
    querySelectorAll: () => [] as StubElement[],
    addEventListener() {},
  };
};

const extractFragmentScript = (html: string): string => {
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!match) throw new Error('overview.html: no <script> tag found');
  return match[1] ?? '';
};

// Same deterministic formatMoney stub as the other ui/ fragment tests.
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
  // formatCurrencyNoSymbol (the calendar cell's own formatter) reads currency metadata directly
  // off window.__appCurrencies rather than through formatMoney — BTC's real 8 decimals here
  // is what lets the tests below tell "this flow correctly resolved to BTC" apart from "it fell
  // back to some other currency's 2-decimal formatting".
  (sandbox.window as Record<string, unknown>).__appCurrencies = {
    BTC: { code: 'BTC', symbol: '₿', name: 'Bitcoin', decimals: 8 },
  };

  const script = extractFragmentScript(readFileSync(OVERVIEW_HTML_PATH, 'utf-8'));
  vm.runInContext(script, sandbox, { filename: OVERVIEW_HTML_PATH });

  return { sandbox, documentStub };
};

type Tx = { date: string; type: 'income' | 'expense' | 'transfer'; amount: number; currency?: string };
const tx = (overrides: Partial<Tx>): Tx => ({ date: '2026-09-05', type: 'expense', amount: 0, ...overrides });

// renderCalendar builds one <div> per day of the month and appends each to the 'calendar-days'
// container in order, day 1 first — so the Nth real (non-empty-placeholder) child is day N.
const findDayCellHtml = (documentStub: ReturnType<typeof makeStubDocument>, day: number): string => {
  const container = documentStub.getElementById('calendar-days');
  const cell = container.children.find((c) => c.innerHTML.includes(`>${day}<`));
  if (!cell) throw new Error(`day ${day} cell not found among ${container.children.length} children`);
  return cell.innerHTML;
};

describe('renderCalendar (ui/dashboards/overview.html)', () => {
  it('shows income, expense, and transfer independently even when each is a different currency', () => {
    // Regression test: the calendar day cell used to pick ONE shared currency for the whole day
    // (income+expense+transfer combined) — since BRL always wins that pick when present, the USD
    // income here would have been read back as valueIn(dayIncomeByCurrency, 'BRL') = 0 and hidden,
    // and the BTC transfer's `if (dayTransfer > 0)` check would have failed the same way, dropping
    // the transfer indicator entirely. formatCurrencyNoSymbol never prints a currency code, so the
    // discriminator is presence/value, not text: the transfer must show BTC's own 8 decimals
    // (0.00100000), which only happens if it actually resolved to BTC rather than falling back to
    // whichever currency a shared pick would have chosen.
    const { sandbox, documentStub } = loadOverviewSandbox();
    sandbox.selectedMonth = 9;
    sandbox.selectedYear = 2026;
    sandbox.allTransactions = [
      tx({ type: 'income', amount: 50, currency: 'USD' }),
      tx({ type: 'expense', amount: 1000, currency: 'BRL' }),
      tx({ type: 'transfer', amount: 0.001, currency: 'BTC' }),
    ];

    (sandbox.renderCalendar as () => void)();

    const cellHtml = findDayCellHtml(documentStub, 5);
    expect(cellHtml).toContain('+50.00'); // income (USD) — not zeroed out by a BRL-shared pick
    expect(cellHtml).toContain('-1,000.00'); // expense (BRL)
    expect(cellHtml).toContain('⇄ 0.00100000'); // transfer (BTC), 8 decimals — proves it is BTC
    // None of the three flows should have fallen back to the hidden-placeholder slot.
    expect(cellHtml).not.toContain('visibility: hidden');
  });

  it('still hides a flow type with no activity at all that day (not every flow forced visible)', () => {
    const { sandbox, documentStub } = loadOverviewSandbox();
    sandbox.selectedMonth = 9;
    sandbox.selectedYear = 2026;
    sandbox.allTransactions = [tx({ type: 'income', amount: 100, currency: 'BRL' })];

    (sandbox.renderCalendar as () => void)();

    const cellHtml = findDayCellHtml(documentStub, 5);
    expect(cellHtml).toContain('+100.00');
    expect(cellHtml).toContain('visibility: hidden'); // the expense slot, with no activity that day
  });

  it('renders a day with no activity at all with no flow markup', () => {
    const { sandbox, documentStub } = loadOverviewSandbox();
    sandbox.selectedMonth = 9;
    sandbox.selectedYear = 2026;
    sandbox.allTransactions = [];

    (sandbox.renderCalendar as () => void)();

    const cellHtml = findDayCellHtml(documentStub, 5);
    // '"day-flow ' (with the trailing space) matches an actual flow item's class
    // (day-flow inflow/outflow/transflow) without also matching the day-flows CONTAINER div,
    // which is always present regardless of whether it holds any flow items.
    expect(cellHtml).not.toContain('"day-flow ');
  });
});
